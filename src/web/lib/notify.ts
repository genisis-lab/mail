/**
 * New-mail awareness while Wren is open: the unread count in the tab title
 * and app icon, and a desktop notification when mail arrives in a background
 * tab (unless this device already gets Web Push for that account, which
 * notifies on its own). With several accounts signed in on this browser, a
 * tab also tells about new mail for the others.
 */
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { api, apiFor } from './api';
import { openAccount, type BrowserAccount } from './accounts';
import { pushStatus } from './pwa';

/**
 * The tab title (with the account's address when several are signed in here,
 * so their tabs can be told apart) and the app icon's count (`badge`: the unread
 * mail of every account here, when there are several).
 */
export function useUnreadTitle(label: string, unread: number | undefined, instance: string, account?: string, badge?: number) {
  useEffect(() => {
    const n = unread ?? 0;
    const name = account ? `${account} · ${instance}` : instance;
    document.title = n ? `${label} (${n > 9999 ? '9999+' : n}) · ${name}` : `${label} · ${name}`;
  }, [label, unread, instance, account]);
  useEffect(() => {
    const n = badge ?? unread ?? 0;
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (n) nav.setAppBadge?.(n).catch(() => {});
    else nav.clearAppBadge?.().catch(() => {});
  }, [unread, badge]);
  useEffect(() => () => void (document.title = instance), [instance]);
}

/** Whether this device gets pushes for the account (null: this tab's), which then notify on their own. */
async function hasPush(account: number | null): Promise<boolean> {
  try {
    return (await pushStatus(account ?? undefined)).subscribed;
  } catch {
    return false;
  }
}

interface Recent {
  latestId: number;
  messages: {
    id: number;
    threadId: number;
    from: { address: string; name: string };
    subject: string;
    snippet: string;
    /** Shipping mail: where its package is now. */
    parcel?: { status: string; merchant: string | null; item: string | null } | null;
  }[];
}

const PACKAGE_TITLES: Record<string, string> = {
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  delayed: 'Package delayed',
  ready_for_pickup: 'Ready for pickup',
  shipped: 'Shipped',
  in_transit: 'On the way',
  cancelled: 'Order cancelled',
  returned: 'Returned',
};

/** A desktop notification for the newest of these messages; `account`: the address it's for, when several are signed in here. */
function showNotification(messages: Recent['messages'], tag: string, onOpen: (threadId: number) => void, account?: string) {
  const m = messages[0];
  const more = messages.length > 1 ? ` (+${messages.length - 1} more)` : '';
  const to = account ? `\n${account}` : '';
  // Shipping mail leads with where the package is ("Out for delivery · Amazon").
  const pkg = m.parcel ? PACKAGE_TITLES[m.parcel.status] : undefined;
  const title = pkg ? `${pkg}${m.parcel!.merchant ? ` · ${m.parcel!.merchant}` : ''}` : m.from.name || m.from.address;
  const body = pkg ? `${m.parcel!.item || m.subject || m.from.name || m.from.address}${more}${to}` : `${m.subject || '(no subject)'}${more}\n${m.snippet ?? ''}`.trim() + to;
  const n = new Notification(title, { body, tag, icon: '/icons/icon-192.png' });
  n.onclick = () => {
    window.focus();
    onOpen(m.threadId);
    n.close();
  };
}

/** Poll for new inbox mail and notify while the tab is in the background. */
export function useNewMailNotifications(enabled: boolean, account: number, mailbox: number | null, address?: string) {
  const navigate = useNavigate();
  const latest = useRef(0);
  useEffect(() => {
    latest.current = 0;
    if (!enabled || typeof Notification === 'undefined') return;
    let stopped = false;
    const tick = async () => {
      try {
        const r = await api.get<Recent>(`/api/mail/recent${latest.current ? `?after=${latest.current}` : ''}`);
        const first = latest.current === 0;
        latest.current = Math.max(latest.current, r.latestId);
        if (first || stopped || !r.messages.length || !document.hidden || Notification.permission !== 'granted') return;
        if (await hasPush(null)) return; // the service worker shows it
        // Tagged per account, so a tab of another account telling about this one shows the same notification.
        showNotification(r.messages, `wren-${account}-${mailbox ?? 'me'}`, (threadId) => navigate(`/inbox/${threadId}`), address);
      } catch {
        /* offline; try again next time */
      }
    };
    void tick();
    const t = setInterval(() => void tick(), 30_000);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [enabled, account, mailbox, address, navigate]);
}

/**
 * New mail for the other accounts signed in on this browser (from the account
 * list the switcher keeps current), told the same way while the tab is in the
 * background. Opening the notification switches to that account.
 */
export function useOtherAccountNotifications(accounts: BrowserAccount[] | undefined, self: number) {
  const seen = useRef(new Map<number, number>());
  useEffect(() => {
    if (!accounts || typeof Notification === 'undefined') return;
    for (const a of accounts) {
      if (a.id === self) continue;
      const before = seen.current.get(a.id);
      seen.current.set(a.id, Math.max(before ?? 0, a.latestId));
      if (before === undefined || a.latestId <= before || !a.notify || !document.hidden || Notification.permission !== 'granted') continue;
      void (async () => {
        if (await hasPush(a.id)) return;
        const r = await apiFor(null, a.id).get<Recent>(`/api/mail/recent?after=${before}`);
        if (r.messages.length) showNotification(r.messages, `wren-${a.id}-me`, (threadId) => openAccount(a, `/inbox/${threadId}`), a.email);
      })().catch(() => {});
    }
  }, [accounts, self]);
}

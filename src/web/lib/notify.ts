/**
 * New-mail awareness while Wren is open: the unread count in the tab title
 * and app icon, and a desktop notification when mail arrives in a background
 * tab (unless this device already gets Web Push, which notifies on its own).
 */
import { useEffect, useRef } from 'react';
import { useNavigate } from 'react-router';
import { api } from './api';

export function useUnreadTitle(label: string, unread: number | undefined, instance: string) {
  useEffect(() => {
    const n = unread ?? 0;
    document.title = n ? `${label} (${n > 9999 ? '9999+' : n}) · ${instance}` : `${label} · ${instance}`;
    const nav = navigator as Navigator & { setAppBadge?: (n?: number) => Promise<void>; clearAppBadge?: () => Promise<void> };
    if (n) nav.setAppBadge?.(n).catch(() => {});
    else nav.clearAppBadge?.().catch(() => {});
  }, [label, unread, instance]);
  useEffect(() => () => void (document.title = instance), [instance]);
}

async function hasPush(): Promise<boolean> {
  try {
    if (!('serviceWorker' in navigator)) return false;
    const reg = await navigator.serviceWorker.getRegistration();
    return !!(await reg?.pushManager?.getSubscription());
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

/** Poll for new inbox mail and notify while the tab is in the background. */
export function useNewMailNotifications(enabled: boolean, mailbox: number | null) {
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
        if (await hasPush()) return; // the service worker shows it
        const m = r.messages[0];
        const more = r.messages.length > 1 ? ` (+${r.messages.length - 1} more)` : '';
        // Shipping mail leads with where the package is ("Out for delivery · Amazon").
        const pkg = m.parcel ? PACKAGE_TITLES[m.parcel.status] : undefined;
        const title = pkg ? `${pkg}${m.parcel!.merchant ? ` · ${m.parcel!.merchant}` : ''}` : m.from.name || m.from.address;
        const body = pkg ? `${m.parcel!.item || m.subject || m.from.name || m.from.address}${more}` : `${m.subject || '(no subject)'}${more}\n${m.snippet ?? ''}`.trim();
        const n = new Notification(title, { body, tag: `wren-${mailbox ?? 'me'}`, icon: '/icons/icon-192.png' });
        n.onclick = () => {
          window.focus();
          navigate(`/inbox/${m.threadId}`);
          n.close();
        };
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
  }, [enabled, mailbox, navigate]);
}

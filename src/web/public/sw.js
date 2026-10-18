/*
 * Wren's service worker.
 *
 * - Keeps the app shell (the page and its hashed assets) so Wren opens even
 *   when the network is down.
 * - Keeps a copy of the mail you recently looked at (the lists, the
 *   conversations you opened, counters and labels) so it can be read offline,
 *   one copy per account signed in on this browser. It's always fetched fresh
 *   when online; the copy is only used when the network fails. Signing out of
 *   an account deletes its copy. Attachments, original sources, settings and
 *   admin pages are never kept.
 * - Shows new-mail notifications. A push only says which accounts have new
 *   mail: this then asks Wren what's new over each account's session, so
 *   nothing about your mail passes through the browser's push service.
 */
const SHELL = 'wren-shell-v1';
/** One offline copy per account: MAIL + the account's id ("default": which account /inbox showed last). */
const MAIL = 'wren-mail-v2:';
/** API reads kept for offline use. */
const OFFLINE_API = /^\/api\/(auth\/me|mail\/threads(\/\d+)?|mail\/counters|labels|me\/saved-searches)$/;
/** At most this many opened conversations are kept per account. */
const MAX_THREADS = 150;
const ICON = '/icons/icon-192.png';
const BADGE = '/icons/badge-96.png';

/** The account a request is for (the app names it on every request), or null. */
function accountOf(req, url) {
  const raw = req.headers.get('x-wren-account') || url.searchParams.get('account') || '';
  return /^[1-9]\d{0,14}$/.test(raw) ? raw : null;
}

/** Forget every account's offline copy. */
async function dropMail() {
  for (const key of await caches.keys()) if (key.startsWith(MAIL)) await caches.delete(key);
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL)
      .then((cache) => cache.addAll(['/', '/icons/icon-192.png']))
      .catch(() => {}),
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && !k.startsWith(MAIL)).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Signing out of an account forgets its offline copy (of every account, signing out of all).
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const account = accountOf(req, url);
    event.waitUntil(url.searchParams.get('all') === '1' || !account ? dropMail() : caches.delete(MAIL + account));
    return;
  }
  if (req.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) {
    const account = accountOf(req, url);
    // The accounts still signed in here: forget the copies of the others (signed out on another device, expired).
    if (url.pathname === '/api/auth/accounts') {
      event.respondWith(
        fetch(req).then((res) => {
          if (res.ok) event.waitUntil(keepAccounts(res.clone()).catch(() => {}));
          return res;
        }),
      );
      return;
    }
    // Shared mailboxes aren't kept offline. A request names its account, except a tab's first look at /api/auth/me.
    if (OFFLINE_API.test(url.pathname) && !req.headers.get('x-wren-mailbox') && !url.searchParams.has('mailbox') && (account || url.pathname === '/api/auth/me')) {
      event.respondWith(mailRead(req, url, account));
    }
    return;
  }

  // Pages: network first, falling back to the cached shell when offline.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          if (res.ok && (res.headers.get('content-type') || '').includes('text/html')) {
            event.waitUntil(keepShell(res.clone()));
          }
          return res;
        })
        .catch(() => caches.match('/').then((hit) => hit || Response.error())),
    );
    return;
  }

  // Hashed build assets and icons never change: cache first.
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/icons/')) {
    event.respondWith(
      caches.match(req).then(
        (hit) =>
          hit ||
          fetch(req).then((res) => {
            if (res.ok) {
              const copy = res.clone();
              caches.open(SHELL).then((c) => c.put(req, copy));
            }
            return res;
          }),
      ),
    );
  }
});

/** Store the latest page and drop build assets it no longer uses (each deploy has new file names). */
async function keepShell(response) {
  const html = await response.clone().text();
  const cache = await caches.open(SHELL);
  // Keep the original CSP and other security headers on offline navigations.
  await cache.put('/', response);
  const used = new Set(Array.from(html.matchAll(/\/assets\/[^"'\s)>]+/g), (m) => m[0]));
  for (const key of await cache.keys()) {
    const path = new URL(key.url).pathname;
    if (path.startsWith('/assets/') && !used.has(path)) await cache.delete(key);
  }
}

/** Opening a conversation marks it read; the offline copy is the same either way. */
function mailKey(url) {
  const u = new URL(url.href);
  u.searchParams.delete('markRead');
  u.searchParams.delete('account');
  return u.pathname + u.search;
}

/** Fresh from the network when online; the account's saved copy only when the network fails. */
async function mailRead(req, url, account) {
  const key = mailKey(url);
  try {
    const res = await fetch(req);
    if (res.ok) await keepMail(account, key, url, res.clone()).catch(() => {});
    return res;
  } catch {
    // A tab opened at /inbox shows the account it showed last.
    const id = account || (await defaultAccount());
    const hit = id ? await caches.open(MAIL + id).then((cache) => cache.match(key)) : undefined;
    if (hit) return hit;
    return new Response(JSON.stringify({ error: 'You’re offline, and this isn’t saved on this device yet.', code: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
}

async function defaultAccount() {
  const hit = await caches.open(MAIL + 'default').then((cache) => cache.match('/account'));
  return hit ? (await hit.text()).trim() || null : null;
}

async function keepMail(account, key, url, res) {
  if (url.pathname === '/api/auth/me') {
    const me = await res.clone().json();
    if (!me || !me.user) {
      // Signed out: nothing of the account stays (asked without one: nobody is signed in here).
      if (account) await caches.delete(MAIL + account);
      else await dropMail();
      return;
    }
    if (!account) {
      account = String(me.user.id);
      await caches.open(MAIL + 'default').then((cache) => cache.put('/account', new Response(account)));
    }
  }
  if (!account) return;
  const store = await caches.open(MAIL + account);
  await store.delete(key);
  await store.put(key, res);
  if (/^\/api\/mail\/threads\/\d+$/.test(url.pathname)) {
    const threads = (await store.keys()).filter((k) => /\/api\/mail\/threads\/\d+/.test(new URL(k.url).pathname));
    for (const old of threads.slice(0, Math.max(0, threads.length - MAX_THREADS))) await store.delete(old);
  }
}

/** Drop the offline copies of accounts no longer signed in here. */
async function keepAccounts(res) {
  const { accounts } = await res.json();
  if (!Array.isArray(accounts)) return;
  const here = new Set(accounts.map((a) => String(a.id)));
  for (const key of await caches.keys()) {
    const id = key.startsWith(MAIL) ? key.slice(MAIL.length) : null;
    if (id && id !== 'default' && !here.has(id)) await caches.delete(key);
  }
  if (!accounts.length) await dropMail();
}

/** Shipping mail leads with where the package is ("Out for delivery · Amazon"). */
const PACKAGE_TITLES = {
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  delayed: 'Package delayed',
  ready_for_pickup: 'Ready for pickup',
  shipped: 'Shipped',
  in_transit: 'On the way',
  cancelled: 'Order cancelled',
  returned: 'Returned',
};

/** What's new for one account signed in here (null: the first one, for a push that names none). */
async function describeNewMail(account) {
  try {
    const headers = { 'X-Wren': '1' };
    if (account) headers['X-Wren-Account'] = String(account);
    const res = await fetch('/api/me/notifications', { credentials: 'same-origin', headers });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** The accounts a push says have new mail (a push from before several accounts names none). */
function pushedAccounts(event) {
  try {
    const data = event.data && event.data.json();
    return data && Array.isArray(data.accounts) ? data.accounts.filter((id) => Number.isSafeInteger(id) && id > 0).slice(0, 10) : [];
  } catch {
    return [];
  }
}

/** The app icon's count; with several accounts here, their unread mail added up. */
async function updateBadge(found) {
  if (!self.navigator.setAppBadge || !found.length) return;
  let count = found[0].total || 0;
  if (found[0].accounts > 1) {
    const res = await fetch('/api/auth/accounts', { credentials: 'same-origin', headers: { 'X-Wren': '1' } }).catch(() => null);
    const list = res && res.ok ? await res.json().catch(() => null) : null;
    if (list && Array.isArray(list.accounts)) count = list.accounts.reduce((n, a) => n + (a.unread || 0), 0);
  }
  await self.navigator.setAppBadge(count).catch(() => {});
}

/** One account's newest unread mail; with several accounts here, it also says which one it's for. */
function showNewMail(data) {
  const top = data.items[0];
  const who = (i) => i.from.name || i.from.address;
  const account = data.account || null;
  const path = (account && account.path) || '';
  const forAccount = account && data.accounts > 1 ? `\n${account.address}` : '';
  const open = (i) => (i.mailbox ? `${path}/inbox` : `${path}/inbox/${i.threadId}`);
  const show = (title, body, url) =>
    self.registration.showNotification(title, {
      body: body + forAccount,
      // Each account's notification replaces its own last one, not another account's.
      tag: account ? `wren-mail-${account.id}` : 'wren-mail',
      renotify: true,
      icon: ICON,
      badge: BADGE,
      data: { url },
    });
  // A sign-in code: put it where it can be read at a glance.
  if (top.code) return show(`${top.code} · ${who(top)}`, `${top.subject || 'Sign-in code'}\nTap to open; the code can be copied from the message.`, open(top));
  const pkg = top.parcel && PACKAGE_TITLES[top.parcel.status];
  if (pkg) {
    const more = data.total > 1 ? `\n+${data.total - 1} more new message${data.total > 2 ? 's' : ''}` : '';
    return show(`${pkg}${top.parcel.merchant ? ` · ${top.parcel.merchant}` : ''}`, `${top.parcel.item || top.subject || who(top)}${more}`, open(top));
  }
  const title = data.total > 1 ? `${data.total} new messages` : who(top);
  const body =
    data.total > 1
      ? data.items
          .slice(0, 4)
          .map((i) => `${who(i)}: ${i.subject || '(no subject)'}`)
          .join('\n')
      : `${top.mailbox ? `${top.mailbox.address} · ` : ''}${top.subject || '(no subject)'}`;
  return show(title, body, data.total === 1 ? open(top) : `${path}/inbox`);
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      const accounts = pushedAccounts(event);
      const found = (await Promise.all(accounts.length ? accounts.map(describeNewMail) : [describeNewMail(null)])).filter(Boolean);
      await updateBadge(found).catch(() => {});
      const fresh = found.filter((d) => d.total && d.items && d.items.length);
      if (!fresh.length) {
        // Signed out on this device, or already read elsewhere: keep it generic.
        return self.registration.showNotification('New mail', { body: 'Open Wren to read it.', tag: 'wren-mail', icon: ICON, badge: BADGE });
      }
      await Promise.all(fresh.map(showNewMail));
    })(),
  );
});

/** Pages of an account added after the first (/u/<id>/…); the first account's have no prefix. */
const ACCOUNT_PREFIX = /^\/u\/[1-9]\d*(?=\/|$)/;

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/inbox';
  const prefixOf = (path) => {
    const m = ACCOUNT_PREFIX.exec(path);
    return m ? m[0] : '';
  };
  const account = prefixOf(url);
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const ours = windows.filter((w) => new URL(w.url).origin === self.location.origin && 'focus' in w);
      // A tab of the account the mail is for, else any of Wren's.
      const w = ours.find((x) => prefixOf(new URL(x.url).pathname) === account) || ours[0];
      if (w) {
        if ('navigate' in w) w.navigate(url).catch(() => {});
        return w.focus();
      }
      return self.clients.openWindow(url);
    }),
  );
});

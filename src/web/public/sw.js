/*
 * Wren's service worker.
 *
 * - Keeps the app shell (the page and its hashed assets) so Wren opens even
 *   when the network is down.
 * - Keeps a copy of the mail you recently looked at (the lists, the
 *   conversations you opened, counters and labels) so it can be read offline.
 *   It's always fetched fresh when online; the copy is only used when the
 *   network fails. Signing out, or someone else signing in, deletes it.
 *   Attachments, original sources, settings and admin pages are never kept.
 * - Shows new-mail notifications. Pushes carry no data: on a push, this asks
 *   Wren what's new over the signed-in session, so nothing about your mail
 *   passes through the browser's push service.
 */
const SHELL = 'wren-shell-v1';
const MAIL = 'wren-mail-v1';
/** API reads kept for offline use. */
const OFFLINE_API = /^\/api\/(auth\/me|mail\/threads(\/\d+)?|mail\/counters|labels|me\/saved-searches)$/;
/** At most this many opened conversations are kept. */
const MAX_THREADS = 150;
const ICON = '/icons/icon-192.png';
const BADGE = '/icons/badge-96.png';

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
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== MAIL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  // Signing out forgets the offline copy.
  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    event.waitUntil(caches.delete(MAIL));
    return;
  }
  if (req.method !== 'GET') return;
  if (url.pathname.startsWith('/api/')) {
    // Shared mailboxes aren't kept offline (one cache, one account).
    if (OFFLINE_API.test(url.pathname) && !req.headers.get('x-wren-mailbox') && !url.searchParams.has('mailbox')) event.respondWith(mailRead(req, url));
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
  return u.pathname + u.search;
}

/** Fresh from the network when online; the saved copy only when the network fails. */
async function mailRead(req, url) {
  const key = mailKey(url);
  try {
    const res = await fetch(req);
    if (res.ok) await keepMail(key, url, res.clone()).catch(() => {});
    return res;
  } catch {
    const cache = await caches.open(MAIL);
    const hit = await cache.match(key);
    if (hit) return hit;
    return new Response(JSON.stringify({ error: 'You’re offline, and this isn’t saved on this device yet.', code: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
}

async function keepMail(key, url, res) {
  const cache = await caches.open(MAIL);
  if (url.pathname === '/api/auth/me') {
    const me = await res.clone().json();
    const prev = await cache.match(key).then((r) => (r ? r.json() : null)).catch(() => null);
    // Signed out, or a different person: nothing of the previous account stays.
    if (!me || !me.user || (prev && prev.user && prev.user.id !== me.user.id)) {
      await caches.delete(MAIL);
      if (!me || !me.user) return;
    }
  }
  const store = await caches.open(MAIL);
  await store.delete(key);
  await store.put(key, res);
  if (/^\/api\/mail\/threads\/\d+$/.test(url.pathname)) {
    const threads = (await store.keys()).filter((k) => /\/api\/mail\/threads\/\d+/.test(new URL(k.url).pathname));
    for (const old of threads.slice(0, Math.max(0, threads.length - MAX_THREADS))) await store.delete(old);
  }
}

async function describeNewMail() {
  try {
    const res = await fetch('/api/me/notifications', { credentials: 'same-origin', headers: { 'X-Wren': '1' } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

self.addEventListener('push', (event) => {
  event.waitUntil(
    (async () => {
      const data = await describeNewMail();
      if (self.navigator.setAppBadge && data) self.navigator.setAppBadge(data.total || 0).catch(() => {});
      if (!data || !data.total) {
        // Signed out on this device, or already read elsewhere: keep it generic.
        return self.registration.showNotification('New mail', { body: 'Open Wren to read it.', tag: 'wren-mail', icon: ICON, badge: BADGE });
      }
      const top = data.items[0];
      const who = (i) => i.from.name || i.from.address;
      // A sign-in code: put it where it can be read at a glance.
      if (top.code) {
        return self.registration.showNotification(`${top.code} · ${who(top)}`, {
          body: `${top.subject || 'Sign-in code'}\nTap to open; the code can be copied from the message.`,
          tag: 'wren-mail',
          renotify: true,
          icon: ICON,
          badge: BADGE,
          data: { url: top.mailbox ? '/inbox' : `/inbox/${top.threadId}` },
        });
      }
      const title = data.total > 1 ? `${data.total} new messages` : who(top);
      const body =
        data.total > 1
          ? data.items
              .slice(0, 4)
              .map((i) => `${who(i)}: ${i.subject || '(no subject)'}`)
              .join('\n')
          : `${top.mailbox ? `${top.mailbox.address} · ` : ''}${top.subject || '(no subject)'}`;
      const url = data.total === 1 && !top.mailbox ? `/inbox/${top.threadId}` : '/inbox';
      return self.registration.showNotification(title, { body, tag: 'wren-mail', renotify: true, icon: ICON, badge: BADGE, data: { url } });
    })(),
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/inbox';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const w of windows) {
        if (new URL(w.url).origin === self.location.origin && 'focus' in w) {
          if ('navigate' in w) w.navigate(url).catch(() => {});
          return w.focus();
        }
      }
      return self.clients.openWindow(url);
    }),
  );
});

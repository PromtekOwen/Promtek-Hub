// Promtek Hub service worker: lets the hub install as an app and open with a
// cached shell when the connection drops. API data is never cached.
const CACHE = 'promtek-hub-v1';
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/dropdown.js', '/modules.js', '/tours.js', '/practice.js', '/manifest.webmanifest',
  '/logo-white.png', '/icon-192.png', '/icon-512.png', '/favicon-32.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => Promise.all(SHELL.map((url) =>
        fetch(url, { credentials: 'include' })
          .then((res) => (res.ok && res.type === 'basic' ? cache.put(url, res) : null))
          .catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/cdn-cgi/')) return;

  // Network first so updates show straight away; fall back to the cache offline.
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.type === 'basic') {
          const copy = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req).then((hit) => hit || (req.mode === 'navigate' ? caches.match('/') : Response.error())))
  );
});

// Tapping a notification brings the hub to the front, opening it if it's closed.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = event.notification.data?.link || '/';
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const open = wins.find((w) => new URL(w.url).origin === location.origin);
    if (open) return open.focus();
    return self.clients.openWindow(link);
  }));
});

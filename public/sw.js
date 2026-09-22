// Promtek Hub service worker: lets the hub install as an app and open with a
// cached shell when the connection drops. API data is never cached.
const CACHE = 'promtek-hub-v1';
const SHELL = [
  '/', '/index.html', '/styles.css', '/app.js', '/modules.js', '/manifest.webmanifest',
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

// Minimal service worker — its only job is to satisfy the browser's
// "installable PWA" requirement (a registered SW with a fetch handler).
// It deliberately does NOT cache anything: every request just goes
// straight to the network, so the app, the shared library, and Jira/
// Drive data are always fresh. Nothing here needs editing.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', (event) => {
  event.respondWith(fetch(event.request));
});

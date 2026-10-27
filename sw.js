// Offline shell: the display and control panel open even with no connection.
// Live data never comes from this cache; /api requests always go to the network.
const VERSION = 'fieldslate-v1';
const SHELL = [
  './', 'index.html', 'admin.html', 'manifest.webmanifest',
  'css/base.css', 'css/display.css', 'css/admin.css',
  'js/model.js', 'js/client.js', 'js/display.js', 'js/admin.js', 'js/sample.js',
  'icons/icon.svg', 'icons/icon-192.png', 'icons/apple-touch-icon.png',
  'fonts/barlow-sc-400.woff2', 'fonts/barlow-sc-500.woff2', 'fonts/barlow-sc-600.woff2', 'fonts/barlow-sc-700.woff2',
  'fonts/jbmono-400.woff2', 'fonts/jbmono-500.woff2', 'fonts/jbmono-700.woff2',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/')) return;
  // Network first so updates land immediately; cache when offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(e.request, copy)); }
      return res;
    }).catch(() => caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || (url.pathname.endsWith('/admin') ? caches.match('admin.html') : caches.match('index.html'))))
  );
});

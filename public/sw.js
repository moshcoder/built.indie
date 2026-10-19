// built.indie service worker: installable, and the board still opens offline.
// Pages: network first, the last copy when offline. Static files and pictures: cache first.
const VERSION = 'bi-1'
const SHELL = ['/', '/style.css', '/app.js', '/favicon.svg', '/icon-192.png']

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()))
})
self.addEventListener('fetch', (e) => {
  const req = e.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.startsWith('/api/') || url.pathname.startsWith('/auth/') || url.pathname.startsWith('/badge/')) return
  const asset = /\.(css|js|svg|png|jpg|webp|gif|avif|ico)$/.test(url.pathname) || url.pathname.startsWith('/m/')
  if (asset) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)) }
      return res
    })))
    return
  }
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok && !url.pathname.match(/^\/(me|login|p\/[^/]+\/(edit|claim))/)) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)) }
      return res
    }).catch(() => caches.match(req).then((hit) => hit || caches.match('/'))))
  }
})

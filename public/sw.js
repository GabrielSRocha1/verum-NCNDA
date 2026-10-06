// Service worker: guarda só o "casco" do app. Nunca guarda API, convite, login ou dados de operação.
const CACHE = 'votc-shell-v2';
const SHELL = ['/', '/app.css', '/js/app.js', '/js/core.js', '/js/components.js', '/js/invite.js', '/js/wallet-adapter.js', '/js/onboarding-logic.js', '/vendor/nacl-fast.min.js', '/vendor/qrcode.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== location.origin) return;
  if (/^\/(api|invite|invitations|auth|i)\b/.test(url.pathname)) return; // sempre rede, nunca cache
  if (e.request.mode === 'navigate') {
    e.respondWith(fetch(e.request).catch(() => caches.match('/')));
    return;
  }
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});

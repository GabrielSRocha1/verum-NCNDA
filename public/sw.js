// Service worker: guarda só o "casco" do app. Nunca guarda API, convite, login ou dados de operação.
const CACHE = 'votc-shell-v4';
// /verum-origins.js fica FORA de propósito: é gerado a partir de EMBED_ORIGINS e tem de refletir a
// variável de hoje, não a de quando o casco foi guardado. Sem cache de execução, ele vai à rede.
const SHELL = ['/', '/app.css', '/js/app.js', '/js/core.js', '/js/components.js', '/js/invite.js', '/js/wallet-adapter.js', '/js/verum-provider.js', '/js/onboarding-logic.js', '/vendor/nacl-fast.min.js', '/vendor/qrcode.js', '/vendor/verum-connector.js', '/manifest.webmanifest', '/icons/icon.svg', '/icons/icon-192.png'];
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
  // Rede primeiro, cache como rede de segurança. Cache primeiro guardava o app ANTIGO depois de um
  // deploy: a correção subia, o navegador seguia servindo a versão velha do próprio cache e a tela
  // continuava sem o botão novo — parecia que o deploy não tinha funcionado. O cache segue existindo
  // para o modo offline, mas deixa de mandar quando há rede.
  e.respondWith(
    fetch(e.request)
      .then((r) => {
        if (r && r.ok && r.type === 'basic') { const c = r.clone(); caches.open(CACHE).then((cache) => cache.put(e.request, c)); }
        return r;
      })
      .catch(() => caches.match(e.request).then((hit) => hit || Promise.reject(new Error('offline')))),
  );
});

/**
 * Plan&jar — Service Worker
 *
 * Estratégia: NETWORK-FIRST com fallback de cache.
 * Como o sistema usa Firebase em tempo real, NÃO queremos servir dados
 * cacheados quando o usuário está online. O cache aqui é só pra:
 *  1) Permitir instalação como PWA
 *  2) Mostrar uma página offline simpática quando não tem conexão
 *
 * IMPORTANTE: este SW NÃO intercepta chamadas pro Firebase
 * (firebaseio.com, googleapis.com, gstatic.com, firebasestorage.app).
 * Elas vão direto pra rede sempre.
 */

const CACHE_VERSION = 'planjar-v1';
const STATIC_CACHE = `planjar-static-${CACHE_VERSION}`;

const STATIC_ASSETS = [
  './',
  './index.html',
  './admin.html',
  './empresa.html',
  './obra.html',
  './manifest.json',
  './logo-planjar-mark.png',
];

/* ───────────────── INSTALL ───────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      // addAll pode falhar se algum asset não existir; tolera
      Promise.allSettled(STATIC_ASSETS.map((a) => cache.add(a)))
    ).then(() => self.skipWaiting())
  );
});

/* ───────────────── ACTIVATE ───────────────── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((k) => k.startsWith('planjar-') && k !== STATIC_CACHE)
          .map((k) => caches.delete(k))
      )
    ).then(() => self.clients.claim())
  );
});

/* ───────────────── FETCH ─────────────────
   Network-first com fallback de cache.
   Não intercepta APIs do Firebase / Google. */
const FIREBASE_HOSTS = [
  'firebaseio.com',
  'googleapis.com',
  'gstatic.com',
  'firebasestorage.app',
  'firebase.com',
  'cloudfunctions.net',
];

self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Só GET é cacheável
  if (request.method !== 'GET') return;

  const url = new URL(request.url);

  // Não interceptar Firebase / Google APIs
  if (FIREBASE_HOSTS.some((h) => url.hostname.endsWith(h))) return;

  // Não interceptar requests de outras origins (CDNs como cdnjs)
  // Deixa o browser lidar normalmente
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((res) => {
        // Atualiza cache em background pra próxima visita
        if (res.ok && res.type === 'basic') {
          const clone = res.clone();
          caches.open(STATIC_CACHE).then((c) => c.put(request, clone));
        }
        return res;
      })
      .catch(() =>
        caches.match(request).then((cached) => {
          if (cached) return cached;
          // Fallback final pra navegação: a home
          if (request.mode === 'navigate') {
            return caches.match('./admin.html');
          }
          return new Response('Sem conexão.', {
            status: 503,
            headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          });
        })
      )
  );
});

/* ───────────────── PUSH ─────────────────
   Esqueleto pra notificações push.
   Pra funcionar, o servidor (Firebase Cloud Messaging ou similar)
   precisa enviar payloads pra essa SW. Veja README.md. */
self.addEventListener('push', (event) => {
  if (!event.data) return;
  let data = {};
  try { data = event.data.json(); }
  catch (e) { data = { title: 'Plan&jar', body: event.data.text() }; }

  const title = data.title || 'Plan&jar';
  const options = {
    body: data.body || 'Você tem uma atualização na sua obra.',
    icon: data.icon || './logo-planjar-mark.png',
    badge: './logo-planjar-mark.png',
    data: { url: data.url || './admin.html' },
    tag: data.tag || 'planjar-push',
    requireInteraction: false,
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || './admin.html';
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      // se já tem janela aberta, foca nela
      for (const w of wins) {
        if (w.url.includes(url) && 'focus' in w) return w.focus();
      }
      if (clients.openWindow) return clients.openWindow(url);
    })
  );
});

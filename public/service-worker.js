const CACHE_NAME = 'warmbuddy-v' + Date.now();
const STATIC_ASSETS = [
  '/',
  '/manifest.json',
  '/icon-192.png',
  '/icon-512.png'
];

// ── Install: cache static assets ──
self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache => {
      return cache.addAll(STATIC_ASSETS).catch(e => {
        console.log('[SW] Cache install partial:', e.message);
      });
    })
  );
  self.skipWaiting();
});

// ── Activate: clean old caches ──
self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))
      );
    })
  );
  self.clients.claim();
});

// ── Fetch: network-first for HTML, cache-first for static ──
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // API requests: always network
  if (url.pathname.startsWith('/api/')) return;

  // HTML: network-first (so users always get latest)
  if (event.request.mode === 'navigate' || url.pathname === '/') {
    event.respondWith(
      fetch(event.request).catch(() => caches.match('/').then(cached => {
        if (cached) return cached;
        return new Response('Offline — please connect to the internet', {
          status: 503,
          headers: { 'Content-Type': 'text/plain' }
        });
      }))
    );
    return;
  }

  // Static assets: cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      return cached || fetch(event.request).then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      });
    })
  );
});

// ── Push: show notification ──
self.addEventListener('push', event => {
  let payload = {};
  try {
    if (event.data) {
      payload = event.data.json();
    }
  } catch (e) {
    payload = { title: '暖伴', body: event.data ? event.data.text() : '' };
  }

  const title = payload.title || '暖伴';
  const options = {
    body: payload.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: payload.tag || 'warmbuddy-general',
    data: payload.data || {},
    requireInteraction: payload.requireInteraction || false,
    vibrate: [200, 100, 200],
    timestamp: Date.now()
  };

  event.waitUntil(
    self.registration.showNotification(title, options)
  );
});

// ── Notification click: open app ──
self.addEventListener('notificationclick', event => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clientList => {
      // If a window is already open, focus it
      for (const client of clientList) {
        if (client.url.includes(targetUrl) || client.url.includes(self.registration.scope)) {
          client.focus();
          client.postMessage({
            type: 'NOTIFICATION_CLICK',
            data: event.notification.data
          });
          return;
        }
      }
      // Otherwise open new window
      if (clients.openWindow) {
        clients.openWindow(targetUrl);
      }
    })
  );
});

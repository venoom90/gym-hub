const CACHE_NAME = 'gym-hub-v30';
const SHARE_CACHE_NAME = 'gym-share-temp-v30';

const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './js/app.js',
  './js/state.js',
  './js/api.js',
  './js/parser.js',
  './js/overview.js',
  './js/analytics.js',
  './js/sync.js'
];

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key !== SHARE_CACHE_NAME) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. ОБРАБОТКА WEB SHARE TARGET (POST-запрос из шторки GymUp)
  if (event.request.method === 'POST') {
    event.respondWith((async () => {
      let sharedText = '';
      try {
        const formData = await event.request.formData();

        for (const [, value] of formData.entries()) {
          if (value && typeof value === 'object' && typeof value.text === 'function') {
            sharedText = await value.text();
            break;
          }
        }

        if (!sharedText) {
          sharedText = formData.get('text') || formData.get('title') || '';
        }

        if (sharedText) {
          const shareCache = await caches.open(SHARE_CACHE_NAME);
          await shareCache.put(
            '/gym-hub/shared-workout-data',
            new Response(JSON.stringify({ text: sharedText, timestamp: Date.now() }), {
              headers: { 'Content-Type': 'application/json' }
            })
          );

          const windowClients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
          for (const client of windowClients) {
            client.postMessage({
              type: 'SHARED_WORKOUT_TEXT',
              text: sharedText
            });
          }
        }
      } catch (err) {
        console.error('[SW v30] Ошибка при перехвате Share Target:', err);
      }

      // Перенаправляем на главную страницу с флагом ожидания шэринга
      return Response.redirect('/gym-hub/?shared=1', 303);
    })());
    return;
  }

  // 2. Внешние динамические API и CDN пропускаем напрямую в сеть
  const isExternalRequest = url.origin !== self.location.origin;
  if (
    isExternalRequest ||
    url.hostname.includes('script.google.com') ||
    url.hostname.includes('googleapis.com') ||
    url.hostname.includes('cdn.jsdelivr.net') ||
    url.hostname.includes('esm.sh')
  ) {
    return;
  }

  // 3. Локальные статические ресурсы приложения (Cache First с фоновым обновлением)
  if (event.request.method === 'GET') {
    event.respondWith(
      caches.match(event.request).then((cachedResponse) => {
        if (cachedResponse) {
          fetch(event.request).then((networkResponse) => {
            if (networkResponse && networkResponse.status === 200) {
              caches.open(CACHE_NAME).then((cache) => cache.put(event.request, networkResponse));
            }
          }).catch(() => {});
          return cachedResponse;
        }
        return fetch(event.request);
      })
    );
  }
});
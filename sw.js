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
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    }).then(() => self.skipWaiting())
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

  // Перехват входящего POST-запроса от Web Share Target API
  if (event.request.method === 'POST' && url.pathname.includes('/gym-hub/')) {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData();
          let sharedContent = formData.get('text') || '';

          const file = formData.get('report_file');
          if (file && typeof file.text === 'function') {
            sharedContent = await file.text();
          }

          if (sharedContent) {
            const shareCache = await caches.open(SHARE_CACHE_NAME);
            const responseToSave = new Response(sharedContent, {
              headers: { 'Content-Type': 'text/plain; charset=utf-8' }
            });
            await shareCache.put('/gym-share-temp-v30/shared-workout-data', responseToSave);

            const allClients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
            allClients.forEach((client) => {
              client.postMessage({
                type: 'GYM_SHARED_WORKOUT_AVAILABLE',
                payload: sharedContent
              });
            });
          }
        } catch (err) {
          console.error('[SW] Ошибка парсинга share target:', err);
        }

        // Редирект на главную страницу приложения
        return Response.redirect('./', 303);
      })()
    );
    return;
  }

  // Стандартная оффлайн-стратегия Cache First с фоновым обновлением для статики
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
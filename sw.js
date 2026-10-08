const CACHE_NAME = 'gym-hub-gh-cache-v23';
const SHARE_CACHE_NAME = 'gym-share-temp-v23';

// Полный перечень реальных локальных ассетов без фиктивных путей
const STATIC_ASSETS = [
  '/gym-hub/',
  '/gym-hub/index.html',
  '/gym-hub/manifest.json',
  '/gym-hub/js/state.js',
  '/gym-hub/js/app.js',
  '/gym-hub/js/api.js',
  '/gym-hub/js/overview.js',
  '/gym-hub/js/analytics.js',
  '/gym-hub/js/parser.js',
  '/gym-hub/js/sync.js'
];

// Установка: предварительное кэширование локальных файлов
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return Promise.allSettled(
        STATIC_ASSETS.map((asset) =>
          cache.add(asset).catch((err) => {
            console.warn(`[SW v23] Не удалось закэшировать локальный ресурс: ${asset}`, err);
          })
        )
      );
    })
  );
});

// Активация: удаление устаревших версий кэша
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME && key !== SHARE_CACHE_NAME) {
            console.log(`[SW v23] Очистка устаревшего кэша: ${key}`);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Перехват сетевых запросов
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
        console.error('[SW v23] Ошибка при перехвате Share Target:', err);
      }

      // Перенаправляем на главную страницу приложения на GitHub Pages
      return Response.redirect('/gym-hub/?shared=1', 303);
    })());
    return;
  }

  // 2. Внешние динамические API и внешние CDN пропускаем напрямую в сеть
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

  // 3. Навигационные запросы страниц: приоритет сети с мягким откатом в кэш
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        })
        .catch(async () => {
          const cache = await caches.open(CACHE_NAME);
          const cachedPage = (await cache.match(event.request)) || (await cache.match('/gym-hub/')) || (await cache.match('/gym-hub/index.html'));
          return cachedPage;
        })
    );
    return;
  }

  // 4. Локальные статические ассеты приложения (Stale-While-Revalidate)
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200 && networkResponse.type === 'basic') {
            const responseToCache = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, responseToCache);
            });
          }
          return networkResponse;
        })
        .catch(() => {
          return cachedResponse;
        });

      return cachedResponse || fetchPromise;
    })
  );
});
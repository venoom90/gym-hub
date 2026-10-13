/**
 * =========================================================================
 * GYM ANALYTICS HUB — SERVICE WORKER (V36 FAULT-TOLERANT)
 * =========================================================================
 */

const CACHE_NAME = 'gym-hub-v36';
const SHARE_CACHE_NAME = 'gym-share-temp-v36';

const APP_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon.svg',
  './js/app.js',
  './js/state.js',
  './js/api.js',
  './js/coach.js',
  './js/overview.js',
  './js/analytics.js',
  './js/sync.js',
  './js/parser.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Отказоустойчивое кэширование: 404 на отдельном файле не прерывает установку PWA
      await Promise.allSettled(
        APP_ASSETS.map((url) =>
          fetch(new Request(url, { cache: 'reload' }))
            .then((res) => {
              if (res.ok) return cache.put(url, res);
              console.warn('[SW] Пропуск ассета со статусом ' + res.status + ':', url);
            })
            .catch((err) => {
              console.warn('[SW] Не удалось загрузить ассет:', url, err);
            })
        )
      );
    }).then(() => {
      return self.skipWaiting();
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
    }).then(() => {
      return self.clients.claim();
    })
  );
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Google Apps Script API пропускается исключительно в сеть
  if (url.origin.includes('script.google.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 2. Обработка Web Share Target v2 (файл или текст из системной шторки Android)
  if (event.request.method === 'POST' && url.pathname.endsWith('/share-target')) {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData();
          const file = formData.get('report_file') || formData.get('file');
          const textData = formData.get('text');

          const shareCache = await caches.open(SHARE_CACHE_NAME);

          if (file && typeof file !== 'string') {
            await shareCache.put('shared-workout-data', new Response(file));
          } else if (textData && typeof textData === 'string' && textData.trim()) {
            await shareCache.put('shared-workout-data', new Response(textData, {
              headers: { 'Content-Type': 'text/plain;charset=utf-8' }
            }));
          }
        } catch (err) {
          console.warn('[SW] Ошибка приема данных шэринга:', err);
        }
        return Response.redirect('./#tab-sync', 303);
      })()
    );
    return;
  }

  // 3. Stale-While-Revalidate с защитой от сбоя при оффлайне
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      const fetchPromise = fetch(event.request).then((networkResponse) => {
        if (networkResponse && networkResponse.status === 200 && event.request.method === 'GET') {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(event.request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        return cachedResponse || new Response('', { status: 503, statusText: 'Offline Unavailable' });
      });

      return cachedResponse || fetchPromise;
    })
  );
});
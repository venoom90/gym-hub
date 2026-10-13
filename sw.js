/**
 * =========================================================================
 * GYM ANALYTICS HUB — SERVICE WORKER (V38 ZERO-405 BULLETPROOF)
 * =========================================================================
 */

const CACHE_NAME = 'gym-hub-v38';
const SHARE_CACHE_NAME = 'gym-share-mailbox';

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
      await Promise.allSettled(
        APP_ASSETS.map((url) =>
          fetch(new Request(url, { cache: 'reload' }))
            .then((res) => {
              if (res.ok) return cache.put(url, res);
              console.warn('[SW] Пропуск ассета ' + res.status + ':', url);
            })
            .catch((err) => {
              console.warn('[SW] Ошибка загрузки ассета:', url, err);
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

  // 2. ПЕРЕХВАТ ЛЮБОГО POST-ЗАПРОСА НА НАШЕМ ХОСТЕ (Web Share Target)
  // Это полностью исключает попадание POST на GitHub Pages и возникновение ошибки 405
  if (event.request.method === 'POST') {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData();
          let sharedText = '';

          // Поиск файла отчета среди всех полей формы
          for (const [key, val] of formData.entries()) {
            if (val && typeof val !== 'string' && typeof val.text === 'function') {
              sharedText = await val.text();
              if (sharedText && sharedText.trim()) break;
            }
          }

          // Если бинарный файл не найден, проверяем текстовые поля
          if (!sharedText) {
            const textVal = formData.get('text');
            if (textVal && typeof textVal === 'string' && textVal.trim()) {
              sharedText = textVal.trim();
            } else {
              for (const [key, val] of formData.entries()) {
                if (typeof val === 'string' && val.length > 30) {
                  sharedText = val.trim();
                  break;
                }
              }
            }
          }

          if (sharedText) {
            const shareCache = await caches.open(SHARE_CACHE_NAME);
            await shareCache.put('shared-workout-data', new Response(sharedText, {
              headers: { 'Content-Type': 'text/plain;charset=utf-8' }
            }));
          }
        } catch (err) {
          console.warn('[SW] Ошибка разбора Web Share Target:', err);
        }

        // Чистый редирект 303 на корень приложения scope без хэша
        const targetUrl = self.registration.scope;
        try {
          return Response.redirect(targetUrl, 303);
        } catch (e) {
          return new Response(
            `<!DOCTYPE html><html><head><meta http-equiv="refresh" content="0;url=${targetUrl}"></head><body><script>location.replace(${JSON.stringify(targetUrl)});</script></body></html>`,
            {
              status: 200,
              headers: { 'Content-Type': 'text/html;charset=utf-8' }
            }
          );
        }
      })()
    );
    return;
  }

  // 3. Stale-While-Revalidate для статики и библиотек
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
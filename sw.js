/**
 * =========================================================================
 * GYM ANALYTICS HUB — SERVICE WORKER (V32 STABLE)
 * =========================================================================
 * 
 * ОБНОВЛЕНИЯ V32:
 * 1. Добавлен модуль ./js/coach.js в список прекэшируемых ассетов (AI Copilot).
 * 2. Ротация кэша: удаление старых контейнеров v31 и ниже.
 * 3. Сетевой пропуск Network Only для всех запросов к script.google.com и CDN.
 * 4. Сохранение полной поддержки Web Share Target v2 (отчеты GymUp).
 */

const CACHE_NAME = 'gym-hub-v32';
const SHARE_CACHE_NAME = 'gym-share-temp-v32';

const APP_ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './js/app.js',
  './js/state.js',
  './js/api.js',
  './js/coach.js',
  './js/overview.js',
  './js/analytics.js',
  './js/sync.js',
  './js/parser.js'
];

// Установка: прекэширование критических ассетов приложения
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(APP_ASSETS);
    }).then(() => {
      return self.skipWaiting();
    })
  );
});

// Активация: автоматическая очистка устаревших контейнеров кэша
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

// Обработка сетевых запросов (Fetch Strategy)
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Исключение для внешних API (Google Apps Script Relay, CDN, Google Fonts)
  // Пропускаем напрямую в сеть без перехвата
  if (url.origin.includes('script.google.com') ||
      url.origin.includes('cdn.jsdelivr.net') ||
      url.origin.includes('esm.sh') ||
      url.origin.includes('googleapis.com') ||
      url.origin.includes('gstatic.com')) {
    event.respondWith(fetch(event.request));
    return;
  }

  // 2. Обработка Web Share Target (прием отчета GymUp через системную шторку)
  if (event.request.method === 'POST' && url.pathname.includes('/share-target')) {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData();
          const file = formData.get('file');
          if (file) {
            const shareCache = await caches.open(SHARE_CACHE_NAME);
            await shareCache.put('shared-report-file', new Response(file));
          }
        } catch (err) {
          console.warn('[SW] Ошибка приема файла через Share Target:', err);
        }
        // Редирект во вкладку синхронизации
        return Response.redirect('./#tab-sync', 303);
      })()
    );
    return;
  }

  // 3. Стратегия Cache First с обновлением из сети для локальной статики PWA
  event.respondWith(
    caches.match(event.request).then((cachedResponse) => {
      if (cachedResponse) {
        // Фоновое обновление кэша (Stale-While-Revalidate)
        fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, networkResponse);
            });
          }
        }).catch(() => {/* Оффлайн */});
        return cachedResponse;
      }
      return fetch(event.request);
    })
  );
});
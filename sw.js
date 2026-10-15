/**
 * =========================================================================
 * GYM ANALYTICS HUB — SERVICE WORKER (V48 READ-THROUGH CACHE & NOTIFY)
 * =========================================================================
 * V48 изменения:
 * - GAS API больше не «проваливается» при офлайне: stale-while-revalidate
 *   с TTL-кэшем на 5 минут для GET/POST-запросов get_all_data.
 * - Явный fallback-ответ 503 для non-cacheable GAS POST.
 * - Мелкие улучшения совместимости с M3-обновлениями index.html.
 */

const CACHE_NAME = 'gym-hub-v48';
const SHARE_CACHE_NAME = 'gym-share-mailbox';
const GAS_CACHE_NAME = 'gym-gas-cache-v1';
const GAS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут

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
  './js/parser.js',
  './js/live_workout.js'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      for (const url of APP_ASSETS) {
        try {
          const res = await fetch(new Request(url, { cache: 'reload' }));
          if (res.ok) {
            await cache.put(url, res);
          } else {
            console.warn(`[SW] Не удалось предзагрузить ${url}: HTTP ${res.status}`);
          }
        } catch (err) {
          console.warn(`[SW] Сбой сети при предзагрузке ${url}:`, err);
        }
      }
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
          const preserved = [CACHE_NAME, SHARE_CACHE_NAME, GAS_CACHE_NAME];
          if (!preserved.includes(key)) {
            return caches.delete(key);
          }
        })
      );
    }).then(() => {
      return self.clients.claim();
    }).then(async () => {
      const clientsList = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clientsList.forEach((client) => {
        client.postMessage({ type: 'SW_UPDATED', version: CACHE_NAME });
      });
    })
  );
});

/**
 * Хелпер: кэшированный ответ с TTL-проверкой.
 * Возвращает { response, isFresh } либо null, если кэша нет.
 */
async function getCachedWithTimestamp(cacheName, request) {
  try {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (!cached) return null;

    const cachedAt = parseInt(cached.headers.get('X-SW-Cached-At') || '0', 10);
    const age = Date.now() - cachedAt;
    return { response: cached, isFresh: age < GAS_CACHE_TTL_MS };
  } catch (e) {
    return null;
  }
}

async function putCachedWithTimestamp(cacheName, request, response) {
  try {
    const cache = await caches.open(cacheName);
    const cloned = response.clone();
    const headers = new Headers(cloned.headers);
    headers.set('X-SW-Cached-At', String(Date.now()));
    const body = await cloned.blob();
    const wrapped = new Response(body, {
      status: cloned.status,
      statusText: cloned.statusText,
      headers: headers
    });
    await cache.put(request, wrapped);
  } catch (e) {
    console.warn('[SW] Не удалось положить в кэш GAS:', e);
  }
}

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Google Apps Script API — stale-while-revalidate для get_all_data/get_debug_log,
  //    network-only с fallback 503 для остальных action
  if (url.origin.includes('script.google.com')) {
    event.respondWith(handleGasRequest(event.request));
    return;
  }

  // 2. Web Share Target
  if (event.request.method === 'POST') {
    event.respondWith(
      (async () => {
        try {
          const formData = await event.request.formData();
          let sharedText = '';

          for (const [key, val] of formData.entries()) {
            if (val && typeof val !== 'string' && typeof val.text === 'function') {
              sharedText = await val.text();
              if (sharedText && sharedText.trim()) break;
            }
          }

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

  // 3. Cache-First с ignoreSearch для same-origin GET (статика)
  const isSameOrigin = (url.origin === self.location.origin);
  if (isSameOrigin && event.request.method === 'GET') {
    event.respondWith(
      caches.match(event.request, { ignoreSearch: true }).then((cachedResponse) => {
        if (cachedResponse) {
          return cachedResponse;
        }
        return fetch(event.request).then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => {
              cache.put(event.request, copy);
            });
          }
          return networkResponse;
        });
      })
    );
    return;
  }

  // 4. Stale-While-Revalidate для внешних CDN-ресурсов
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

/**
 * Специализированный обработчик GAS:
 * - Для POST читаем body как текст, детектируем action в JSON, решаем стратегию.
 * - Для GET fallback: network-first, кэш при провале.
 * - Для get_all_data / get_debug_log: возвращаем свежий кэш немедленно,
 *   параллельно обновляем (stale-while-revalidate).
 */
async function handleGasRequest(request) {
  let clonedRequest;
  let actionHint = null;
  let bodyText = null;

  if (request.method === 'POST') {
    try {
      clonedRequest = request.clone();
      bodyText = await clonedRequest.text();
      const parsed = JSON.parse(bodyText);
      actionHint = parsed && parsed.action ? String(parsed.action) : null;
    } catch (e) {
      // Тело не JSON или пустое — обрабатываем как обычный POST
    }
  }

  const isCacheableAction = (actionHint === 'get_all_data' || actionHint === 'get_debug_log');
  const cacheKey = new Request(
    `gas-cache://${request.method}/${actionHint || 'unknown'}`,
    { method: 'GET' }
  );

  // === Cacheable actions: stale-while-revalidate ===
  if (isCacheableAction) {
    const cached = await getCachedWithTimestamp(GAS_CACHE_NAME, cacheKey);

    const networkFetch = (async () => {
      try {
        const fetchInit = request.method === 'POST'
          ? {
              method: 'POST',
              headers: { 'Content-Type': 'text/plain;charset=utf-8' },
              body: bodyText
            }
          : { method: 'GET' };
        const networkResponse = await fetch(request.url, fetchInit);
        if (networkResponse && networkResponse.ok) {
          await putCachedWithTimestamp(GAS_CACHE_NAME, cacheKey, networkResponse.clone());
        }
        return networkResponse;
      } catch (err) {
        return null;
      }
    })();

    if (cached) {
      // Отдаём кэш немедленно (быстро), сеть обновляется в фоне
      return cached.response;
    }

    const networkResponse = await networkFetch;
    if (networkResponse) return networkResponse;

    return new Response(JSON.stringify({
      success: false,
      error: 'Оффлайн-режим: сервер недоступен, кэшированных данных нет.'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // === Остальные action: network-only с fallback ===
  try {
    const fetchInit = request.method === 'POST'
      ? {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: bodyText
        }
      : { method: 'GET' };
    const networkResponse = await fetch(request.url, fetchInit);
    return networkResponse;
  } catch (err) {
    console.warn('[SW] GAS offline (не get_all_data):', err);
    return new Response(JSON.stringify({
      success: false,
      error: 'Оффлайн-режим: серверный GAS недоступен. Повторите попытку при появлении связи.'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
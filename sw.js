/**
 * =========================================================================
 * GYM ANALYTICS HUB — SERVICE WORKER (V49 CACHE-INTEGRITY HARDENING)
 * =========================================================================
 * V49 изменения:
 * - Кэш GAS больше не «отравляется» ошибками: {success:false} и невалидный
 *   JSON не попадают в кэш. Ответ считается успешным только при
 *   data.success !== false (см. isSuccessfulGasPayload).
 * - isFresh теперь реально работает: свежий кэш (<5 мин) отдаётся мгновенно
 *   с фоновым обновлением через event.waitUntil; устаревший кэш (>5 мин)
 *   блокирует ответ до ответа сети, а кэш используется только как fallback
 *   при сетевом сбое.
 * - Фоновое обновление защищено event.waitUntil — воркер не будет убит
 *   раньше, чем кэш обновится.
 * - После успешной записи (sync_sets / save_ai_plan) кэш get_all_data
 *   инвалидируется: следующий refresh видит новые данные СРАЗУ, а не со
 *   второго обновления (Последствие 1 из аудита).
 * - APP_ASSETS включает ./js/modal_manager.js — офлайн-запуск PWA не упадёт
 *   на отсутствующем модуле.
 * - Строгая проверка url.hostname === 'script.google.com' для GAS.
 * - CACHE_NAME V48→V49 и GAS_CACHE_NAME v1→v2: старые (возможно,
 *   отравленные) записи не переживают деплой.
 * =========================================================================
 */

const CACHE_NAME = 'gym-hub-v50';
const SHARE_CACHE_NAME = 'gym-share-mailbox';
const GAS_CACHE_NAME = 'gym-gas-cache-v2';
const GAS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 минут
const GAS_HOSTNAME = 'script.google.com';

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
  './js/live_workout.js',
  './js/modal_manager.js'
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

/* =========================================================
 * GAS CACHE HELPERS
 * ========================================================= */

function buildGasCacheKey(action) {
  return new Request(`gas-cache://POST/${action || 'unknown'}`, { method: 'GET' });
}

async function getCachedWithTimestamp(cacheName, request) {
  try {
    const cache = await caches.open(cacheName);
    const cached = await cache.match(request);
    if (!cached) return null;

    const cachedAt = parseInt(cached.headers.get('X-SW-Cached-At') || '0', 10);
    const age = Date.now() - cachedAt;
    return { response: cached, isFresh: age < GAS_CACHE_TTL_MS, ageMs: age };
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

/**
 * Проверяет, что тело ответа — валидный JSON с data.success !== false.
 * Невалидный JSON / read error / HTTP !ok — считаются неуспехом (не кэшируются).
 */
async function isSuccessfulGasPayload(response) {
  try {
    const cloned = response.clone();
    const text = await cloned.text();
    if (!text || !text.trim()) return false;
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object') return false;
    return parsed.success !== false;
  } catch (e) {
    return false;
  }
}

async function invalidateGetAllDataCache() {
  try {
    const cache = await caches.open(GAS_CACHE_NAME);
    await cache.delete(buildGasCacheKey('get_all_data'));
  } catch (e) {
    console.warn('[SW] Не удалось инвалидировать кэш get_all_data:', e);
  }
}

/**
 * Выполняет сетевой запрос к GAS и кэширует результат ТОЛЬКО при
 * HTTP 200 + data.success !== false. Возвращает Response (включая
 * {success:false} — вызывающий решает, что делать).
 * Бросает при сетевой ошибке.
 */
async function fetchAndCacheGas(request, bodyText, cacheKey, isCacheable) {
  const fetchInit = request.method === 'POST'
    ? {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: bodyText
      }
    : { method: 'GET' };

  const response = await fetch(request.url, fetchInit);
  if (!response) return null;

  if (isCacheable && response.ok) {
    const ok = await isSuccessfulGasPayload(response);
    if (ok) {
      await putCachedWithTimestamp(GAS_CACHE_NAME, cacheKey, response);
    }
  }
  return response;
}

/* =========================================================
 * FETCH HANDLER
 * ========================================================= */

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 1. Google Apps Script API — отдельный поток обработки
  if (url.hostname === GAS_HOSTNAME) {
    event.respondWith(handleGasRequest(event));
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

  // 3. Same-origin статика — cache-first с ignoreSearch
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

  // 4. Внешние CDN — stale-while-revalidate
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

/* =========================================================
 * GAS HANDLER
 * ========================================================= */

async function handleGasRequest(event) {
  const request = event.request;
  let actionHint = null;
  let bodyText = null;

  if (request.method === 'POST') {
    try {
      const clonedRequest = request.clone();
      bodyText = await clonedRequest.text();
      const parsed = JSON.parse(bodyText);
      actionHint = parsed && parsed.action ? String(parsed.action) : null;
    } catch (e) {
      // тело не JSON — actionHint останется null
    }
  }

  const isCacheableAction = (actionHint === 'get_all_data' || actionHint === 'get_debug_log');
  const cacheKey = buildGasCacheKey(actionHint);

  // === CACHEABLE ACTIONS (get_all_data, get_debug_log) ===
  if (isCacheableAction) {
    const cached = await getCachedWithTimestamp(GAS_CACHE_NAME, cacheKey);

    // Свежий кэш: отдаём мгновенно, обновляем в фоне (waitUntil удержит воркер).
    if (cached && cached.isFresh) {
      event.waitUntil(
        fetchAndCacheGas(request, bodyText, cacheKey, true).catch((err) => {
          console.warn('[SW] Background GAS refresh failed:', err);
          return null;
        })
      );
      return cached.response;
    }

    // Устаревший / отсутствующий кэш — ждём сеть.
    try {
      const networkResponse = await fetchAndCacheGas(request, bodyText, cacheKey, true);
      if (networkResponse && networkResponse.ok) {
        return networkResponse;
      }
      // HTTP !ok — считаем сбоем, идём в fallback.
    } catch (err) {
      console.warn('[SW] GAS network failed (cacheable), fallback to cache:', err);
    }

    // Fallback: stale cache (если есть) или явный офлайн-ответ.
    if (cached) return cached.response;

    return new Response(JSON.stringify({
      success: false,
      error: 'Оффлайн-режим: сервер недоступен, кэшированных данных нет.'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }

  // === NON-CACHEABLE ACTIONS (sync_sets, save_ai_plan, ask_gemini_coach) ===
  try {
    const networkResponse = await fetchAndCacheGas(request, bodyText, cacheKey, false);

    if (!networkResponse) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Оффлайн-режим: серверный GAS недоступен. Повторите попытку при появлении связи.'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // После успешной записи — инвалидация get_all_data (чтобы refresh увидел новое сразу).
    if (networkResponse.ok && (actionHint === 'sync_sets' || actionHint === 'save_ai_plan')) {
      event.waitUntil(invalidateGetAllDataCache());
    }

    return networkResponse;
  } catch (err) {
    console.warn('[SW] GAS offline (non-cacheable):', err);
    return new Response(JSON.stringify({
      success: false,
      error: 'Оффлайн-режим: серверный GAS недоступен. Повторите попытку при появлении связи.'
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

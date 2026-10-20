/**
 * =========================================================================
 * GYM ANALYTICS HUB — SERVICE WORKER (V54)
 * =========================================================================
 * V54 (поверх V53 / V52):
 * - Bug 3: инвалидация get_all_data после sync_sets / save_ai_plan теперь
 *   через await invalidateGetAllDataCache() ДО возврата ответа. Раньше
 *   event.waitUntil позволял клиенту приступить к следующему get_all_data
 *   раньше, чем завершится cache.delete → stale-гонка.
 * - Bug 2: payload.noCache === true → SW пропускает чтение кэша и идёт в
 *   сеть. При сбое сети — fallback на stale (если есть). Используется
 *   ручной кнопкой «Обновить» и после смены токена (Bug 2b в app.js).
 * - Bug 13: cached-ответы оборачиваются в новый Response с заголовками
 *   X-SW-From-Cache: 1 и X-SW-Cache-Age-Ms: <ms>. Клиент (api.js) читает
 *   их и корректно выставляет LAST_SYNC_KEY.
 * - V52 hotfix (Cache API scheme — синтетический http(s) URL) сохранён.
 * - V49 fixes (isSuccessfulGasPayload, TTL, hostname, APP_ASSETS) сохранены.
 * - CACHE_NAME V52 → V54 (снапшот §8 числит V53; берём заведомо больший
 *   номер, чтобы активировать на любом клиенте).
 * =========================================================================
 */

const CACHE_NAME = 'gym-hub-v54';
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
  './js/modal_manager.js',
  './js/ui.js'
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
  return new Request(
    `${self.location.origin}/__sw_gas_cache__/${action || 'unknown'}`,
    { method: 'GET' }
  );
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
 * Bug 13: оборачивает cached-ответ заголовками X-SW-From-Cache и
 * X-SW-Cache-Age-Ms, чтобы клиент знал, что данные из кэша и насколько
 * они старые. Создаётся constructed Response — клиент видит все headers.
 */
async function buildCachedResponseWithHeaders(cachedResponse, ageMs) {
  try {
    const buf = await cachedResponse.clone().arrayBuffer();
    const headers = new Headers(cachedResponse.headers);
    headers.set('X-SW-From-Cache', '1');
    headers.set('X-SW-Cache-Age-Ms', String(Math.max(0, Math.round(ageMs || 0))));
    return new Response(buf, {
      status: cachedResponse.status,
      statusText: cachedResponse.statusText,
      headers: headers
    });
  } catch (e) {
    console.warn('[SW] Не удалось обернуть cached response:', e);
    return cachedResponse;
  }
}

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

function offlineErrorResponse(message) {
  return new Response(JSON.stringify({ success: false, error: message }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
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
  let noCache = false;

  if (request.method === 'POST') {
    try {
      const clonedRequest = request.clone();
      bodyText = await clonedRequest.text();
      const parsed = JSON.parse(bodyText);
      actionHint = parsed && parsed.action ? String(parsed.action) : null;
      noCache = Boolean(parsed && parsed.noCache === true);
    } catch (e) {
      // тело не JSON — actionHint останется null
    }
  }

  const isCacheableAction = (actionHint === 'get_all_data' || actionHint === 'get_debug_log');
  const cacheKey = buildGasCacheKey(actionHint);

  // === Bug 2: noCache — принудительный обход кэша (только для cacheable) ===
  if (noCache && isCacheableAction) {
    try {
      const networkResponse = await fetchAndCacheGas(request, bodyText, cacheKey, true);
      if (networkResponse && networkResponse.ok) {
        return networkResponse;
      }
      // HTTP !ok от GAS — не считаем успехом, идём в fallback.
    } catch (err) {
      console.warn('[SW] noCache fetch failed, fallback to cache:', err);
    }

    // Fallback: в офлайне — отдать stale (если есть).
    const cached = await getCachedWithTimestamp(GAS_CACHE_NAME, cacheKey);
    if (cached) {
      return await buildCachedResponseWithHeaders(cached.response, cached.ageMs);
    }
    return offlineErrorResponse('Оффлайн-режим: обновление не удалось, кэшированных данных нет.');
  }

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
      return await buildCachedResponseWithHeaders(cached.response, cached.ageMs);
    }

    // Устаревший / отсутствующий кэш — ждём сеть.
    try {
      const networkResponse = await fetchAndCacheGas(request, bodyText, cacheKey, true);
      if (networkResponse && networkResponse.ok) {
        return networkResponse;
      }
    } catch (err) {
      console.warn('[SW] GAS network failed (cacheable), fallback to cache:', err);
    }

    // Fallback: stale cache (если есть) или явный офлайн-ответ.
    if (cached) return await buildCachedResponseWithHeaders(cached.response, cached.ageMs);

    return offlineErrorResponse('Оффлайн-режим: сервер недоступен, кэшированных данных нет.');
  }

  // === NON-CACHEABLE ACTIONS (sync_sets, save_ai_plan, ask_gemini_coach) ===
  try {
    const networkResponse = await fetchAndCacheGas(request, bodyText, cacheKey, false);

    if (!networkResponse) {
      return offlineErrorResponse('Оффлайн-режим: серверный GAS недоступен. Повторите попытку при появлении связи.');
    }

    // Bug 3 fix: await инвалидации ДО возврата ответа, иначе следующий
    // get_all_data может успеть прочитать устаревший кэш.
    if (networkResponse.ok && (actionHint === 'sync_sets' || actionHint === 'save_ai_plan')) {
      await invalidateGetAllDataCache();
    }

    return networkResponse;
  } catch (err) {
    console.warn('[SW] GAS offline (non-cacheable):', err);
    return offlineErrorResponse('Оффлайн-режим: серверный GAS недоступен. Повторите попытку при появлении связи.');
  }
}
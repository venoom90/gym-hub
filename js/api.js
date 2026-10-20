/**
 * =========================================================================
 * GYM ANALYTICS HUB — API LAYER (V2.1)
 * =========================================================================
 * V2.1:
 * - Bug 4 (критический): clearTimeout перенесён в finally. Раньше таймер
 *   снимался сразу после fetch() — res.text() выполнялся уже без контроля,
 *   и на медленной сети большой get_all_data мог висеть бесконечно.
 * - Bug 2: добавлен opts.noCache → payload.noCache=true. SW читает флаг и
 *   обходит кэш (используется ручной кнопкой «Обновить» и после смены токена).
 * - Bug 13: postGas() читает X-SW-From-Cache и X-SW-Cache-Age-Ms из ответа
 *   SW. fetchAnalyticsData() возвращает {success, data, fromCache, cacheAgeMs}
 *   — app.js использует это для честного LAST_SYNC_KEY.
 * - postGas() возвращает {ok, data, error, fromCache, cacheAgeMs}. Никогда
 *   не throws.
 * - V2.0-контракт сохранён: res.text()+JSON.parse, HTML-ответ даёт
 *   осмысленную ошибку.
 * =========================================================================
 */

export const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbydM_23SpEHmQyKmveDgw9vc_0_TRASZA-M444YPXcGffdDowR5RWaryrrgNg_YflNv/exec';

/**
 * Единственный транспорт к GAS. НИКОГДА не throws.
 *
 * @param {string} action
 * @param {object} payload
 * @param {object} opts - {timeoutMs, timeoutMessage, noCache}
 * @returns {Promise<{ok:boolean, data:any, error:string|null, fromCache:boolean, cacheAgeMs:number}>}
 */
async function postGas(action, payload, opts) {
  const options = opts || {};
  const timeoutMs = (typeof options.timeoutMs === 'number') ? options.timeoutMs : 15000;
  const timeoutMessage = options.timeoutMessage ||
    `Превышено время ожидания ответа сервера (${Math.round(timeoutMs / 1000)} секунд). Проверьте интернет-соединение.`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const token = localStorage.getItem('gym_api_token') || '';
    const fullPayload = Object.assign({}, payload || {}, { action: action, token: token });
    if (options.noCache === true) {
      fullPayload.noCache = true;
    }

    const res = await fetch(GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(fullPayload),
      signal: controller.signal
    });

    if (!res.ok) {
      return { ok: false, data: null, error: `HTTP Error ${res.status}`, fromCache: false, cacheAgeMs: 0 };
    }

    // Bug 13: SW-кэш отмечает ответы из кэша кастомными заголовками.
    // Для constructed Response (которые SW возвращает) headers видны полностью.
    const fromCache = res.headers.get('X-SW-From-Cache') === '1';
    const cacheAgeMs = parseInt(res.headers.get('X-SW-Cache-Age-Ms') || '0', 10) || 0;

    let text;
    try {
      text = await res.text();
    } catch (e) {
      return { ok: false, data: null, error: 'Не удалось прочитать тело ответа сервера', fromCache, cacheAgeMs };
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      const preview = text ? text.substring(0, 100).replace(/\s+/g, ' ').trim() : '';
      return { ok: false, data: null, error: `Сервер вернул невалидный JSON: ${preview || '(пусто)'}`, fromCache, cacheAgeMs };
    }

    if (!data || typeof data !== 'object') {
      return { ok: false, data: null, error: 'Сервер вернул пустой ответ', fromCache, cacheAgeMs };
    }

    if (data.success === false) {
      return { ok: false, data: data, error: data.error || 'Неизвестная ошибка сервера', fromCache, cacheAgeMs };
    }

    return { ok: true, data: data, error: null, fromCache, cacheAgeMs };
  } catch (err) {
    if (err && err.name === 'AbortError') {
      return { ok: false, data: null, error: timeoutMessage, fromCache: false, cacheAgeMs: 0 };
    }
    return { ok: false, data: null, error: (err && err.message) || 'Сетевая ошибка', fromCache: false, cacheAgeMs: 0 };
  } finally {
    // Bug 4 fix: таймер снимается ТОЛЬКО после того, как тело прочитано
    // (или упало). Это гарантирует, что fetch + text() вместе укладываются
    // в timeoutMs.
    clearTimeout(timeoutId);
  }
}

/**
 * Получение всех данных БД.
 * Контракт: {success:true, data, fromCache, cacheAgeMs} / {success:false, error}. Не throws.
 */
export async function fetchAnalyticsData(opts) {
  const options = opts || {};
  const r = await postGas('get_all_data', {}, {
    timeoutMs: 15000,
    noCache: options.noCache === true
  });
  if (!r.ok) {
    console.warn('[API] Ошибка сети при получении данных:', r.error);
    return { success: false, error: r.error, fromCache: false, cacheAgeMs: 0 };
  }
  return {
    success: true,
    data: r.data,
    fromCache: r.fromCache || false,
    cacheAgeMs: r.cacheAgeMs || 0
  };
}

/**
 * Получение серверных логов отладки.
 * Контракт: logs[] / throws.
 */
export async function fetchServerDebugLogs() {
  const r = await postGas('get_debug_log', {}, { timeoutMs: 10000 });
  if (!r.ok) {
    throw new Error(`Ошибка чтения логов с сервера: ${r.error}`);
  }
  return (r.data && r.data.logs) || [];
}

/**
 * Отправка сетов и макро-сводки тренировки.
 * Контракт: data / throws.
 */
export async function syncSetsToSheets(payload) {
  const r = await postGas('sync_sets', payload, { timeoutMs: 20000 });
  if (!r.ok) {
    throw new Error(`Сетевой сбой при отправке: ${r.error}`);
  }
  return r.data;
}

/**
 * Облачное сохранение сгенерированного плана мезоцикла.
 * Контракт: {success:true, savedRows} / {success:false, error}. Не throws.
 */
export async function saveAiPlanToSheets(planData) {
  const r = await postGas('save_ai_plan', { plan: planData }, { timeoutMs: 15000 });
  if (!r.ok) {
    console.warn('[API] Не удалось сохранить план на лист AI_Plan:', r.error);
    return { success: false, error: r.error };
  }
  return r.data;
}

/**
 * Шлюз к Gemini через GAS Relay.
 * Контракт: answer (string) / throws.
 */
export async function askGasGeminiCoach(promptText) {
  const r = await postGas('ask_gemini_coach', { prompt: promptText }, {
    timeoutMs: 85000,
    timeoutMessage: 'Превышено время ожидания ответа ИИ-тренера (85 секунд). Проверьте интернет-соединение.'
  });
  if (!r.ok) {
    throw new Error(`Сбой связи с ИИ-тренером: ${r.error}`);
  }
  return r.data.answer;
}

/**
 * Обратная совместимость для аудита.
 */
export async function requestGeminiAudit(promptText) {
  return askGasGeminiCoach(promptText);
}
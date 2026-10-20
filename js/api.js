/**
 * =========================================================================
 * GYM ANALYTICS HUB — API LAYER (V2.0)
 * =========================================================================
 * V2.0 изменения:
 * - postGas() — единый транспорт. Все 6 функций стали тонкими обёртками.
 * - res.text() + JSON.parse с защитой: HTML-ответ GAS даёт осмысленную
 *   ошибку вместо "Unexpected token <" (аудит 3.5).
 * - Удалён _t: Date.now() — поле не участвовало в ключе кэша SW, только
 *   раздувало body.
 * - Контракты ошибок СОХРАНЕНЫ:
 *   * fetchAnalyticsData        → {success, data} / {success:false, error}
 *   * fetchServerDebugLogs      → logs[]              / throws
 *   * syncSetsToSheets          → data                / throws
 *   * saveAiPlanToSheets        → {success, savedRows} / {success:false}
 *   * askGasGeminiCoach         → string              / throws
 * =========================================================================
 */

export const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbydM_23SpEHmQyKmveDgw9vc_0_TRASZA-M444YPXcGffdDowR5RWaryrrgNg_YflNv/exec';

/**
 * Единственный транспорт к GAS. НИКОГДА не throws.
 *
 * @param {string} action - action в payload
 * @param {object} payload - тело запроса (без action и token)
 * @param {object} opts - {timeoutMs, timeoutMessage}
 * @returns {Promise<{ok:boolean, data:any, error:string|null}>}
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

    const res = await fetch(GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(fullPayload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      return { ok: false, data: null, error: `HTTP Error ${res.status}` };
    }

    let text;
    try {
      text = await res.text();
    } catch (e) {
      return { ok: false, data: null, error: 'Не удалось прочитать тело ответа сервера' };
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch (e) {
      const preview = text ? text.substring(0, 100).replace(/\s+/g, ' ').trim() : '';
      return { ok: false, data: null, error: `Сервер вернул невалидный JSON: ${preview || '(пусто)'}` };
    }

    if (!data || typeof data !== 'object') {
      return { ok: false, data: null, error: 'Сервер вернул пустой ответ' };
    }

    if (data.success === false) {
      return { ok: false, data: data, error: data.error || 'Неизвестная ошибка сервера' };
    }

    return { ok: true, data: data, error: null };
  } catch (err) {
    clearTimeout(timeoutId);
    if (err && err.name === 'AbortError') {
      return { ok: false, data: null, error: timeoutMessage };
    }
    return { ok: false, data: null, error: (err && err.message) || 'Сетевая ошибка' };
  }
}

/**
 * Получение всех данных БД.
 * Контракт: {success:true, data} / {success:false, error}. Не throws.
 */
export async function fetchAnalyticsData() {
  const r = await postGas('get_all_data', {}, { timeoutMs: 15000 });
  if (!r.ok) {
    console.warn('[API] Ошибка сети при получении данных:', r.error);
    return { success: false, error: r.error };
  }
  return { success: true, data: r.data };
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
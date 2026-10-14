export const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbydM_23SpEHmQyKmveDgw9vc_0_TRASZA-M444YPXcGffdDowR5RWaryrrgNg_YflNv/exec';

/**
 * Получение всех данных БД через POST с токеном в теле (защита от утечки в access-логи)
 */
export async function fetchAnalyticsData() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const token = localStorage.getItem('gym_api_token') || '';
    const payload = {
      action: 'get_all_data',
      token: token,
      _t: Date.now()
    };

    const res = await fetch(GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    const data = await res.json();
    if (data && data.success === false) {
      throw new Error(data.error || 'Ошибка сервера при получении данных');
    }
    return { success: true, data };
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn('[API] Ошибка сети при получении данных:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Получение серверных логов отладки с листа Debug_Log
 */
export async function fetchServerDebugLogs() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const token = localStorage.getItem('gym_api_token') || '';
    const payload = {
      action: 'get_debug_log',
      token: token,
      _t: Date.now()
    };

    const res = await fetch(GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    const json = await res.json();
    if (json && json.success === false) {
      throw new Error(json.error || 'Ошибка сервера при получении логов');
    }
    return json.logs || [];
  } catch (err) {
    clearTimeout(timeoutId);
    throw new Error(`Ошибка чтения логов с сервера: ${err.message}`);
  }
}

/**
 * Отправка сетов и макро-сводки тренировки в Google Sheets
 */
export async function syncSetsToSheets(payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const token = localStorage.getItem('gym_api_token') || '';
    const fullPayload = { ...payload, token };

    const res = await fetch(GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(fullPayload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`Сервер вернул статус HTTP ${res.status}`);
    }

    const data = await res.json().catch(() => {
      throw new Error('Сервер вернул невалидный JSON ответ');
    });

    if (!data.success) {
      throw new Error(data.error || 'Неизвестная ошибка синхронизации на сервере');
    }

    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    throw new Error(`Сетевой сбой при отправке: ${err.message}`);
  }
}

/**
 * Облачное сохранение сгенерированного плана мезоцикла на лист AI_Plan (TODO-07)
 */
export async function saveAiPlanToSheets(planData) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const token = localStorage.getItem('gym_api_token') || '';
    const payload = {
      action: 'save_ai_plan',
      plan: planData,
      token: token
    };

    const res = await fetch(GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    const data = await res.json();
    if (!data.success) {
      throw new Error(data.error || 'Ошибка сохранения плана на сервере');
    }
    return data;
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn('[API] Не удалось сохранить план на лист AI_Plan:', err.message);
    return { success: false, error: err.message };
  }
}

/**
 * Универсальный шлюз к Gemini через бессерверный Google Apps Script Relay (работает без VPN)
 */
export async function askGasGeminiCoach(promptText) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 85000);

  try {
    const token = localStorage.getItem('gym_api_token') || '';
    const payload = {
      action: 'ask_gemini_coach',
      prompt: promptText,
      token: token
    };

    const res = await fetch(GAS_API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`Сервер вернул статус HTTP ${res.status}`);
    }

    const data = await res.json().catch(() => {
      throw new Error('Сервер вернул невалидный JSON ответ');
    });

    if (!data.success) {
      throw new Error(data.error || 'Неизвестная ошибка на стороне GAS AI Relay');
    }

    return data.answer;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('Превышено время ожидания ответа ИИ-тренера (85 секунд). Проверьте интернет-соединение.');
    }
    throw new Error(`Сбой связи с ИИ-тренером: ${err.message}`);
  }
}

/**
 * Обратная совместимость для аудита
 */
export async function requestGeminiAudit(promptText) {
  return askGasGeminiCoach(promptText);
}
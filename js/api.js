import { state } from './state.js';

export const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbydM_23SpEHmQyKmveDgw9vc_0_TRASZA-M444YPXcGffdDowR5RWaryrrgNg_YflNv/exec';

export async function fetchAnalyticsData() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const timestamp = Date.now();
    const token = localStorage.getItem('gym_api_token') || '';
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
    const res = await fetch(`${GAS_API_URL}?action=get_all_data&_t=${timestamp}${tokenParam}`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    const data = await res.json();
    return { success: true, data };
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn('[API] Ошибка сети при получении данных:', err);
    return { success: false, error: err.message };
  }
}

export async function fetchServerDebugLogs() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const timestamp = Date.now();
    const token = localStorage.getItem('gym_api_token') || '';
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
    const res = await fetch(`${GAS_API_URL}?action=get_debug_log&_t=${timestamp}${tokenParam}`, {
      method: 'GET',
      cache: 'no-store',
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) throw new Error(`HTTP Error ${res.status}`);
    const json = await res.json();
    return json.logs || [];
  } catch (err) {
    clearTimeout(timeoutId);
    throw new Error(`Ошибка чтения логов с сервера: ${err.message}`);
  }
}

export async function syncSetsToSheets(payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const token = localStorage.getItem('gym_api_token') || '';
    const fullPayload = { ...payload, token };

    await fetch(GAS_API_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(fullPayload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return { success: true };
  } catch (err) {
    clearTimeout(timeoutId);
    throw new Error(`Сетевой сбой при отправке: ${err.message}`);
  }
}

/**
 * Универсальный шлюз к Gemini через Google Apps Script Relay (работает без VPN).
 * Таймаут расширен до 85 секунд с запасом на холодный старт и глубокую генерацию плана.
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
 * Обратная совместимость для существующей кнопки аудита в Analytics
 */
export async function requestGeminiAudit(promptText) {
  return askGasGeminiCoach(promptText);
}
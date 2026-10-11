import { state } from './state.js';

export const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbydM_23SpEHmQyKmveDgw9vc_0_TRASZA-M444YPXcGffdDowR5RWaryrrgNg_YflNv/exec';

export async function fetchAnalyticsData() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const timestamp = Date.now();
    const res = await fetch(`${GAS_API_URL}?action=get_all_data&_t=${timestamp}`, {
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
    const res = await fetch(`${GAS_API_URL}?action=get_debug_log&_t=${timestamp}`, {
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
    await fetch(GAS_API_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    return { success: true };
  } catch (err) {
    clearTimeout(timeoutId);
    throw new Error(`Сетевой сбой при отправке: ${err.message}`);
  }
}

export async function requestGeminiAudit(promptText) {
  const apiKey = state.geminiApiKey || localStorage.getItem('gym_gemini_api_key');
  if (!apiKey) {
    throw new Error('API ключ Gemini не задан в настройках.');
  }

  // Актуальный каскад моделей Google Generative AI с поддержкой v1beta
  const models = [
    'gemini-2.5-flash',
    'gemini-2.5-pro',
    'gemini-flash-latest'
  ];
  
  const errorsLog = [];

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        const detailedMsg = errJson.error?.message || `HTTP ${res.status}`;
        throw new Error(`[${model}] ${detailedMsg}`);
      }

      const json = await res.json();
      const answer = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (answer) return answer;
      throw new Error(`[${model}] Пустой ответ модели`);
    } catch (err) {
      console.warn(`[Gemini API] Ошибка модели:`, err.message);
      errorsLog.push(err.message);
    }
  }

  throw new Error(`Все модели Gemini вернули ошибки:\n${errorsLog.join('\n')}`);
}
import { state } from './state.js';

// URL Google Apps Script Web App
export const GAS_API_URL = 'https://script.google.com/macros/s/AKfycbwXyqZlDsl3L8P2aX4j1h4F-6B2iP9C3K7N/exec';

/**
 * Получение всех данных аналитики, каталога и циклов (GET)
 */
export async function fetchAnalyticsData() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const res = await fetch(`${GAS_API_URL}?action=get_all_data`, {
      method: 'GET',
      signal: controller.signal
    });
    clearTimeout(timeoutId);

    if (!res.ok) {
      throw new Error(`HTTP Error ${res.status}`);
    }

    const data = await res.json();
    return { success: true, data };
  } catch (err) {
    clearTimeout(timeoutId);
    console.warn('[API] Ошибка сети при получении данных:', err);
    return { success: false, error: err.message };
  }
}

/**
 * Отправка распарсенных сетов тренировки в Google Таблицы (POST no-cors)
 */
export async function syncSetsToSheets(payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    await fetch(GAS_API_URL, {
      method: 'POST',
      mode: 'no-cors',
      headers: {
        'Content-Type': 'text/plain;charset=utf-8'
      },
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

/**
 * Каскадный вызов моделей Gemini для спортивного аудита
 */
export async function requestGeminiAudit(promptText) {
  const apiKey = state.geminiApiKey || localStorage.getItem('gym_gemini_api_key');
  if (!apiKey) {
    throw new Error('API ключ Gemini не задан. Перейдите в настройки (шестеренка вверху) и укажите ключ.');
  }

  const models = [
    'gemini-2.5-flash',
    'gemini-1.5-flash',
    'gemini-2.0-flash'
  ];

  let lastError = null;

  for (const model of models) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }]
        })
      });

      if (!res.ok) {
        const errJson = await res.json().catch(() => ({}));
        throw new Error(errJson.error?.message || `HTTP ${res.status}`);
      }

      const json = await res.json();
      const answer = json.candidates?.[0]?.content?.parts?.[0]?.text;
      if (answer) {
        return answer;
      }
      throw new Error('Пустой ответ от модели');
    } catch (err) {
      console.warn(`[Gemini API] Модель ${model} вернула ошибку:`, err.message);
      lastError = err;
    }
  }

  throw new Error(`Все модели Gemini недоступны. Последняя ошибка: ${lastError?.message}`);
}
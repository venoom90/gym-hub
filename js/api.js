import { setDbData } from './state.js';

export const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxTZcV-jwhBx-iw9k4As42hNIyALSHfpERMter6CZ00NjzOPCo5AribVNHTT2RMqmRV/exec";

export async function fetchAnalyticsData() {
  try {
    const res = await fetch(`${APPS_SCRIPT_URL}?action=get_analytics`);
    const data = await res.json();
    setDbData(data);
    return { success: true, data };
  } catch (err) {
    console.error('Ошибка загрузки данных Apps Script:', err);
    return { success: false, error: err.message };
  }
}

export async function syncSetsToSheets(payload) {
  return await fetch(APPS_SCRIPT_URL, {
    method: 'POST',
    mode: 'no-cors',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify(payload)
  });
}

// Каскадный вызов Gemini API с перебором моделей
export async function requestGeminiAudit(promptText) {
  const apiKey = localStorage.getItem('gemini_api_key');
  if (!apiKey) {
    throw new Error('Ключ Gemini API не настроен в приложении');
  }

  const modelChain = [
    'gemini-2.5-flash',
    'gemini-1.5-flash',
    'gemini-2.0-flash'
  ];

  let lastErrorMessage = '';

  for (const model of modelChain) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: promptText }] }]
        })
      });

      const data = await response.json();

      if (data.candidates && data.candidates[0].content && data.candidates[0].content.parts[0].text) {
        return data.candidates[0].content.parts[0].text;
      }

      if (data.error) {
        lastErrorMessage = data.error.message || `Ошибка кода ${data.error.code}`;
        const isDemandIssue = data.error.code === 503 ||
                              data.error.code === 429 ||
                              lastErrorMessage.toLowerCase().includes('demand') ||
                              lastErrorMessage.toLowerCase().includes('overloaded');

        if (isDemandIssue) {
          console.warn(`[Gemini API] Модель ${model} перегружена (${lastErrorMessage}). Переключение...`);
          await new Promise(resolve => setTimeout(resolve, 1000));
          continue;
        }

        throw new Error(lastErrorMessage);
      }
    } catch (err) {
      lastErrorMessage = err.message;
      continue;
    }
  }

  throw new Error(`Все модели Gemini временно недоступны. Ответ: ${lastErrorMessage}`);
}

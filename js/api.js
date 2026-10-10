import { setDbData } from './state.js';

export const APPS_SCRIPT_URL = "https://script.google.com/macros/s/AKfycbxTZcV-jwhBx-iw9k4As42hNIyALSHfpERMter6CZ00NjzOPCo5AribVNHTT2RMqmRV/exec";

export async function fetchAnalyticsData() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  try {
    const res = await fetch(`${APPS_SCRIPT_URL}?action=get_analytics`, {
      signal: controller.signal
    });
    clearTimeout(timeoutId);
    const data = await res.json();
    setDbData(data);
    return { success: true, data };
  } catch (err) {
    clearTimeout(timeoutId);
    console.error('Ошибка загрузки данных Apps Script:', err);
    return { success: false, error: err.message };
  }
}

export async function syncSetsToSheets(payload) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 25000);

  try {
    // Очищаем payload от лишних полей перед отправкой через GET, чтобы уложиться в лимит URL
    const compactSets = (payload.sets || []).map(s => ({
      date: s.date,
      startTime: s.startTime,
      title: s.title,
      exercise: s.exercise,
      setNum: s.setNum,
      weight: s.weight,
      reps: s.reps,
      effort: s.effort || '',
      reserve: s.reserve || '',
      method: s.method || '',
      equipment: s.equipment || '',
      positioning: s.positioning || '',
      splitDay: s.splitDay || '',
      cycleMode: s.cycleMode || '',
      waveIndex: s.waveIndex || '',
      cycleWeek: s.cycleWeek || 1,
      category: s.category || 'Рабочий',
      tonnage: s.tonnage || 0,
      e1rm: s.e1rm || 0
    }));

    const compactPayload = {
      action: 'sync_sets',
      overwrite: payload.overwrite,
      date: payload.date,
      startTime: payload.startTime,
      sets: compactSets
    };

    const encodedData = encodeURIComponent(JSON.stringify(compactPayload));
    const url = `${APPS_SCRIPT_URL}?action=sync_sets_get&data=${encodedData}`;

    const res = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
    
    const result = await res.json();

    if (!result || result.success !== true) {
      const errMsg = (result && result.error) ? result.error : JSON.stringify(result);
      throw new Error(errMsg);
    }
    return result;
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('Превышено время ожидания сервера (25 сек).');
    }
    throw err;
  }
}

export async function requestGeminiAudit(promptText) {
  const apiKey = localStorage.getItem('gemini_api_key');
  if (!apiKey) throw new Error('Ключ Gemini API не настроен');

  const modelChain = ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-2.0-flash'];
  let lastErrorMessage = '';

  for (const model of modelChain) {
    try {
      const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ parts: [{ text: promptText }] }] })
      });

      const data = await response.json();
      if (data.candidates?.[0]?.content?.parts?.[0]?.text) {
        return data.candidates[0].content.parts[0].text;
      }
      if (data.error) {
        lastErrorMessage = data.error.message || `Ошибка ${data.error.code}`;
        await new Promise(r => setTimeout(r, 1000));
      }
    } catch (err) {
      lastErrorMessage = err.message;
    }
  }
  throw new Error(`Модели Gemini недоступны: ${lastErrorMessage}`);
}
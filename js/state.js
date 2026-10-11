/**
 * Единый источник правды (Single Source of Truth)
 * Изолированное хранилище состояния приложения и чистые утилиты нормализации
 */

export const state = {
  activeTab: 'overview',
  selectedCycleId: 'ALL',
  geminiApiKey: localStorage.getItem('gym_gemini_api_key') || '',
  isOnline: navigator.onLine,
  dbData: {
    sets: [],
    catalog: [],
    cycles: [],
    exercises: [],
    currentCycleId: 'C-1'
  },
  parsedWorkout: {
    title: '',
    date: '',
    startTime: '',
    sets: [],
    allExercises: []
  }
};

export function setActiveTab(tabName) {
  state.activeTab = tabName;
}

export function setSelectedCycle(cycleId) {
  state.selectedCycleId = cycleId;
}

export function setGeminiApiKey(key) {
  state.geminiApiKey = key ? key.trim() : '';
  if (state.geminiApiKey) {
    localStorage.setItem('gym_gemini_api_key', state.geminiApiKey);
  } else {
    localStorage.removeItem('gym_gemini_api_key');
  }
}

export function setDbData(data) {
  state.dbData = {
    sets: Array.isArray(data.sets) ? data.sets : [],
    catalog: Array.isArray(data.catalog) ? data.catalog : [],
    cycles: Array.isArray(data.cycles) ? data.cycles : [],
    exercises: Array.isArray(data.exercises) ? data.exercises : [],
    currentCycleId: data.currentCycleId || 'C-1'
  };
}

export function setParsedWorkout(workout) {
  state.parsedWorkout = workout || {
    title: '',
    date: '',
    startTime: '',
    sets: [],
    allExercises: []
  };
}

/**
 * Нормализация строковых чисел с запятой в Float
 */
export function parseRuFloat(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  const clean = String(val).replace(/\s+/g, '').replace(',', '.');
  const num = parseFloat(clean);
  return isNaN(num) ? 0 : num;
}

/**
 * Приведение любой даты к полудню локального времени (12:00) для защиты от часовых поясов
 */
export function normalizeDate(dateVal) {
  if (!dateVal) return null;
  if (dateVal instanceof Date) {
    const d = new Date(dateVal);
    d.setHours(12, 0, 0, 0);
    return isNaN(d.getTime()) ? null : d;
  }

  const str = String(dateVal).trim();
  // Формат DD.MM.YYYY
  const ruMatch = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (ruMatch) {
    const day = parseInt(ruMatch[1], 10);
    const month = parseInt(ruMatch[2], 10) - 1;
    const year = parseInt(ruMatch[3], 10);
    const d = new Date(year, month, day, 12, 0, 0, 0);
    return isNaN(d.getTime()) ? null : d;
  }

  // Формат YYYY-MM-DD
  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const year = parseInt(isoMatch[1], 10);
    const month = parseInt(isoMatch[2], 10) - 1;
    const day = parseInt(isoMatch[3], 10);
    const d = new Date(year, month, day, 12, 0, 0, 0);
    return isNaN(d.getTime()) ? null : d;
  }

  const fallback = new Date(str);
  if (!isNaN(fallback.getTime())) {
    fallback.setHours(12, 0, 0, 0);
    return fallback;
  }
  return null;
}

/**
 * Ключ даты для группировки YYYY-MM-DD
 */
export function getDateKey(dateVal) {
  const d = normalizeDate(dateVal);
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Форматирование для интерфейса: DD.MM.YYYY
 */
export function formatDateDisplay(dateVal) {
  const d = normalizeDate(dateVal);
  if (!d) return '';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}
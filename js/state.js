/**
 * Единый источник правды (Single Source of Truth)
 * Изолированное хранилище состояния приложения, Local-First гидратация и чистые утилиты нормализации
 */

function getInitialDbData() {
  const fallback = {
    sets: [],
    catalog: [],
    cycles: [],
    exercises: [],
    currentCycleId: 'C-1'
  };

  try {
    const raw = localStorage.getItem('gym_cached_db_data');
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return {
      sets: Array.isArray(parsed.sets) ? parsed.sets : [],
      catalog: Array.isArray(parsed.catalog) ? parsed.catalog : [],
      cycles: Array.isArray(parsed.cycles) ? parsed.cycles : [],
      exercises: Array.isArray(parsed.exercises) ? parsed.exercises : [],
      currentCycleId: parsed.currentCycleId || 'C-1'
    };
  } catch (e) {
    console.warn('[State] Ошибка гидратации кэша БД:', e);
    return fallback;
  }
}

export const state = {
  selectedCycleId: 'ALL',
  dbData: getInitialDbData(),
  parsedWorkout: {
    title: '',
    date: '',
    startTime: '',
    sets: [],
    allExercises: []
  }
};

export function setSelectedCycle(cycleId) {
  state.selectedCycleId = cycleId;
}

export function setDbData(data) {
  const safeData = data || {};
  state.dbData = {
    sets: Array.isArray(safeData.sets) ? safeData.sets : [],
    catalog: Array.isArray(safeData.catalog) ? safeData.catalog : [],
    cycles: Array.isArray(safeData.cycles) ? safeData.cycles : [],
    exercises: Array.isArray(safeData.exercises) ? safeData.exercises : [],
    currentCycleId: safeData.currentCycleId || 'C-1'
  };

  try {
    if (state.dbData.sets.length > 0) {
      localStorage.setItem('gym_cached_db_data', JSON.stringify(state.dbData));
    }
  } catch (e) {
    console.warn('[State] Не удалось сохранить кэш БД в localStorage:', e);
  }
}

// Экспорт алиаса для обратной совместимости
export const setInitialData = setDbData;

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
 * Санитизация HTML-строк для защиты от XSS при выводе в DOM
 */
export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Нормализация строковых чисел с запятой в Float с сохранением явного нуля
 */
export function parseRuFloat(val) {
  if (val === null || val === undefined || val === '') return 0.0;
  if (typeof val === 'number') return isNaN(val) ? 0.0 : val;
  const clean = String(val).replace(/\s+/g, '').replace(',', '.');
  const num = parseFloat(clean);
  return isNaN(num) ? 0.0 : num;
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
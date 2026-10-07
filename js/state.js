const SAVED_CYCLE_KEY = 'gym_selected_cycle_id';

export const state = {
  dbData: {
    sets: [],
    catalog: [],
    exercises: [],
    cycles: [],
    currentCycleId: 'C-1',
    cyclesSummary: []
  },
  selectedCycleId: localStorage.getItem(SAVED_CYCLE_KEY) || 'ALL',
  parsedWorkout: {
    title: '',
    date: '',
    startTime: '',
    sets: [],
    allExercises: []
  }
};

export function setDbData(newData) {
  state.dbData = {
    sets: newData.sets || [],
    catalog: newData.catalog || [],
    exercises: newData.exercises || [],
    cycles: newData.cycles || [],
    currentCycleId: newData.currentCycleId || 'C-1',
    cyclesSummary: newData.cyclesSummary || []
  };

  const saved = localStorage.getItem(SAVED_CYCLE_KEY);
  if (saved && (saved === 'ALL' || (state.dbData.cycles || []).includes(saved))) {
    state.selectedCycleId = saved;
  } else if (state.dbData.currentCycleId) {
    state.selectedCycleId = state.dbData.currentCycleId;
  }
}

export function setSelectedCycle(cycleId) {
  state.selectedCycleId = cycleId;
  try {
    localStorage.setItem(SAVED_CYCLE_KEY, cycleId);
  } catch (e) {
    console.warn('[State] Не удалось сохранить выбранный мезоцикл в localStorage:', e);
  }
}

export function setParsedWorkout(workoutData) {
  state.parsedWorkout = workoutData;
}

// Извлечение календарного ключа 'YYYY-MM-DD' в локальном времени
export function getDateKey(val) {
  if (!val) return '';
  
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return '';
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const str = String(val).trim();

  // 1. Формат ДД.ММ.ГГГГ (из отчетов GymUp и обновленного Apps Script)
  const ruMatch = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (ruMatch) {
    const y = ruMatch[3];
    const m = String(ruMatch[2]).padStart(2, '0');
    const d = String(ruMatch[1]).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  // 2. Если пришла ISO-строка с таймзоной (UTC): создаем Date и берем ЛОКАЛЬНЫЕ компоненты
  if (str.includes('T') || str.includes('Z')) {
    const dObj = new Date(str);
    if (!isNaN(dObj.getTime())) {
      const y = dObj.getFullYear();
      const m = String(dObj.getMonth() + 1).padStart(2, '0');
      const d = String(dObj.getDate()).padStart(2, '0');
      return `${y}-${m}-${d}`;
    }
  }

  // 3. Формат YYYY-MM-DD
  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const y = isoMatch[1];
    const m = String(isoMatch[2]).padStart(2, '0');
    const d = String(isoMatch[3]).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  const direct = new Date(str);
  if (!isNaN(direct.getTime())) {
    const y = direct.getFullYear();
    const m = String(direct.getMonth() + 1).padStart(2, '0');
    const d = String(direct.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }

  return '';
}

// Нормализация на локальный полдень (12:00) без сдвигов
export function normalizeDate(val) {
  const key = getDateKey(val);
  if (!key) return null;

  const parts = key.split('-');
  return new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 12, 0, 0);
}

export function formatDateDisplay(d) {
  if (!d) return '';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  return `${day}.${month}`;
}
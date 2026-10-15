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
    workouts: [],
    aiPlan: null,
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
      workouts: Array.isArray(parsed.workouts) ? parsed.workouts : [],
      aiPlan: parsed.aiPlan || null,
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
    workouts: Array.isArray(safeData.workouts) ? safeData.workouts : [],
    aiPlan: safeData.aiPlan || null,
    currentCycleId: safeData.currentCycleId || 'C-1'
  };

  try {
    // Защита от тихой перезаписи локального плана (P0 Fix)
    if (safeData.aiPlan && safeData.aiPlan.splits) {
      let shouldOverwriteLocal = true;
      try {
        const localRaw = localStorage.getItem('gym_ai_coach_plan');
        if (localRaw) {
          const localPlan = JSON.parse(localRaw);
          // Если у локального плана есть флаг неотправленности или он сгенерирован позже
          if (localPlan._pendingCloudSync) {
            shouldOverwriteLocal = false;
          } else if (localPlan.generatedAt && safeData.aiPlan.generatedAt && localPlan.generatedAt > safeData.aiPlan.generatedAt) {
            shouldOverwriteLocal = false;
          }
        }
      } catch (e) {}

      if (shouldOverwriteLocal) {
        localStorage.setItem('gym_ai_coach_plan', JSON.stringify(safeData.aiPlan));
      }
    }

    // Кэш сохраняется ВСЕГДА (даже если база стала пустой после удаления)
    localStorage.setItem('gym_cached_db_data', JSON.stringify(state.dbData));
  } catch (e) {
    console.warn('[State] Не удалось сохранить кэш БД в localStorage:', e);
  }
}

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

export function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function parseRuFloat(val) {
  if (val === null || val === undefined || val === '') return 0.0;
  if (typeof val === 'number') return isNaN(val) ? 0.0 : val;
  const clean = String(val).replace(/\s+/g, '').replace(',', '.');
  const num = parseFloat(clean);
  return isNaN(num) ? 0.0 : num;
}

/**
 * V5.1.3: Единый расчёт расчетного 1ПМ (e1RM) по формуле Эпли.
 *
 * КОНТРАКТ (синхронизирован с бэкендом GAS computeE1RM — при изменении
 * формулы обновлять ОБА места):
 *   - reps <= 0 или weight <= 0 → 0.0
 *   - reps === 1                → weight (фактический 1ПМ)
 *   - 2 ≤ reps ≤ 8              → weight × (1 + reps / 30)
 *   - reps > 8                  → 0.0 (Эпли даёт >10% погрешность)
 *
 * Возвращает округлённое до 1 знака после запятой число.
 *
 * Порог 8 повторений выбран сознательно: для силовых диапазонов (1-6) Эпли
 * работает приемлемо, на 8 — пограничная валидность, свыше 8 — формула
 * начинает систематически завышать результат на 10-15%. Честнее вернуть 0,
 * чем показывать атлету недостоверный PR.
 */
export function computeE1RM(weight, reps) {
  const w = (typeof weight === 'number') ? weight : parseRuFloat(weight);
  const r = (typeof reps === 'number') ? reps : (parseInt(reps, 10) || 0);

  if (w <= 0 || r <= 0) return 0.0;
  if (r === 1) return parseFloat(w.toFixed(1));
  if (r <= 8) return parseFloat((w * (1 + r / 30)).toFixed(1));
  return 0.0;
}

export function normalizeDate(dateVal) {
  if (!dateVal) return null;
  if (dateVal instanceof Date) {
    const d = new Date(dateVal);
    d.setHours(12, 0, 0, 0);
    return isNaN(d.getTime()) ? null : d;
  }

  const str = String(dateVal).trim();
  const ruMatch = str.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})/);
  if (ruMatch) {
    const day = parseInt(ruMatch[1], 10);
    const month = parseInt(ruMatch[2], 10) - 1;
    const year = parseInt(ruMatch[3], 10);
    const d = new Date(year, month, day, 12, 0, 0, 0);
    return isNaN(d.getTime()) ? null : d;
  }

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

export function getDateKey(dateVal) {
  const d = normalizeDate(dateVal);
  if (!d) return '';
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function formatDateDisplay(dateVal) {
  const d = normalizeDate(dateVal);
  if (!d) return '';
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  return `${day}.${month}.${year}`;
}
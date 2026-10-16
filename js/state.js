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

/* =========================================================================
 * MUSCLE LOAD ANALYZER (Шаг 2.2-new, V5.2.0)
 * -------------------------------------------------------------------------
 * Единая система порогов MEV/MAV/MRV по Mike Israetel (Scientific Principles
 * of Hypertrophy Training, 2023). Пороги заданы как средненедельные
 * RIR-взвешенные сеты на мышечную группу.
 *
 * isMaintenance: true → мышца тренируется в режиме поддержки (квадрицепс,
 * бицепс бедра, ягодичные при фуллбади с приоритетом верха). Целевой
 * диапазон: 2-5 сетов/нед. Пороги MEV/MAV/MRV для таких мышц не применяются.
 * ========================================================================= */

export const MUSCLE_THRESHOLDS = {
  'Грудь':           { mev: 8,  mavMin: 12, mavMax: 20, mrv: 22, isMaintenance: false },
  'Широчайшие':      { mev: 10, mavMin: 14, mavMax: 22, mrv: 25, isMaintenance: false },
  'Верх спины':      { mev: 10, mavMin: 14, mavMax: 22, mrv: 25, isMaintenance: false },
  'Средняя дельта':  { mev: 8,  mavMin: 16, mavMax: 22, mrv: 26, isMaintenance: false },
  'Передняя дельта': { mev: 6,  mavMin: 8,  mavMax: 14, mrv: 18, isMaintenance: false },
  'Задняя дельта':   { mev: 6,  mavMin: 12, mavMax: 20, mrv: 25, isMaintenance: false },
  'Трицепс':         { mev: 6,  mavMin: 10, mavMax: 16, mrv: 18, isMaintenance: false },
  'Бицепс':          { mev: 8,  mavMin: 14, mavMax: 20, mrv: 26, isMaintenance: false },
  'Квадрицепс':      { mev: 8,  mavMin: 12, mavMax: 18, mrv: 20, isMaintenance: true },
  'Бицепс бедра':    { mev: 6,  mavMin: 10, mavMax: 16, mrv: 20, isMaintenance: true },
  'Ягодичные':       { mev: 4,  mavMin: 8,  mavMax: 16, mrv: 20, isMaintenance: true },
  'Икры':            { mev: 8,  mavMin: 12, mavMax: 16, mrv: 20, isMaintenance: false }
};

export const MAINTENANCE_LOWER_BOUND = 2;
export const MAINTENANCE_UPPER_BOUND = 5;

/**
 * RIR-взвешивание подходов. Дифференцированная модель:
 *   - Компаунды (жим/тяга/присед): RIR 3 → 0.5, RIR 4+ → 0.25
 *   - Изоляция (разведения/сгибания/махи): RIR 3 → 0.6, RIR 4+ → 0.3
 *
 * Обоснование: на изоляции даже недоборные подходы дают заметный
 * локальный метаболический стимул (Refalo et al., 2023).
 *
 * @param {string} reserve — поле RIR из сета (например, "+2", "+3")
 * @param {boolean} isIsolation — true для изоляционных упражнений
 * @returns {number} коэффициент 0..1
 */
export function rirWeight(reserve, isIsolation) {
  const clean = String(reserve || '').trim().replace(/^\+/, '');
  const r = parseFloat(clean);
  if (isNaN(r)) return 1.0;
  if (r <= 1) return 1.0;
  if (r === 2) return 0.85;
  if (r === 3) return isIsolation ? 0.6 : 0.5;
  return isIsolation ? 0.3 : 0.25;
}

/**
 * Классификация упражнения как изоляция/компаунд по эвристике имени.
 * Компаунды: жим, тяга, присед, становая, подтягивания, отжимания, брусья.
 * Изоляция: разведения, махи, сгибания, разгибания, французский, пуловер и т.д.
 */
export function isIsolationExercise(exerciseName) {
  const n = String(exerciseName || '').toLowerCase();
  const compoundPatterns = ['жим', 'тяга', 'присед', 'становая', 'подтягиван', 'отжиман', 'брусь'];
  for (let i = 0; i < compoundPatterns.length; i++) {
    if (n.includes(compoundPatterns[i])) return false;
  }
  const isolationPatterns = [
    'разведен', 'махи', 'сгибан', 'разгибан', 'концентрирован',
    'молитв', 'кикбэк', 'француз', 'пуловер', 'подъём на носки', 'подъем на носки'
  ];
  for (let i = 0; i < isolationPatterns.length; i++) {
    if (n.includes(isolationPatterns[i])) return true;
  }
  return false;
}

/**
 * Проверка: относится ли сет к делоад-фазе.
 * Учитывает cycleWeek >= 5 и cycleMode 'Делоад' / 'Разгрузка'.
 */
export function isDeloadSet(cycleWeek, cycleMode) {
  const w = parseInt(cycleWeek, 10) || 1;
  const m = String(cycleMode || '').trim();
  return w >= 5 || m === 'Делоад' || m === 'Разгрузка' || m === 'Делоад/Разгрузка';
}

/**
 * Возвращает ID предыдущего мезоцикла (C-N → C-(N-1)).
 * Возвращает null, если цикл C-1 или формат некорректен.
 */
export function getPreviousCycleId(cycleId) {
  const m = String(cycleId || '').match(/[CcСсЦц]-(\d+)/);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  return n > 1 ? ('C-' + (n - 1)) : null;
}

/**
 * Классификация состояния мышцы по её недельному RIR-взвешенному объёму.
 * Возвращает объект { status, label }:
 *   - lagging (ниже MEV)
 *   - optimal (в диапазоне MEV..MRV)
 *   - overload (выше MRV)
 *   - maintenance-low / maintenance-ok / maintenance-high
 */
export function classifyMuscleState(weeklyVolume, thresholds) {
  if (!thresholds) return { status: 'unknown', label: 'Не размечено' };
  if (thresholds.isMaintenance) {
    if (weeklyVolume < MAINTENANCE_LOWER_BOUND) return { status: 'maintenance-low', label: 'Maintenance (ниже)' };
    if (weeklyVolume <= MAINTENANCE_UPPER_BOUND) return { status: 'maintenance-ok', label: 'Maintenance (Цель)' };
    return { status: 'maintenance-high', label: 'Выше Maintenance' };
  }
  if (weeklyVolume < thresholds.mev) return { status: 'lagging', label: 'ЛАГАЕТ' };
  if (weeklyVolume <= thresholds.mrv) return { status: 'optimal', label: 'ОПТИМАЛЬНО' };
  return { status: 'overload', label: 'MRV (Перегруз)' };
}

/**
 * Рекомендации по конкретному упражнению для добавления объёма
 * отстающей мышечной группы.
 */
export const MUSCLE_ADVICE = {
  'Грудь':           'жим в тренажере или сведение рук',
  'Широчайшие':      'тяга верхнего блока или подтягивания',
  'Верх спины':      'шраги или тяга к поясу',
  'Средняя дельта':  'махи в стороны',
  'Передняя дельта': 'жим гантелей сидя',
  'Задняя дельта':   'reverse fly / разведения в наклоне',
  'Трицепс':         'разгибания на блоке или французский жим',
  'Бицепс':          'сгибания с супинацией или молот',
  'Квадрицепс':      'жим ногами или разгибания',
  'Бицепс бедра':    'сгибания ног лежа или румынская тяга',
  'Ягодичные':       'ягодичный мост или гиперэкстензия',
  'Икры':            'подъёмы на носки стоя'
};
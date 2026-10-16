import {
  state, normalizeDate, formatDateDisplay, getDateKey, escapeHtml, isMaintenanceRir,
  getLastSetFieldForExercise
} from './state.js';
import { extractPeriodization } from './parser.js';
import { startNewLiveWorkout } from './live_workout.js';
import { registerModal, openModal, closeModal } from './modal_manager.js';

let isOverviewInitialized = false;
let latestPreparedWorkoutPayload = null;
let cachedBothSplitsPayloads = { A: null, B: null };
let activeModalSplitKey = 'A';

// V5.3.0: Навигация по календарю
let calendarBaseDate = null;
let calMonthViewDate = new Date();

function getCalendarBaseDate() {
  if (!calendarBaseDate) {
    calendarBaseDate = new Date();
    calendarBaseDate.setHours(12, 0, 0, 0);
  }
  return calendarBaseDate;
}

export function renderOverviewModule() {
  initOverviewModalListeners();
  renderCalendarStrip();
  renderAiRecipeCard();
  renderMuscleMannequin();
}

function initOverviewModalListeners() {
  if (isOverviewInitialized) return;

  // === V5.4.0: регистрация модалов через ModalManager ===
  const dayModal = document.getElementById('daySummaryModal');
  if (dayModal) {
    registerModal('daySummaryModal', { el: dayModal, displayStyle: 'flex' });
    const closeDayBtn = document.getElementById('closeDaySummaryModalBtn');
    if (closeDayBtn) closeDayBtn.onclick = () => closeModal('daySummaryModal');
    dayModal.onclick = (e) => { if (e.target === dayModal) closeModal('daySummaryModal'); };
  }

  const planModal = document.getElementById('workoutPlanDetailsModal');
  if (planModal) {
    registerModal('workoutPlanDetailsModal', { el: planModal, displayStyle: 'flex' });
    const closePlanBtn = document.getElementById('closeWorkoutPlanModalBtn');
    if (closePlanBtn) closePlanBtn.onclick = () => closeModal('workoutPlanDetailsModal');
    planModal.onclick = (e) => { if (e.target === planModal) closeModal('workoutPlanDetailsModal'); };
  }

  const calModal = document.getElementById('calendarMonthModal');
  if (calModal) {
    registerModal('calendarMonthModal', { el: calModal, displayStyle: 'flex' });
    const closeCalBtn = document.getElementById('closeCalendarMonthBtn');
    if (closeCalBtn) closeCalBtn.onclick = () => closeModal('calendarMonthModal');
    calModal.onclick = (e) => { if (e.target === calModal) closeModal('calendarMonthModal'); };
  }

  // === Кнопки/связки ===
  const previewCard = document.getElementById('overviewPlanPreviewCard');
  if (previewCard) previewCard.onclick = () => openWorkoutPlanDetailsModal();

  const modalTabA = document.getElementById('modalPlanTabA');
  const modalTabB = document.getElementById('modalPlanTabB');
  if (modalTabA && modalTabB) {
    modalTabA.onclick = () => {
      activeModalSplitKey = 'A';
      modalTabA.classList.add('active');
      modalTabB.classList.remove('active');
      renderModalSplitExercises(cachedBothSplitsPayloads.A || latestPreparedWorkoutPayload);
    };
    modalTabB.onclick = () => {
      activeModalSplitKey = 'B';
      modalTabB.classList.add('active');
      modalTabA.classList.remove('active');
      renderModalSplitExercises(cachedBothSplitsPayloads.B || latestPreparedWorkoutPayload);
    };
  }

  const modalStartBtn = document.getElementById('modalStartLiveWorkoutBtn');
  if (modalStartBtn) {
    modalStartBtn.onclick = () => {
      closeModal('workoutPlanDetailsModal');
      const chosenPayload = cachedBothSplitsPayloads[activeModalSplitKey] || latestPreparedWorkoutPayload;
      startNewLiveWorkout(chosenPayload);
    };
  }

  const startLiveBtn = document.getElementById('startLiveWorkoutBtn');
  if (startLiveBtn) startLiveBtn.onclick = () => startNewLiveWorkout(latestPreparedWorkoutPayload);

  // === Календарь месяца ===
  initCalendarMonthModalListeners();

  isOverviewInitialized = true;
}

/* =========================================================================
 * КАЛЕНДАРЬ МЕСЯЦА
 * ========================================================================= */

function initCalendarMonthModalListeners() {
  const openCalBtn = document.getElementById('openCalendarMonthBtn');
  const prevBtn = document.getElementById('calMonthPrevBtn');
  const nextBtn = document.getElementById('calMonthNextBtn');
  const todayBtn = document.getElementById('calMonthTodayBtn');

  if (openCalBtn) openCalBtn.onclick = () => openCalendarMonthModal();

  if (prevBtn) {
    prevBtn.onclick = () => {
      calMonthViewDate = new Date(calMonthViewDate.getFullYear(), calMonthViewDate.getMonth() - 1, 1);
      renderCalendarMonthModal();
    };
  }
  if (nextBtn) {
    nextBtn.onclick = () => {
      calMonthViewDate = new Date(calMonthViewDate.getFullYear(), calMonthViewDate.getMonth() + 1, 1);
      renderCalendarMonthModal();
    };
  }
  if (todayBtn) {
    todayBtn.onclick = () => {
      calendarBaseDate = new Date();
      calendarBaseDate.setHours(12, 0, 0, 0);
      closeModal('calendarMonthModal');
      renderCalendarStrip();
    };
  }
}

function openCalendarMonthModal() {
  const base = getCalendarBaseDate();
  calMonthViewDate = new Date(base.getFullYear(), base.getMonth(), 1);
  renderCalendarMonthModal();
  openModal('calendarMonthModal');
}

function getCycleInfoForDate(dateKey) {
  const set = (state.dbData.sets || []).find(s =>
    getDateKey(s.date) === dateKey && s.category === 'Рабочий'
  );
  if (!set) return null;

  const week = parseInt(set.cycleWeek, 10) || 1;
  const mode = String(set.cycleMode || 'Сила').trim();
  const isDeload = (week >= 5 || mode === 'Делоад' || mode === 'Разгрузка');

  if (isDeload) return { digit: 'Д', dotClass: 'mode-deload', week, mode: 'Делоад' };
  if (mode === 'Объем' || mode === 'Объём') return { digit: String(week), dotClass: 'mode-volume', week, mode: 'Объём' };
  return { digit: String(week), dotClass: 'mode-force', week, mode: 'Сила' };
}

function renderCalendarMonthModal() {
  const titleEl = document.getElementById('calMonthTitle');
  const gridEl = document.getElementById('calMonthGrid');
  if (!titleEl || !gridEl) return;

  const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
                      'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];

  const y = calMonthViewDate.getFullYear();
  const m = calMonthViewDate.getMonth();
  titleEl.innerText = `${monthNames[m]} ${y}`;

  const firstDay = new Date(y, m, 1);
  const lastDay = new Date(y, m + 1, 0);
  const startWeekday = (firstDay.getDay() + 6) % 7;

  const todayKey = getDateKey(new Date());
  const baseKey = getDateKey(getCalendarBaseDate());

  gridEl.innerHTML = '';

  for (let i = 0; i < startWeekday; i++) {
    const blank = document.createElement('div');
    blank.className = 'cal-day-blank';
    gridEl.appendChild(blank);
  }

  for (let d = 1; d <= lastDay.getDate(); d++) {
    const dayDate = new Date(y, m, d, 12, 0, 0, 0);
    const dayKey = getDateKey(dayDate);
    const isToday = (dayKey === todayKey);
    const isSelected = (dayKey === baseKey);
    const info = getCycleInfoForDate(dayKey);

    const cell = document.createElement('button');
    cell.type = 'button';
    cell.className = 'cal-day-cell';
    if (isToday) cell.classList.add('cal-day-current');
    if (isSelected) cell.classList.add('cal-day-selected');

    let ariaParts = [`${d} ${monthNames[m]} ${y}`];
    if (info) ariaParts.push(`Неделя ${info.week}, ${info.mode}`);
    cell.setAttribute('aria-label', ariaParts.join(', '));

    let inner = `<span>${d}</span>`;
    if (info) {
      inner += `<span class="cal-day-week">${info.digit}<span class="cal-day-dot ${info.dotClass}"></span></span>`;
    }
    cell.innerHTML = inner;

    cell.onclick = () => {
      calendarBaseDate = new Date(dayDate);
      closeModal('calendarMonthModal');
      renderCalendarStrip();
    };

    gridEl.appendChild(cell);
  }
}

/* =========================================================================
 * РАЗМИНКА
 * ========================================================================= */

function roundToGymStep(weight) {
  if (!weight || weight <= 0) return 0;
  return Math.round(weight / 2.5) * 2.5;
}

function buildWarmupStepsArray(order, targetWeight, cycleMode = 'Сила') {
  if (!targetWeight || targetWeight <= 30) {
    return [{ weight: Math.max(10, roundToGymStep(targetWeight * 0.6)), reps: 8 }];
  }

  if (cycleMode === 'Делоад' || cycleMode === 'Разгрузка') {
    const deloadStep = roundToGymStep(targetWeight * 0.6);
    return [{ weight: deloadStep, reps: 8 }];
  }

  if (order === 1) {
    return [
      { weight: roundToGymStep(targetWeight * 0.50), reps: 8 },
      { weight: roundToGymStep(targetWeight * 0.75), reps: 3 },
      { weight: roundToGymStep(targetWeight * 0.90), reps: 1 }
    ];
  }

  if (order === 2) {
    return [
      { weight: roundToGymStep(targetWeight * 0.60), reps: 5 },
      { weight: roundToGymStep(targetWeight * 0.85), reps: 2 }
    ];
  }

  return [
    { weight: roundToGymStep(targetWeight * 0.65), reps: 5 }
  ];
}

function calculateWarmupRamp(order, targetWeight, cycleMode = 'Сила') {
  if (!targetWeight || targetWeight <= 30) {
    return '1 легкий подход (по самочувствию)';
  }

  const steps = buildWarmupStepsArray(order, targetWeight, cycleMode);
  if (cycleMode === 'Делоад' || cycleMode === 'Разгрузка') {
    return `1 легкий подход × ${steps[0].weight} кг (${steps[0].reps} повт.)`;
  }

  if (order === 1 && steps.length === 3) {
    return `${steps[0].weight} кг × ${steps[0].reps} → ${steps[1].weight} кг × ${steps[1].reps} → ${steps[2].weight} кг × ${steps[2].reps} (активация)`;
  }

  if (order === 2 && steps.length === 2) {
    return `${steps[0].weight} кг × ${steps[0].reps} → ${steps[1].weight} кг × ${steps[1].reps}`;
  }

  return `1 калибровочный сет × ${steps[0].weight} кг (${steps[0].reps} повт.)`;
}

/* =========================================================================
 * КАЛЕНДАРЬ 7 ДНЕЙ
 * ========================================================================= */

function renderCalendarStrip() {
  const container = document.getElementById('calendarStripContainer');
  const rangeLabel = document.getElementById('calendarWeekRange');
  if (!container) return;
  container.innerHTML = '';

  const base = getCalendarBaseDate();
  const baseKey = getDateKey(base);

  const days = [];
  for (let i = -3; i <= 3; i++) {
    const d = new Date(base);
    d.setDate(d.getDate() + i);
    days.push(d);
  }

  if (rangeLabel && days.length > 0) {
    rangeLabel.innerText = `${formatDateDisplay(days[0])} — ${formatDateDisplay(days[6])}`;
  }

  const dayNames = ['Вс', 'Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб'];

  const sessionDatesMap = {};
  (state.dbData.sets || []).forEach(s => {
    const key = getDateKey(s.date);
    if (!key) return;

    const isWork = (s.category === 'Рабочий') && (s.effort !== 'Размин.');

    if (!sessionDatesMap[key]) {
      const p = extractPeriodization(s.workout);
      sessionDatesMap[key] = {
        split: s.splitDay || p.splitDay || 'А',
        workout: s.workout || 'Тренировка',
        setsCount: 0,
        tonnage: 0,
        exercisesMap: {}
      };
    }
    
    if (isWork) {
      sessionDatesMap[key].setsCount++;
      sessionDatesMap[key].tonnage += (s.tonnage || 0);

      const exName = (s.exercise || 'Упражнение').trim();
      if (!sessionDatesMap[key].exercisesMap[exName]) {
        sessionDatesMap[key].exercisesMap[exName] = {
          sets: 0,
          maxWeight: 0,
          bestReps: 0
        };
      }
      sessionDatesMap[key].exercisesMap[exName].sets++;
      const w = parseFloat(s.weight) || 0;
      const r = parseInt(s.reps, 10) || 0;
      if (w >= sessionDatesMap[key].exercisesMap[exName].maxWeight) {
        sessionDatesMap[key].exercisesMap[exName].maxWeight = w;
        sessionDatesMap[key].exercisesMap[exName].bestReps = r;
      }
    }
  });

  days.forEach(day => {
    const key = getDateKey(day);
    const isBase = (key === baseKey);
    const session = sessionDatesMap[key];

    const card = document.createElement('div');
    card.className = `calendar-day-card ${isBase ? 'today' : ''}`;

    let badgeHtml = '<div class="badge-rest"></div>';
    if (session && session.setsCount > 0) {
      const badgeClass = (session.split === 'А' || session.split === 'A') ? 'badge-split-a' : 'badge-split-b';
      badgeHtml = `<div class="cal-badge ${badgeClass}">${escapeHtml(session.split)}</div>`;
    }

    card.innerHTML = `
      <span class="cal-day-name">${dayNames[day.getDay()]}</span>
      <span class="cal-day-num">${day.getDate()}</span>
      ${badgeHtml}
    `;

    card.addEventListener('click', () => {
      openDaySummaryModal(day, session);
    });

    container.appendChild(card);
  });
}

function openDaySummaryModal(date, session) {
  const title = document.getElementById('modalDayDate');
  const content = document.getElementById('modalDayContent');
  if (!title || !content) return;

  title.innerText = `${formatDateDisplay(date)} (${date.toLocaleDateString('ru-RU', { weekday: 'long' })})`;

  if (session && session.setsCount > 0) {
    const exEntries = Object.entries(session.exercisesMap || {});
    const exListHtml = exEntries.map(([name, info], idx) => `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:6px 10px; background:var(--md-sys-color-surface-container-high); border-radius:8px; font-size:0.82rem;">
        <span style="color:var(--md-sys-color-on-surface); font-weight:500;">${idx + 1}. ${escapeHtml(name)}</span>
        <span style="color:var(--md-sys-color-primary); font-weight:700; white-space:nowrap; margin-left:8px;">${info.maxWeight} кг × ${info.bestReps} (${info.sets} с.)</span>
      </div>
    `).join('');

    content.innerHTML = `
      <div style="font-weight: 700; font-size: 0.95rem; color: var(--md-sys-color-primary);">${escapeHtml(session.workout)}</div>
      <div style="display:flex; gap:12px; flex-wrap:wrap; font-size:0.84rem;">
        <span><b>Сплит:</b> День ${escapeHtml(session.split)}</span>
        <span><b>Рабочих сетов:</b> ${session.setsCount}</span>
        <span><b>Тоннаж:</b> ${(session.tonnage / 1000).toFixed(2)} т</span>
      </div>
      <div style="display:flex; flex-direction:column; gap:6px; margin-top:4px;">
        <div style="font-size:0.75rem; font-weight:700; text-transform:uppercase; color:var(--md-sys-color-on-surface-variant);">Выполненные упражнения:</div>
        ${exListHtml}
      </div>
    `;
  } else {
    content.innerHTML = `<div style="color: var(--md-sys-color-on-surface-variant);">В этот день тренировок не зафиксировано (день отдыха и суперкомпенсации).</div>`;
  }

  openModal('daySummaryModal');
}

/* =========================================================================
 * MAINTENANCE / PREPARE PAYLOAD
 * ========================================================================= */

function isMaintenanceExercise(ex, muscle) {
  const m = String(muscle || '').toLowerCase();
  const isLegGroup = (m.includes('квадрицепс') || m.includes('бедр') || m.includes('ягодиц'));
  if (!isLegGroup) return false;

  const notes = String(ex.notes || '').toLowerCase();
  const hasMaintNote = notes.includes('поддерж') || notes.includes('maintenance');
  const hasMaintRir = isMaintenanceRir(ex.rir);

  return hasMaintNote || hasMaintRir;
}

function prepareSplitPayloadFromAiPlan(splitObj, splitLetter, cycleId, cycleMode, waveIndex, cycleWeek, catalogMap) {
  if (!splitObj || !Array.isArray(splitObj.exercises)) return null;

  const preparedExercises = [];
  const targetMusclesList = [];

  const dynamicTitle = (cycleMode === 'Делоад' || cycleMode === 'Разгрузка')
    ? `Тренировка ${splitLetter} Делоад ${cycleId}`
    : `Тренировка ${splitLetter}${waveIndex} ${cycleMode} ${cycleId}`;

  splitObj.exercises.forEach((ex, idx) => {
    const catItem = catalogMap[(ex.name || '').trim()];
    const muscle = (catItem && catItem.primaryMuscle) ? catItem.primaryMuscle : (ex.target || '');
    if (muscle && !targetMusclesList.includes(muscle)) {
      targetMusclesList.push(muscle);
    }

    const orderNum = parseInt(ex.order, 10) || (idx + 1);
    const baseWeight = parseFloat(ex.weight) || 0;
    const baseSets = parseInt(ex.sets, 10) || 3;
    const baseReps = String(ex.reps || '6-8');
    const baseRir = String(ex.rir || '+1..+2');
    const baseMethod = String(ex.method || 'Стандарт');
    const isMaint = isMaintenanceExercise(ex, muscle);

    let calculatedWeight = baseWeight;
    let finalSets = baseSets;
    let finalReps = baseReps;
    let finalRir = baseRir;
    let finalMethod = baseMethod;

    if (cycleMode === 'Делоад' || cycleMode === 'Разгрузка') {
      calculatedWeight = roundToGymStep(baseWeight * 0.65);
      finalSets = 2;
      finalReps = '8-10';
      finalRir = '+3..+4';
      finalMethod = 'Стандарт';
    } else if (cycleMode === 'Объем') {
      if (isMaint) {
        calculatedWeight = baseWeight;
        finalSets = baseSets;
        finalReps = baseReps;
        finalRir = baseRir;
        finalMethod = 'Стандарт';
      } else {
        calculatedWeight = roundToGymStep(baseWeight * 0.75);
        finalReps = '12-16';
        finalRir = '+2..+3';
        if (baseMethod.toLowerCase().includes('кластер')) {
          finalMethod = 'Стандарт';
        }
      }
    } else {
      if (String(waveIndex) === '2' && !isMaint && baseWeight >= 50) {
        calculatedWeight = roundToGymStep(baseWeight + 2.5);
      } else {
        calculatedWeight = roundToGymStep(baseWeight);
      }
      finalSets = baseSets;
      finalReps = baseReps;
      finalRir = baseRir;
      finalMethod = baseMethod;
    }

    const warmupRampText = calculateWarmupRamp(orderNum, calculatedWeight, cycleMode);
    const warmupSteps = buildWarmupStepsArray(orderNum, calculatedWeight, cycleMode);

    preparedExercises.push({
      order: orderNum,
      name: ex.name || 'Упражнение',
      target: muscle,
      weight: calculatedWeight,
      sets: finalSets,
      reps: finalReps,
      rir: finalRir,
      method: finalMethod,
      warmupText: warmupRampText,
      warmupSteps: warmupSteps,
      notes: ex.notes ? String(ex.notes) : ''
    });
  });

  return {
    title: dynamicTitle,
    cycleId: cycleId,
    splitDay: splitLetter,
    cycleMode: cycleMode,
    waveIndex: waveIndex,
    cycleWeek: cycleWeek,
    targetMuscles: targetMusclesList,
    exercises: preparedExercises
  };
}

/* =========================================================================
 * ПЛАН ТРЕНИРОВКИ
 * ========================================================================= */

function renderAiRecipeCard() {
  const sets = state.dbData.sets || [];
  const catalog = state.dbData.catalog || [];
  const previewTitleEl = document.getElementById('overviewPlanPreviewTitle');
  const previewMetricsEl = document.getElementById('overviewPlanPreviewMetrics');

  const catalogMap = {};
  catalog.forEach(item => {
    if (item && item.name) catalogMap[item.name.trim()] = item;
  });

  let nextSplit = 'А';
  let nextWeek = 1;
  let nextMode = 'Сила';
  let nextWave = '1';
  let nextCycleId = state.dbData.currentCycleId || 'C-1';
  let isNewCycleTransition = false;

  if (sets.length > 0) {
    const sortedSets = [...sets].sort((a, b) => {
      const da = normalizeDate(a.date);
      const db = normalizeDate(b.date);
      return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
    });

    const latestSet = sortedSets[0];
    const fallbackParsed = extractPeriodization(latestSet.workout);

    let currentWeek = parseInt(latestSet.cycleWeek || fallbackParsed.cycleWeek, 10) || 1;
    let currentMode = latestSet.cycleMode || fallbackParsed.cycleMode || 'Сила';
    let currentSplit = (latestSet.splitDay || fallbackParsed.splitDay || 'А').toUpperCase();
    let currentWave = String(latestSet.waveIndex || fallbackParsed.waveIndex || '1');
    let currentCycleId = latestSet.cycleId || state.dbData.currentCycleId || 'C-1';

    const lastWorkoutTitle = String(latestSet.workout || '').toLowerCase();
    if (lastWorkoutTitle.includes('разгруз') || lastWorkoutTitle.includes('делоад') || lastWorkoutTitle.includes('deload')) {
      currentMode = 'Делоад';
      currentWeek = 5;
    }

    if (currentSplit === 'А' || currentSplit === 'A') {
      nextSplit = 'Б';
      nextWeek = currentWeek;
      nextMode = currentMode;
      nextWave = currentWave;
      nextCycleId = currentCycleId;
    } else {
      if (currentMode === 'Делоад' || currentWeek >= 5) {
        nextSplit = 'А';
        nextWeek = 1;
        nextMode = 'Сила';
        nextWave = '1';
        isNewCycleTransition = true;

        const cycleNumMatch = currentCycleId.match(/\d+/);
        const nextNum = cycleNumMatch ? (parseInt(cycleNumMatch[0], 10) + 1) : 2;
        nextCycleId = `C-${nextNum}`;
      } else {
        nextSplit = 'А';
        nextWeek = currentWeek + 1;
        nextCycleId = currentCycleId;
        if (nextWeek === 2) { nextMode = 'Объем'; nextWave = '1'; }
        else if (nextWeek === 3) { nextMode = 'Сила'; nextWave = '2'; }
        else if (nextWeek === 4) { nextMode = 'Объем'; nextWave = '2'; }
        else if (nextWeek >= 5) { nextMode = 'Делоад'; nextWave = 'Делоад'; }
      }
    }
  }

  const nextTitle = (nextMode === 'Делоад' || nextMode === 'Разгрузка')
    ? `Тренировка ${nextSplit} Делоад ${nextCycleId}`
    : `Тренировка ${nextSplit}${nextWave} ${nextMode} ${nextCycleId}`;

  activeModalSplitKey = (nextSplit === 'А' || nextSplit === 'A') ? 'A' : 'B';
  cachedBothSplitsPayloads = { A: null, B: null };

  try {
    const rawAiPlan = localStorage.getItem('gym_ai_coach_plan');
    if (rawAiPlan) {
      const parsedPlan = JSON.parse(rawAiPlan);
      if (parsedPlan && parsedPlan.splits) {
        if (parsedPlan.splits.A) {
          cachedBothSplitsPayloads.A = prepareSplitPayloadFromAiPlan(
            parsedPlan.splits.A, 'А', nextCycleId, nextMode, nextWave, nextWeek, catalogMap
          );
        }
        if (parsedPlan.splits.B) {
          cachedBothSplitsPayloads.B = prepareSplitPayloadFromAiPlan(
            parsedPlan.splits.B, 'Б', nextCycleId, nextMode, nextWave, nextWeek, catalogMap
          );
        }
      }
    }
  } catch (err) {
    console.warn('[Overview] Не удалось распарсить сохраненный план ИИ:', err);
  }

  const activeAiSplitPayload = cachedBothSplitsPayloads[activeModalSplitKey];

  if (activeAiSplitPayload && activeAiSplitPayload.exercises.length > 0) {
    latestPreparedWorkoutPayload = activeAiSplitPayload;
    updatePlanPreviewCardUI(activeAiSplitPayload);
    return;
  }

  if (sets.length === 0) {
    if (previewTitleEl) previewTitleEl.innerText = 'План еще не сформирован';
    if (previewMetricsEl) previewMetricsEl.innerText = 'Сгенерируйте план во вкладке «Тренер»';
    return;
  }

  const sortedSets = [...sets].sort((a, b) => {
    const da = normalizeDate(a.date);
    const db = normalizeDate(b.date);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  });

  const prevSplitSets = sortedSets.filter(s => {
    const sSplit = (s.splitDay || extractPeriodization(s.workout).splitDay || '').toUpperCase();
    return sSplit === nextSplit;
  });

  if (prevSplitSets.length === 0) {
    if (previewTitleEl) previewTitleEl.innerText = `День ${nextSplit} — нет истории`;
    if (previewMetricsEl) previewMetricsEl.innerText = 'Сгенерируйте план во вкладке «Тренер»';
    return;
  }

  const latestSplitDate = prevSplitSets[0].date;
  const targetSessionSets = prevSplitSets.filter(s => s.date === latestSplitDate);

  const targetExercises = [];
  targetSessionSets.forEach(s => {
    if (s.exercise && !targetExercises.includes(s.exercise)) {
      targetExercises.push(s.exercise);
    }
  });

  const targetMusclesList = [];
  targetExercises.forEach(exName => {
    const catItem = catalogMap[exName.trim()];
    if (catItem && catItem.primaryMuscle && !targetMusclesList.includes(catItem.primaryMuscle)) {
      targetMusclesList.push(catItem.primaryMuscle);
    }
  });

  const sixtyDaysAgo = Date.now() - (60 * 24 * 3600 * 1000);
  const fallbackPreparedExercises = [];

  targetExercises.forEach((ex, idx) => {
    const history = prevSplitSets.filter(s => {
      const setDate = normalizeDate(s.date);
      const isRecent = setDate && setDate.getTime() >= sixtyDaysAgo;
      const isWork = (s.category === 'Рабочий') && (s.effort !== 'Размин.');
      return s.exercise === ex && isWork && isRecent;
    });

    let lastKnownWorkingWeight = 0;
    const regularSets = history.filter(h => {
      const isSpecial = (h.method || '').toLowerCase().includes('дроп') || (h.method || '').toLowerCase().includes('кластер');
      return !isSpecial;
    });

    if (regularSets.length > 0) {
      lastKnownWorkingWeight = parseFloat(regularSets[0].weight) || 0;
    } else if (history.length > 0) {
      lastKnownWorkingWeight = parseFloat(history[0].weight) || 0;
    } else {
      const fallbackSet = targetSessionSets.find(s => s.exercise === ex);
      if (fallbackSet) lastKnownWorkingWeight = parseFloat(fallbackSet.weight) || 0;
    }

    let targetRepsBadge = '12–15';
    let rirBadgeText = '2–3';
    let rawTargetLoad = 0;

    if (nextMode === 'Делоад' || nextMode === 'Разгрузка') {
      targetRepsBadge = '8–10';
      rirBadgeText = '4–5';
      rawTargetLoad = lastKnownWorkingWeight > 0 ? (lastKnownWorkingWeight * 0.65) : 0;
    } else if (nextMode === 'Сила') {
      targetRepsBadge = '4–6';
      rirBadgeText = '1–2';
      const progressionStep = ((isNewCycleTransition || String(nextWave) === '2') && lastKnownWorkingWeight >= 50) ? 2.5 : 0;
      rawTargetLoad = lastKnownWorkingWeight > 0 ? (lastKnownWorkingWeight + progressionStep) : 0;
    } else {
      targetRepsBadge = '12–16';
      rirBadgeText = '2–3';
      rawTargetLoad = lastKnownWorkingWeight > 0 ? (lastKnownWorkingWeight * 0.75) : 0;
    }

    const finalTargetLoad = roundToGymStep(rawTargetLoad);
    const warmupRampText = calculateWarmupRamp(idx + 1, finalTargetLoad, nextMode);
    const warmupSteps = buildWarmupStepsArray(idx + 1, finalTargetLoad, nextMode);
    const catItem = catalogMap[ex.trim()];

    fallbackPreparedExercises.push({
      order: idx + 1,
      name: ex,
      target: catItem ? catItem.primaryMuscle : '',
      weight: finalTargetLoad,
      sets: (nextMode === 'Делоад') ? 2 : 3,
      reps: targetRepsBadge,
      rir: rirBadgeText,
      method: 'Стандарт',
      warmupText: warmupRampText,
      warmupSteps: warmupSteps,
      notes: ''
    });
  });

  latestPreparedWorkoutPayload = {
    title: nextTitle,
    cycleId: nextCycleId,
    splitDay: nextSplit,
    cycleMode: nextMode,
    waveIndex: nextWave,
    cycleWeek: nextWeek,
    targetMuscles: targetMusclesList,
    exercises: fallbackPreparedExercises
  };

  updatePlanPreviewCardUI(latestPreparedWorkoutPayload);
}

function updatePlanPreviewCardUI(payload) {
  const previewTitleEl = document.getElementById('overviewPlanPreviewTitle');
  const previewMetricsEl = document.getElementById('overviewPlanPreviewMetrics');

  if (previewTitleEl) {
    previewTitleEl.innerText = payload.title || `Тренировка Дня ${payload.splitDay}`;
  }

  if (previewMetricsEl) {
    const exCount = payload.exercises.length;
    const totalWorkSets = payload.exercises.reduce((acc, ex) => acc + (parseInt(ex.sets, 10) || 3), 0);
    const specialCount = payload.exercises.filter(ex => ex.method && ex.method !== 'Стандарт').length;
    const specBadge = specialCount > 0 ? ` • ⚡ ${specialCount} инт.` : '';
    previewMetricsEl.innerText = `${exCount} упражнений • ${totalWorkSets} подходов${specBadge}`;
  }
}

/* =========================================================================
 * МОДАЛЬНОЕ ОКНО: полный перечень упражнений
 * ========================================================================= */

function openWorkoutPlanDetailsModal() {
  if (!latestPreparedWorkoutPayload || !latestPreparedWorkoutPayload.exercises) {
    alert('План тренировки еще не загружен.');
    return;
  }

  const switcher = document.getElementById('modalPlanSplitSwitcher');
  const tabA = document.getElementById('modalPlanTabA');
  const tabB = document.getElementById('modalPlanTabB');

  if (switcher && tabA && tabB) {
    if (cachedBothSplitsPayloads.A && cachedBothSplitsPayloads.B) {
      switcher.style.display = 'flex';
      tabA.classList.toggle('active', activeModalSplitKey === 'A');
      tabB.classList.toggle('active', activeModalSplitKey === 'B');
    } else {
      switcher.style.display = 'none';
    }
  }

  const currentPayload = cachedBothSplitsPayloads[activeModalSplitKey] || latestPreparedWorkoutPayload;
  renderModalSplitExercises(currentPayload);
  openModal('workoutPlanDetailsModal');
}

function renderModalSplitExercises(payload) {
  const titleEl = document.getElementById('modalPlanTitle');
  const adviceEl = document.getElementById('modalPlanAdviceText');
  const container = document.getElementById('modalRecipeContainer');
  if (!container || !payload) return;

  if (titleEl) {
    titleEl.innerText = payload.title || `День ${payload.splitDay}`;
  }

  if (adviceEl) {
    const totalSets = payload.exercises.reduce((acc, ex) => acc + (parseInt(ex.sets, 10) || 3), 0);
    adviceEl.innerText = `Режим: ${payload.cycleMode} (${payload.cycleWeek} нед.). Всего ${payload.exercises.length} упражнений (${totalSets} рабочих подходов).`;
  }

  container.innerHTML = '';

  payload.exercises.forEach(ex => {
    const step = document.createElement('div');
    step.className = 'recipe-step';

    const isDropMethod = String(ex.method || '').toLowerCase().includes('дроп');
    const dropWeightVal = isDropMethod ? roundToGymStep(ex.weight * 0.75) : 0;

    const methodBadgeHtml = (ex.method && ex.method !== 'Стандарт')
      ? `<span class="recipe-rir-badge" style="background: var(--md-sys-color-primary-container); color: var(--md-sys-color-on-primary-container);">Финал: ${escapeHtml(ex.method)}${dropWeightVal > 0 ? ` → ${dropWeightVal} кг × 4–6` : ''}</span>`
      : '';

    // V5.4.0: read-only чипы из истории (equipment / positioning)
    const histEquip = getLastSetFieldForExercise(ex.name, 'equipment');
    const histTech = getLastSetFieldForExercise(ex.name, 'positioning');

    let notesRowHtml = '';
    if (histEquip || histTech) {
      const equipChip = histEquip
        ? `<div class="recipe-note-chip"><span class="material-symbols-outlined">settings</span><span>${escapeHtml(histEquip)}</span></div>`
        : '';
      const techChip = histTech
        ? `<div class="recipe-note-chip"><span class="material-symbols-outlined">notes</span><span>${escapeHtml(histTech)}</span></div>`
        : '';
      notesRowHtml = `<div class="recipe-notes-row">${equipChip}${techChip}</div>`;
    }

    step.innerHTML = `
      <div class="recipe-step-header">#${ex.order} • ${escapeHtml(ex.name)}</div>
      <div class="recipe-metrics-row">
        <span class="recipe-sets-count">${ex.sets} сета ×</span>
        <span class="recipe-weight-highlight">${ex.weight > 0 ? ex.weight + ' кг' : 'рабочий вес'}</span>
        <span class="recipe-reps-chip">${escapeHtml(ex.reps)} повт.</span>
        <span class="recipe-rir-badge">RIR ${escapeHtml(ex.rir)}</span>
        ${methodBadgeHtml}
      </div>
      <div class="recipe-warmup-row">
        <span class="material-symbols-outlined">restart_alt</span>
        <span>Разминка: <b>${escapeHtml(ex.warmupText)}</b></span>
      </div>
      ${notesRowHtml}
      ${ex.notes ? `<div style="font-size: 0.75rem; color: var(--md-sys-color-on-surface-variant); margin-top: 2px;">📌 ${escapeHtml(ex.notes)}</div>` : ''}
    `;

    container.appendChild(step);
  });
}

/* =========================================================================
 * МАНЕКЕН 2.0
 * ========================================================================= */

function interpolateHexColor(hex1, hex2, factor) {
  const f = Math.max(0, Math.min(1, factor));
  const c1 = parseInt(hex1.slice(1), 16);
  const c2 = parseInt(hex2.slice(1), 16);

  const r1 = (c1 >> 16) & 255, g1 = (c1 >> 8) & 255, b1 = c1 & 255;
  const r2 = (c2 >> 16) & 255, g2 = (c2 >> 8) & 255, b2 = c2 & 255;

  const r = Math.round(r1 + (r2 - r1) * f);
  const g = Math.round(g1 + (g2 - g1) * f);
  const b = Math.round(b1 + (b2 - b1) * f);

  return `#${((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1)}`;
}

function getSpectralThermalColor(percent) {
  const p = Math.max(0, Math.min(100, percent));
  if (p <= 35) {
    return interpolateHexColor('#3b4262', '#10b981', p / 35);
  }
  if (p <= 70) {
    return interpolateHexColor('#10b981', '#facc15', (p - 35) / 35);
  }
  return interpolateHexColor('#facc15', '#ff4d4f', (p - 70) / 30);
}

function resolveDetailedMuscleRegion(rawMuscle, exerciseName) {
  const m = String(rawMuscle || '').trim();
  const ex = String(exerciseName || '').toLowerCase();

  if (m === 'Грудь') return 'Грудь';
  if (m === 'Широчайшие') return 'Широчайшие';
  if (m === 'Верх спины') return 'Верх спины';
  if (m === 'Передняя дельта') return 'Передняя дельта';
  if (m === 'Задняя дельта') return 'Задняя дельта';
  if (m === 'Средняя дельта') {
    if (ex.includes('задн') || ex.includes('обратн')) return 'Задняя дельта';
    if (ex.includes('передн') || ex.includes('армейск') || ex.includes('жим')) return 'Передняя дельта';
    return 'Средняя дельта';
  }
  if (m === 'Бицепс') return 'Бицепс';
  if (m === 'Трицепс') return 'Трицепс';
  if (m === 'Руки') {
    if (ex.includes('трицепс') || ex.includes('разгибан') || ex.includes('француз') || ex.includes('брусь')) return 'Трицепс';
    return 'Бицепс';
  }
  if (m === 'Квадрицепс') return 'Квадрицепс';
  if (m === 'Бицепс бедра') return 'Бицепс бедра';
  if (m === 'Ягодичные') return 'Ягодичные';
  if (m === 'Икры') return 'Икры';
  if (m.includes('Кор') || m.includes('Пресс')) return 'Кор';
  return m;
}

function renderMuscleMannequin() {
  const sets = state.dbData.sets || [];
  const catalogMap = {};
  (state.dbData.catalog || []).forEach(item => {
    if (item && item.name) catalogMap[item.name.trim()] = item;
  });

  const regionsList = [
    'Грудь', 'Широчайшие', 'Верх спины',
    'Передняя дельта', 'Средняя дельта', 'Задняя дельта',
    'Бицепс', 'Трицепс', 'Кор',
    'Ягодичные', 'Квадрицепс', 'Бицепс бедра', 'Икры'
  ];

  const muscleData = {};
  regionsList.forEach(r => {
    muscleData[r] = { lastKey: null, lastExercise: '', weeklyVolume: 0 };
  });

  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0).getTime();
  const sevenDaysAgoMidnight = todayMidnight - (7 * 24 * 60 * 60 * 1000);

  sets.forEach(s => {
    const key = getDateKey(s.date);
    if (!key) return;

    const exName = (s.exercise || '').trim();
    const item = catalogMap[exName];
    if (!item || item.status === 'Требует разметки') return;

    const isWork = (s.category === 'Рабочий') && (s.effort !== 'Размин.');

    const parts = key.split('-');
    const setMidnight = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 0, 0, 0).getTime();
    const isWithin7Days = (setMidnight >= sevenDaysAgoMidnight && setMidnight <= todayMidnight);

    const matchTargets = [
      { muscle: item.primaryMuscle, ratio: parseFloat(item.primaryRatio) || 1.0 },
      { muscle: item.secondaryMuscle, ratio: parseFloat(item.secondaryRatio) || 0.5 },
      { muscle: item.tertiaryMuscle, ratio: parseFloat(item.tertiaryRatio) || 0.25 }
    ].filter(t => Boolean(t.muscle));

    matchTargets.forEach(target => {
      const region = resolveDetailedMuscleRegion(target.muscle, exName);
      if (muscleData[region]) {
        if (!muscleData[region].lastKey || key > muscleData[region].lastKey) {
          muscleData[region].lastKey = key;
          muscleData[region].lastExercise = exName;
        }
        if (isWork && isWithin7Days) {
          muscleData[region].weeklyVolume += target.ratio;
        }
      }
    });
  });

  const muscleStatusData = {};

  Object.keys(muscleData).forEach(muscle => {
    const info = muscleData[muscle];
    const vol = parseFloat(info.weeklyVolume.toFixed(1));
    const isLegMaintenance = (muscle === 'Квадрицепс' || muscle === 'Бицепс бедра' || muscle === 'Ягодичные');

    let daysDiff = 99;
    let timeAgoText = 'Нагрузка > 7 дн. назад';

    if (info.lastKey) {
      const parts = info.lastKey.split('-');
      const workoutMidnight = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 0, 0, 0).getTime();
      daysDiff = Math.round((todayMidnight - workoutMidnight) / (1000 * 60 * 60 * 24));
      if (daysDiff === 0) timeAgoText = 'Сегодня';
      else if (daysDiff === 1) timeAgoText = 'Вчера (24 ч)';
      else if (daysDiff === 2) timeAgoText = '2 дня назад (48 ч)';
      else timeAgoText = `${daysDiff} дн. назад`;
    }

    let thermalPercent = 10;
    let label = 'Покой / Резерв';

    const targetMav = isLegMaintenance ? 4 : 14;
    const volumeSaturation = Math.min(1, vol / targetMav);

    if (daysDiff === 0) {
      thermalPercent = Math.round(85 + (volumeSaturation * 15));
      label = `В нагрузке сегодня (${thermalPercent}%)`;
    } else if (daysDiff === 1) {
      thermalPercent = Math.round(62 + (volumeSaturation * 18));
      label = `Регенерация 24ч (${thermalPercent}%)`;
    } else if (daysDiff === 2) {
      thermalPercent = Math.round(45 + (volumeSaturation * 15));
      label = `Суперкомпенсация 48ч (${thermalPercent}%)`;
    } else if (vol > 0) {
      thermalPercent = Math.round(28 + (volumeSaturation * 14));
      label = `Готов к бою (${thermalPercent}%)`;
    } else {
      thermalPercent = isLegMaintenance ? 15 : 8;
      label = isLegMaintenance ? 'Поддержание (Maintenance)' : 'Полный покой (Свежие)';
    }

    const color = getSpectralThermalColor(thermalPercent);

    let zone = 'Maintenance';
    if (isLegMaintenance) {
      if (vol >= 2 && vol <= 5) zone = 'Maintenance (Оптимум)';
      else if (vol > 5) zone = 'MEV/MAV';
    } else {
      if (vol >= 6 && vol < 12) zone = 'MEV';
      else if (vol >= 12 && vol <= 18) zone = 'MAV (Оптимум)';
      else if (vol > 18) zone = 'MRV ⚠️';
    }

    muscleStatusData[muscle] = {
      color,
      thermalPercent,
      label,
      timeAgoText,
      lastExercise: info.lastExercise || 'Базовые движения сплита',
      volumeText: `${vol} сетов/нед (${zone})`
    };
  });

  const paths = document.querySelectorAll('.muscle-path');
  const scaleMarker = document.getElementById('thermalScaleMarker');

  paths.forEach(p => {
    const muscleName = p.getAttribute('data-muscle');
    const data = muscleStatusData[muscleName];
    if (data) {
      p.setAttribute('fill', data.color);
    }

    p.onclick = (e) => {
      e.stopPropagation();

      paths.forEach(el => el.classList.remove('selected'));
      document.querySelectorAll(`.muscle-path[data-muscle="${muscleName}"]`).forEach(el => {
        el.classList.add('selected');
      });

      const nameBox = document.getElementById('mannequinMuscleName');
      const badgeBox = document.getElementById('mannequinMuscleBadge');
      const detailsBox = document.getElementById('mannequinMuscleDetails');

      if (nameBox && badgeBox && detailsBox && data) {
        nameBox.innerText = muscleName;
        badgeBox.innerText = data.label;
        badgeBox.style.color = data.color;

        if (scaleMarker) {
          scaleMarker.style.display = 'block';
          scaleMarker.style.left = `${data.thermalPercent}%`;
        }

        detailsBox.innerHTML = `
          <div>• Последняя стимуляция: <b>${escapeHtml(data.timeAgoText)}</b> (${escapeHtml(data.lastExercise)})</div>
          <div>• Недельный объем: <b>${escapeHtml(data.volumeText)}</b></div>
          <div style="height: 6px; background: var(--md-sys-color-surface-container); border-radius: 3px; overflow: hidden; margin-top: 6px;">
            <div style="width: ${data.thermalPercent}%; background-color: ${data.color}; height: 100%; transition: width 0.35s ease;"></div>
          </div>
        `;
      }
    };
  });
}
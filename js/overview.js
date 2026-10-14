import { state, normalizeDate, formatDateDisplay, getDateKey, escapeHtml } from './state.js';
import { extractPeriodization } from './parser.js';
import { startNewLiveWorkout } from './live_workout.js';

let isOverviewInitialized = false;
let latestPreparedWorkoutPayload = null;
let cachedBothSplitsPayloads = { A: null, B: null };
let activeModalSplitKey = 'A';

export function renderOverviewModule() {
  initOverviewModalListeners();
  renderCalendarStrip();
  renderAiRecipeCard();
  renderMuscleMannequin();
}

function initOverviewModalListeners() {
  if (isOverviewInitialized) return;

  // Модальное окно сводки дня из календаря
  const dayModal = document.getElementById('daySummaryModal');
  const closeDayBtn = document.getElementById('closeDaySummaryModalBtn');
  if (closeDayBtn && dayModal) {
    closeDayBtn.onclick = () => { dayModal.style.display = 'none'; };
    dayModal.onclick = (e) => {
      if (e.target === dayModal) dayModal.style.display = 'none';
    };
  }

  // Модальное окно полного списка упражнений предстоящей тренировки
  const planModal = document.getElementById('workoutPlanDetailsModal');
  const closePlanBtn = document.getElementById('closeWorkoutPlanModalBtn');
  const previewCard = document.getElementById('overviewPlanPreviewCard');
  const modalTabA = document.getElementById('modalPlanTabA');
  const modalTabB = document.getElementById('modalPlanTabB');
  const modalStartBtn = document.getElementById('modalStartLiveWorkoutBtn');

  if (previewCard && planModal) {
    previewCard.onclick = () => {
      openWorkoutPlanDetailsModal();
    };
  }

  if (closePlanBtn && planModal) {
    closePlanBtn.onclick = () => { planModal.style.display = 'none'; };
    planModal.onclick = (e) => {
      if (e.target === planModal) planModal.style.display = 'none';
    };
  }

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

  if (modalStartBtn && planModal) {
    modalStartBtn.onclick = () => {
      planModal.style.display = 'none';
      const chosenPayload = cachedBothSplitsPayloads[activeModalSplitKey] || latestPreparedWorkoutPayload;
      startNewLiveWorkout(chosenPayload);
    };
  }

  // Главная кнопка запуска тренировки на дашборде
  const startLiveBtn = document.getElementById('startLiveWorkoutBtn');
  if (startLiveBtn) {
    startLiveBtn.onclick = () => {
      startNewLiveWorkout(latestPreparedWorkoutPayload);
    };
  }

  isOverviewInitialized = true;
}

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

/**
 * -------------------------------------------------------------------------
 * 1. КАЛЕНДАРНАЯ ПОЛОСА С ПОДРОБНЫМ ДНЕВНИКОМ ДНЯ ПО КЛИКУ
 * -------------------------------------------------------------------------
 */
function renderCalendarStrip() {
  const container = document.getElementById('calendarStripContainer');
  const rangeLabel = document.getElementById('calendarWeekRange');
  if (!container) return;
  container.innerHTML = '';

  const today = new Date();
  today.setHours(12, 0, 0, 0);
  const todayKey = getDateKey(today);

  const days = [];
  for (let i = -3; i <= 3; i++) {
    const d = new Date(today);
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
    const isToday = (key === todayKey);
    const session = sessionDatesMap[key];

    const card = document.createElement('div');
    card.className = `calendar-day-card ${isToday ? 'today' : ''}`;

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
  const modal = document.getElementById('daySummaryModal');
  const title = document.getElementById('modalDayDate');
  const content = document.getElementById('modalDayContent');
  if (!modal || !title || !content) return;

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

  modal.style.display = 'flex';
}

/**
 * -------------------------------------------------------------------------
 * 2. КОМПАКТНАЯ КАРТОЧКА ПЛАНА + МОДАЛЬНОЕ ОКНО СПИСКА УПРАЖНЕНИЙ
 * -------------------------------------------------------------------------
 */
function prepareSplitPayloadFromAiPlan(splitObj, splitLetter, cycleId, cycleMode, waveIndex, cycleWeek, catalogMap) {
  if (!splitObj || !Array.isArray(splitObj.exercises)) return null;

  const preparedExercises = [];
  const targetMusclesList = [];

  splitObj.exercises.forEach((ex, idx) => {
    const catItem = catalogMap[(ex.name || '').trim()];
    const muscle = (catItem && catItem.primaryMuscle) ? catItem.primaryMuscle : (ex.target || '');
    if (muscle && !targetMusclesList.includes(muscle)) {
      targetMusclesList.push(muscle);
    }

    const orderNum = parseInt(ex.order, 10) || (idx + 1);
    const weightVal = parseFloat(ex.weight) || 0;
    const warmupRampText = calculateWarmupRamp(orderNum, weightVal, cycleMode);
    const warmupSteps = buildWarmupStepsArray(orderNum, weightVal, cycleMode);

    preparedExercises.push({
      order: orderNum,
      name: ex.name || 'Упражнение',
      target: muscle,
      weight: weightVal,
      sets: parseInt(ex.sets, 10) || 3,
      reps: String(ex.reps || '4-6'),
      rir: String(ex.rir || '1-2'),
      method: String(ex.method || 'Стандарт'),
      warmupText: warmupRampText,
      warmupSteps: warmupSteps,
      notes: ex.notes ? String(ex.notes) : ''
    });
  });

  const title = splitObj.title || `Тренировка ${splitLetter}${waveIndex} ${cycleMode} ${cycleId}`;

  return {
    title: title,
    cycleId: cycleId,
    splitDay: splitLetter,
    cycleMode: cycleMode,
    waveIndex: waveIndex,
    cycleWeek: cycleWeek,
    targetMuscles: targetMusclesList,
    exercises: preparedExercises
  };
}

function renderAiRecipeCard() {
  const sets = state.dbData.sets || [];
  const catalog = state.dbData.catalog || [];
  const muscleTagsRow = document.getElementById('overviewMuscleTagsRow');
  const cycleBadge = document.getElementById('overviewCycleBadge');
  const nextTag = document.getElementById('overviewNextTag');
  const previewTitleEl = document.getElementById('overviewPlanPreviewTitle');
  const previewMetricsEl = document.getElementById('overviewPlanPreviewMetrics');

  if (muscleTagsRow) muscleTagsRow.innerHTML = '';

  const catalogMap = {};
  catalog.forEach(item => {
    if (item && item.name) catalogMap[item.name.trim()] = item;
  });

  let nextSplit = 'А';
  let nextWeek = 1;
  let nextMode = 'Сила';
  let nextWave = '1';
  let nextCycleId = state.dbData.currentCycleId || 'C-2';
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
    let currentCycleId = latestSet.cycleId || state.dbData.currentCycleId || 'C-2';

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
    ? `Тренировка ${nextSplit} Разгрузка (Делоад) ${nextCycleId}`
    : `Тренировка ${nextSplit}${nextWave} ${nextMode} ${nextCycleId}`;

  if (cycleBadge) cycleBadge.innerText = nextCycleId;
  if (nextTag) nextTag.innerText = nextTitle;

  activeModalSplitKey = (nextSplit === 'А' || nextSplit === 'A') ? 'A' : 'B';
  cachedBothSplitsPayloads = { A: null, B: null };

  // 1. ПРИОРИТЕТ: ЧТЕНИЕ СОХРАНЕННОГО ПЛАНА МЕЗОЦИКЛА (AI COPILOT)
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

  // 2. FALLBACK: РАСЧЕТ ОТ АРХИВНЫХ ТРЕНИРОВОК
  if (sets.length === 0) {
    if (previewTitleEl) previewTitleEl.innerText = 'План еще не сформирован';
    if (previewMetricsEl) previewMetricsEl.innerText = 'Сгенерируйте план во вкладке «Тренер» или загрузите отчет';
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
    if (previewTitleEl) previewTitleEl.innerText = `День ${nextSplit} (Нет архивных записей)`;
    if (previewMetricsEl) previewMetricsEl.innerText = 'Рассчитайте план во вкладке «Тренер»';
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
      const progressionStep = isNewCycleTransition ? 2.5 : 0;
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
      sets: 3,
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
  const muscleTagsRow = document.getElementById('overviewMuscleTagsRow');
  const previewTitleEl = document.getElementById('overviewPlanPreviewTitle');
  const previewMetricsEl = document.getElementById('overviewPlanPreviewMetrics');

  if (muscleTagsRow) {
    muscleTagsRow.innerHTML = '';
    (payload.targetMuscles || []).forEach(m => {
      const chip = document.createElement('span');
      chip.className = 'muscle-tag';
      chip.innerText = m;
      muscleTagsRow.appendChild(chip);
    });
  }

  const exCount = payload.exercises.length;
  const totalWorkSets = payload.exercises.reduce((acc, ex) => acc + (parseInt(ex.sets, 10) || 3), 0);
  const specialCount = payload.exercises.filter(ex => ex.method && ex.method !== 'Стандарт').length;

  if (previewTitleEl) {
    previewTitleEl.innerText = payload.title || `Тренировка Дня ${payload.splitDay}`;
  }
  if (previewMetricsEl) {
    const specBadge = specialCount > 0 ? ` • ⚡ Интенсификаторов: ${specialCount}` : '';
    previewMetricsEl.innerText = `${exCount} упражнений • ${totalWorkSets} рабочих подходов${specBadge}`;
  }
}

function openWorkoutPlanDetailsModal() {
  const modal = document.getElementById('workoutPlanDetailsModal');
  const switcher = document.getElementById('modalPlanSplitSwitcher');
  const tabA = document.getElementById('modalPlanTabA');
  const tabB = document.getElementById('modalPlanTabB');
  if (!modal) return;

  if (!latestPreparedWorkoutPayload || !latestPreparedWorkoutPayload.exercises) {
    alert('План тренировки еще не загружен.');
    return;
  }

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
  modal.style.display = 'flex';
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
    adviceEl.innerText = `Всего ${payload.exercises.length} упражнений (${totalSets} рабочих подходов). Разминочные подходы рассчитаны автоматически.`;
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
      ${ex.notes ? `<div style="font-size: 0.75rem; color: var(--md-sys-color-on-surface-variant); margin-top: 2px;">📌 ${escapeHtml(ex.notes)}</div>` : ''}
    `;

    container.appendChild(step);
  });
}

/**
 * -------------------------------------------------------------------------
 * 3. АНАТОМИЧЕСКАЯ SVG-ТЕПЛОКАРТА 2.0 (СПЕКТРАЛЬНЫЙ ГРАДИЕНТ 0% -> 100%)
 * -------------------------------------------------------------------------
 */
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

/**
 * Непрерывный спектр: 0% (Индиго #3b4262) -> 35% (Изумруд #10b981) -> 70% (Янтарь #facc15) -> 100% (Алый #ff4d4f)
 */
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

    // Расчет непрерывного спектрального индекса 0..100% на основе давности + недельного объема
    let thermalPercent = 10;
    let label = 'Покой / Резерв';

    const targetMav = isLegMaintenance ? 4 : 14;
    const volumeSaturation = Math.min(1, vol / targetMav);

    if (daysDiff === 0) {
      thermalPercent = Math.round(85 + (volumeSaturation * 15)); // 85..100% (Алый пик)
      label = `В нагрузке сегодня (${thermalPercent}%)`;
    } else if (daysDiff === 1) {
      thermalPercent = Math.round(62 + (volumeSaturation * 18)); // 62..80% (Янтарь: активное восстановление)
      label = `Регенерация 24ч (${thermalPercent}%)`;
    } else if (daysDiff === 2) {
      thermalPercent = Math.round(45 + (volumeSaturation * 15)); // 45..60% (Переход к суперкомпенсации)
      label = `Суперкомпенсация 48ч (${thermalPercent}%)`;
    } else if (vol > 0) {
      thermalPercent = Math.round(28 + (volumeSaturation * 14)); // 28..42% (Изумруд: полная боевая готовность)
      label = `Готов к бою (${thermalPercent}%)`;
    } else {
      thermalPercent = isLegMaintenance ? 15 : 8; // 8..15% (Индиго: полный покой)
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
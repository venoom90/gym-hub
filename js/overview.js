import { state, normalizeDate, formatDateDisplay, getDateKey, escapeHtml } from './state.js';
import { extractPeriodization } from './parser.js';

let isOverviewInitialized = false;

export function renderOverviewModule() {
  initDayModalListeners();
  renderCalendarStrip();
  renderAiRecipeCard();
  renderMuscleMannequin();
}

function initDayModalListeners() {
  if (isOverviewInitialized) return;
  const modal = document.getElementById('daySummaryModal');
  const closeBtn = document.getElementById('closeDaySummaryModalBtn');
  if (closeBtn && modal) {
    closeBtn.onclick = () => { modal.style.display = 'none'; };
    modal.onclick = (e) => {
      if (e.target === modal) modal.style.display = 'none';
    };
  }
  isOverviewInitialized = true;
}

/**
 * Округление расчетного веса до шага 2.5 кг
 */
function roundToGymStep(weight) {
  if (!weight || weight <= 0) return 0;
  return Math.round(weight / 2.5) * 2.5;
}

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
        tonnage: 0
      };
    }
    
    if (isWork) {
      sessionDatesMap[key].setsCount++;
      sessionDatesMap[key].tonnage += (s.tonnage || 0);
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
    content.innerHTML = `
      <div style="font-weight: 600; color: var(--md-sys-color-primary);">${escapeHtml(session.workout)}</div>
      <div><b>Сплит:</b> День ${escapeHtml(session.split)}</div>
      <div><b>Рабочих подходов:</b> ${session.setsCount}</div>
      <div><b>Рабочий тоннаж:</b> ${(session.tonnage / 1000).toFixed(2)} т</div>
    `;
  } else {
    content.innerHTML = `<div style="color: var(--md-sys-color-on-surface-variant);">В этот день тренировок не зафиксировано (день отдыха).</div>`;
  }

  modal.style.display = 'flex';
}

function renderAiRecipeCard() {
  const sets = state.dbData.sets || [];
  const catalog = state.dbData.catalog || [];
  const recipeBox = document.getElementById('overviewRecipeContainer');
  const adviceText = document.getElementById('overviewAiAdviceText');
  const muscleTagsRow = document.getElementById('overviewMuscleTagsRow');
  const cycleBadge = document.getElementById('overviewCycleBadge');
  const nextTag = document.getElementById('overviewNextTag');
  if (!recipeBox) return;
  recipeBox.innerHTML = '';
  if (muscleTagsRow) muscleTagsRow.innerHTML = '';

  if (sets.length === 0) {
    if (adviceText) adviceText.innerText = 'Загрузите историю тренировок для формирования рецепта.';
    return;
  }

  const catalogMap = {};
  catalog.forEach(item => {
    if (item && item.name) catalogMap[item.name.trim()] = item;
  });

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

  let nextSplit = 'А';
  let nextWeek = 1;
  let nextMode = 'Сила';
  let nextWave = '1';
  let nextCycleId = currentCycleId;
  let isNewCycleTransition = false;

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

  const nextTitle = (nextMode === 'Делоад' || nextMode === 'Разгрузка')
    ? `Тренировка ${nextSplit} Разгрузка (Делоад)`
    : `Тренировка ${nextSplit}${nextWave} ${nextMode}`;

  if (cycleBadge) cycleBadge.innerText = nextCycleId;
  if (nextTag) nextTag.innerText = nextTitle;

  // 1. ПРИОРИТЕТ: ЧТЕНИЕ СОХРАНЕННОГО ПЛАНА МЕЗОЦИКЛА (AI COPILOT)
  // Исключает рассинхрон между экранами «Обзор» и «Тренер»
  let activeAiPlan = null;
  try {
    const rawAiPlan = localStorage.getItem('gym_ai_coach_plan');
    if (rawAiPlan) {
      const parsedPlan = JSON.parse(rawAiPlan);
      const planSplitKey = (nextSplit === 'А' || nextSplit === 'A') ? 'A' : 'B';
      if (parsedPlan && parsedPlan.splits && parsedPlan.splits[planSplitKey] && parsedPlan.splits[planSplitKey].exercises) {
        activeAiPlan = parsedPlan.splits[planSplitKey];
      }
    }
  } catch (err) {
    console.warn('[Overview] Не удалось распарсить сохраненный план ИИ:', err);
  }

  if (activeAiPlan && activeAiPlan.exercises.length > 0) {
    // Вывод тегов целевых мышечных групп из плана ИИ
    const targetMusclesList = [];
    activeAiPlan.exercises.forEach(ex => {
      const catItem = catalogMap[(ex.name || '').trim()];
      const muscle = (catItem && catItem.primaryMuscle) ? catItem.primaryMuscle : (ex.target || '');
      if (muscle && !targetMusclesList.includes(muscle)) {
        targetMusclesList.push(muscle);
      }
    });

    if (muscleTagsRow && targetMusclesList.length > 0) {
      targetMusclesList.forEach(m => {
        const chip = document.createElement('span');
        chip.className = 'muscle-tag';
        chip.innerText = m;
        muscleTagsRow.appendChild(chip);
      });
    }

    if (adviceText) {
      adviceText.innerText = activeAiPlan.title 
        ? `План мезоцикла: ${activeAiPlan.title}. Рассчитан ИИ-тренером с учетом DUP и канонов восстановления.`
        : `План дня ${nextSplit} из сохраненного мезоцикла.`;
    }

    activeAiPlan.exercises.forEach(ex => {
      const step = document.createElement('div');
      step.className = 'recipe-step';

      const weightVal = parseFloat(ex.weight) || 0;
      const setsCount = parseInt(ex.sets, 10) || 3;
      const repsRange = ex.reps || '4-6';
      const rirVal = ex.rir || '1-2';
      const warmupWeight = roundToGymStep(weightVal * 0.5);

      step.innerHTML = `
        <div class="recipe-step-header">#${parseInt(ex.order, 10) || 1} • ${escapeHtml(ex.name)}</div>
        <div class="recipe-metrics-row">
          <span class="recipe-sets-count">${setsCount} сета ×</span>
          <span class="recipe-weight-highlight">${weightVal > 0 ? weightVal + ' кг' : 'рабочий вес'}</span>
          <span class="recipe-reps-chip">${escapeHtml(repsRange)} повт.</span>
          <span class="recipe-rir-badge">RIR ${escapeHtml(rirVal)}</span>
        </div>
        <div class="recipe-warmup-row">
          <span class="material-symbols-outlined">restart_alt</span>
          <span>Разминка: ${warmupWeight > 0 ? `1 подход × ${warmupWeight} кг` : 'Не требуется'}</span>
        </div>
      `;
      recipeBox.appendChild(step);
    });

    return;
  }

  // 2. FALLBACK: РАСЧЕТ ОТ РЕАЛЬНОГО РАБОЧЕГО ВЕСА (БЕЗ ЗАВЫШАЮЩЕЙ ФОРМУЛЫ 1ПМ)
  const prevSplitSets = sortedSets.filter(s => {
    const sSplit = (s.splitDay || extractPeriodization(s.workout).splitDay || '').toUpperCase();
    return sSplit === nextSplit;
  });

  if (prevSplitSets.length === 0) {
    if (adviceText) adviceText.innerText = `Нет исторических данных для формирования плана Дня ${nextSplit}.`;
    recipeBox.innerHTML = `<div style="font-size: 0.85rem; color: #94a3b8;">Выполните и синхронизируйте тренировку ${nextSplit}.</div>`;
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

  if (muscleTagsRow && targetMusclesList.length > 0) {
    targetMusclesList.forEach(m => {
      const chip = document.createElement('span');
      chip.className = 'muscle-tag';
      chip.innerText = m;
      muscleTagsRow.appendChild(chip);
    });
  }

  let modeAdvice = '';
  if (isNewCycleTransition) {
    modeAdvice = `Старт нового мезоцикла ${nextCycleId}! Силовой режим: сохраняйте проверенный рабочий вес с прогрессией +2.5 кг.`;
  } else if (nextMode === 'Делоад' || nextMode === 'Разгрузка') {
    modeAdvice = 'Разгрузочная тренировка (RIR +4..+5). Сниженный вес (~65%), работа без мышечного отказа для восстановления ЦНС и суставов.';
  } else if (nextMode === 'Сила') {
    modeAdvice = 'Тяжелый силовой режим (RIR +1..+2). Максимальная взрывная концентрация в позитивной фазе.';
  } else {
    modeAdvice = 'Многоповторный объемный режим (RIR +2..+3). Фокус на постоянное натяжение и памп.';
  }

  if (adviceText) adviceText.innerText = modeAdvice;

  const sixtyDaysAgo = Date.now() - (60 * 24 * 3600 * 1000);

  targetExercises.forEach(ex => {
    const history = prevSplitSets.filter(s => {
      const setDate = normalizeDate(s.date);
      const isRecent = setDate && setDate.getTime() >= sixtyDaysAgo;
      const isWork = (s.category === 'Рабочий') && (s.effort !== 'Размин.');
      return s.exercise === ex && isWork && isRecent;
    });

    let lastKnownWorkingWeight = 0;

    // СТРОГИЙ ПОИСК РЕАЛЬНОГО РАБОЧЕГО ВЕСА: сначала чистые регулярные сеты
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

    let targetRepsBadge = '12–15 повт.';
    let rirBadgeText = 'RIR 2–3';
    let rawTargetLoad = 0;
    let warmUpText = 'Не требуется';

    if (nextMode === 'Делоад' || nextMode === 'Разгрузка') {
      targetRepsBadge = '8–10 повт.';
      rirBadgeText = 'RIR 4–5 (Делоад)';
      rawTargetLoad = lastKnownWorkingWeight > 0 ? (lastKnownWorkingWeight * 0.65) : 0;
      const roundedDeload = roundToGymStep(rawTargetLoad);
      warmUpText = `1 легкий подход на ${roundToGymStep(roundedDeload * 0.5)} кг`;
    } else if (nextMode === 'Сила') {
      targetRepsBadge = '4–6 повт.';
      rirBadgeText = 'RIR 1–2 (Сила)';
      // Физиологическая прогрессия: +2.5 кг к реальному рабочему весу
      const progressionStep = isNewCycleTransition ? 2.5 : 0;
      rawTargetLoad = lastKnownWorkingWeight > 0 ? (lastKnownWorkingWeight + progressionStep) : 0;
      const roundedStrength = roundToGymStep(rawTargetLoad);
      warmUpText = `1 подход × ${roundToGymStep(roundedStrength * 0.5)} кг`;
    } else {
      targetRepsBadge = '12–16 повт.';
      rirBadgeText = 'RIR 2–3 (Объем)';
      rawTargetLoad = lastKnownWorkingWeight > 0 ? (lastKnownWorkingWeight * 0.75) : 0;
      const roundedVolume = roundToGymStep(rawTargetLoad);
      warmUpText = `1 подход × ${roundToGymStep(roundedVolume * 0.45)} кг`;
    }

    const finalTargetLoad = roundToGymStep(rawTargetLoad);

    const step = document.createElement('div');
    step.className = 'recipe-step';
    step.innerHTML = `
      <div class="recipe-step-header">${escapeHtml(ex)}</div>
      <div class="recipe-metrics-row">
        <span class="recipe-sets-count">2–3 сета ×</span>
        <span class="recipe-weight-highlight">${finalTargetLoad > 0 ? finalTargetLoad + ' кг' : 'рабочий вес'}</span>
        <span class="recipe-reps-chip">${targetRepsBadge}</span>
        <span class="recipe-rir-badge">${rirBadgeText}</span>
      </div>
      <div class="recipe-warmup-row">
        <span class="material-symbols-outlined">restart_alt</span>
        <span>Разминка: ${escapeHtml(warmUpText)}</span>
      </div>
    `;
    recipeBox.appendChild(step);
  });
}

function renderMuscleMannequin() {
  const sets = state.dbData.sets || [];
  const catalogMap = {};
  (state.dbData.catalog || []).forEach(item => {
    if (item && item.name) catalogMap[item.name.trim()] = item;
  });

  const muscleData = {
    'Грудь': { lastKey: null, lastExercise: '', weeklyVolume: 0 },
    'Широчайшие': { lastKey: null, lastExercise: '', weeklyVolume: 0 },
    'Верх спины': { lastKey: null, lastExercise: '', weeklyVolume: 0 },
    'Средняя дельта': { lastKey: null, lastExercise: '', weeklyVolume: 0 },
    'Руки': { lastKey: null, lastExercise: '', weeklyVolume: 0 },
    'Квадрицепс': { lastKey: null, lastExercise: '', weeklyVolume: 0 },
    'Бицепс бедра': { lastKey: null, lastExercise: '', weeklyVolume: 0 },
    'Икры': { lastKey: null, lastExercise: '', weeklyVolume: 0 },
    'Кор': { lastKey: null, lastExercise: '', weeklyVolume: 0 }
  };

  const today = new Date();
  const todayMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate(), 0, 0, 0).getTime();
  const sevenDaysAgoMidnight = todayMidnight - (7 * 24 * 60 * 60 * 1000);

  sets.forEach(s => {
    const key = getDateKey(s.date);
    if (!key) return;

    const item = catalogMap[(s.exercise || '').trim()];
    if (!item || item.status === 'Требует разметки') return;

    const exName = (s.exercise || '').trim();
    const isWork = (s.category === 'Рабочий') && (s.effort !== 'Размин.');

    const parts = key.split('-');
    const setMidnight = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 0, 0, 0).getTime();
    const isWithin7Days = (setMidnight >= sevenDaysAgoMidnight && setMidnight <= todayMidnight);

    const matchTargets = [
      { muscle: item.primaryMuscle, ratio: parseFloat(item.primaryRatio) || 1.0 },
      { muscle: item.secondaryMuscle, ratio: parseFloat(item.secondaryRatio) || 0.5 }
    ].filter(t => Boolean(t.muscle));

    matchTargets.forEach(target => {
      let region = target.muscle;
      if (region === 'Бицепс' || region === 'Трицепс') region = 'Руки';
      if (region === 'Передняя дельта' || region === 'Задняя дельта') region = 'Средняя дельта';
      if (region === 'Ягодичные') region = 'Бицепс бедра';
      if (region.includes('Кор') || region.includes('Пресс')) region = 'Кор';

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
    let color = '#78dc9c';
    let label = 'Свежие (Готовы)';
    let timeAgoText = 'Нагрузка давно';

    if (muscle === 'Квадрицепс' || muscle === 'Бицепс бедра') {
      color = '#64748b';
      label = 'Поддержание (2 сета)';
    }

    if (info.lastKey) {
      const parts = info.lastKey.split('-');
      const workoutMidnight = new Date(parseInt(parts[0], 10), parseInt(parts[1], 10) - 1, parseInt(parts[2], 10), 0, 0, 0).getTime();
      const daysDiff = Math.round((todayMidnight - workoutMidnight) / (1000 * 60 * 60 * 24));

      if (daysDiff === 0) {
        color = '#ffb4ab';
        label = 'Сегодня (В нагрузке)';
        timeAgoText = 'Сегодня';
      } else if (daysDiff === 1) {
        color = '#facc15';
        label = 'Активное восстановление';
        timeAgoText = 'Вчера';
      } else if (daysDiff === 2) {
        color = '#a3e635';
        label = 'Регенерация (48 ч)';
        timeAgoText = '2 дн. назад';
      } else {
        timeAgoText = `${daysDiff} дн. назад`;
      }
    }

    const vol = parseFloat(info.weeklyVolume.toFixed(1));
    let zone = 'Maintenance';
    let barColor = '#64748b';
    if (vol >= 6 && vol < 12) { zone = 'MEV'; barColor = '#78dc9c'; }
    else if (vol >= 12 && vol <= 18) { zone = 'MAV'; barColor = '#a8c8ff'; }
    else if (vol > 18) { zone = 'MRV ⚠️'; barColor = '#facc15'; }

    const barWidthPercent = Math.min(Math.round((vol / 20) * 100), 100);

    muscleStatusData[muscle] = {
      color,
      label,
      timeAgoText,
      lastExercise: info.lastExercise || 'Базовые тяги/жимы',
      volumeText: `${vol} сетов (${zone})`,
      barColor,
      barWidthPercent
    };
  });

  const paths = document.querySelectorAll('.muscle-path');
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

        detailsBox.innerHTML = `
          <div>• Последняя тренировка: <b>${escapeHtml(data.timeAgoText)}</b> (${escapeHtml(data.lastExercise)})</div>
          <div>• Объем за неделю: <b>${escapeHtml(data.volumeText)}</b></div>
          <div style="height: 6px; background: var(--md-sys-color-surface-container); border-radius: 3px; overflow: hidden; margin-top: 6px;">
            <div style="width: ${data.barWidthPercent}%; background-color: ${data.barColor}; height: 100%; transition: width 0.3s ease;"></div>
          </div>
        `;
      }
    };
  });
}
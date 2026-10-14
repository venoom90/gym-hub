/**
 * =========================================================================
 * GYM ANALYTICS HUB — LIVE WORKOUT ENGINE (ZERO-FRICTION UX V1.2)
 * =========================================================================
 * Автономный контур проведения тренировки в зале:
 * - Автоматическое ведение по шагам разминки (Warm-up Ramp) -> Рабочие сеты
 * - Включение Кластера / Дроп-сета строго на последнем рабочем сете + ручной тоггл
 * - Мини-карта упражнений [✓ 1] [2] [3] и явная кнопка «Завершить упражнение»
 * - Screen Wake Lock API + Vibration API + Crash-Proof буфер localStorage
 */

import { state, setInitialData, formatDateDisplay, escapeHtml } from './state.js';
import { syncSetsToSheets, fetchAnalyticsData } from './api.js';

const STORAGE_KEY_ACTIVE_SESSION = 'gym_active_live_workout_v1';
const STORAGE_KEY_TIMER_PREFS = 'gym_live_timer_prefs_v1';

let activeSession = null;
let workoutDurationInterval = null;
let restTimerInterval = null;
let wakeLockSentinel = null;
let onWorkoutCompletedCallback = null;

const DEFAULT_TIMERS = {
  compound: 150, // 2:30 для базовых движений
  isolation: 90, // 1:30 для изоляции и рук
  cluster: 20,   // 0:20 для кластерных микропауз
  warmup: 60     // 1:00 для разминки
};

export function initLiveWorkoutModule(onComplete) {
  onWorkoutCompletedCallback = onComplete;
  bindLiveWorkoutDomEvents();
  checkCrashRecoverySession();

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && activeSession && !activeSession.isFinished) {
      await requestScreenWakeLock();
      syncRestTimerWithWallClock();
    }
  });
}

function getTimerPrefs() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_TIMER_PREFS);
    if (!raw) return { ...DEFAULT_TIMERS };
    return { ...DEFAULT_TIMERS, ...JSON.parse(raw) };
  } catch (e) {
    return { ...DEFAULT_TIMERS };
  }
}

function saveTimerPrefs(prefs) {
  try {
    localStorage.setItem(STORAGE_KEY_TIMER_PREFS, JSON.stringify(prefs));
  } catch (e) {
    console.warn('[LiveWorkout] Не удалось сохранить настройки таймера:', e);
  }
}

function roundToGymStep(val) {
  if (!val || val <= 0) return 0;
  return Math.round(val / 2.5) * 2.5;
}

function buildFallbackWarmupSteps(order, targetWeight, cycleMode = 'Сила') {
  if (!targetWeight || targetWeight <= 30) {
    return [{ weight: Math.max(10, roundToGymStep(targetWeight * 0.6)), reps: 8 }];
  }
  if (cycleMode === 'Делоад' || cycleMode === 'Разгрузка') {
    return [{ weight: roundToGymStep(targetWeight * 0.6), reps: 8 }];
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
  return [{ weight: roundToGymStep(targetWeight * 0.65), reps: 5 }];
}

function parseDefaultReps(repsRaw) {
  const str = String(repsRaw || '6');
  const match = str.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : 6;
}

/**
 * Извлечение параметров кластера (например, из "Кластер 4+3+2" -> total: 9, firstSegment: 4)
 */
function parseClusterScheme(methodStr, defaultWorkReps) {
  const str = String(methodStr || '');
  const plusMatch = str.match(/(\d+(?:\+\d+)+)/);
  if (plusMatch) {
    const segments = plusMatch[1].split('+').map(n => parseInt(n, 10) || 0).filter(n => n > 0);
    if (segments.length > 0) {
      const sum = segments.reduce((a, b) => a + b, 0);
      return {
        isCluster: true,
        schemeText: plusMatch[1],
        totalReps: sum,
        firstSegmentReps: segments[0]
      };
    }
  }
  if (str.toLowerCase().includes('кластер')) {
    return {
      isCluster: true,
      schemeText: '4+3+2',
      totalReps: 9,
      firstSegmentReps: 4
    };
  }
  return {
    isCluster: false,
    schemeText: '',
    totalReps: defaultWorkReps,
    firstSegmentReps: defaultWorkReps
  };
}

/**
 * Автоматический расчет состояния черновика подхода (draftSet) для упражнения:
 * 1) Если еще не пройдены шаги разминки -> выставляет текущий шаг разминки
 * 2) Если разминка пройдена -> выставляет рабочий подход
 * 3) Если это ПОСЛЕДНИЙ рабочий подход (например, 4 из 4) -> автоматически активирует спецметод из плана
 */
function computeSmartDraftSetForExercise(ex) {
  const warmupDoneCount = ex.completedSets.filter(s => s.category === 'Разминка').length;
  const workDoneCount = ex.completedSets.filter(s => s.category === 'Рабочий').length;
  const warmupSteps = Array.isArray(ex.warmupSteps) && ex.warmupSteps.length > 0 ? ex.warmupSteps : [];

  // Если рабочие подходы еще не начаты и остались шаги разминки — ведем по лесенке разминки
  if (workDoneCount === 0 && warmupDoneCount < warmupSteps.length) {
    const step = warmupSteps[warmupDoneCount];
    return {
      category: 'Разминка',
      weight: step.weight,
      reps: step.reps,
      rir: '2',
      useSpecialMethod: false
    };
  }

  // Иначе — режим Рабочего подхода
  const nextWorkSetNumber = workDoneCount + 1;
  const hasPlannedSpecialMethod = ex.plannedMethod && ex.plannedMethod !== 'Стандарт';
  // Спецметод (Кластер / Дроп-сет) по умолчанию включается ТОЛЬКО на финальном рабочем подходе!
  const isFinalPlannedWorkSet = (nextWorkSetNumber === ex.targetSets);
  const activateSpecialNow = Boolean(hasPlannedSpecialMethod && isFinalPlannedWorkSet);

  const lastWorkSet = [...ex.completedSets].reverse().find(s => s.category === 'Рабочий');
  const workWeight = lastWorkSet ? lastWorkSet.weight : ex.targetWeight;

  let workReps = ex.defaultReps;
  if (activateSpecialNow && ex.isCluster) {
    const clusterInfo = parseClusterScheme(ex.plannedMethod, ex.defaultReps);
    workReps = clusterInfo.totalReps;
  } else if (lastWorkSet && !lastWorkSet.method) {
    workReps = lastWorkSet.reps;
  }

  return {
    category: 'Рабочий',
    weight: workWeight,
    reps: workReps,
    rir: activateSpecialNow ? '1' : '2',
    useSpecialMethod: activateSpecialNow
  };
}

/**
 * Запуск новой тренировки из подготовленного рецепта (Overview)
 */
export function startNewLiveWorkout(recipePayload) {
  if (!recipePayload || !Array.isArray(recipePayload.exercises) || recipePayload.exercises.length === 0) {
    alert('План тренировки пуст. Сначала загрузите данные или сформируйте план у Тренера.');
    return;
  }

  if (activeSession && !activeSession.isFinished) {
    const confirmOverwrite = confirm('У вас уже есть незавершенная тренировка. Начать новую (текущий прогресс будет сброшен)?');
    if (!confirmOverwrite) {
      openLiveWorkoutOverlay();
      return;
    }
  }

  const now = new Date();
  const dateStr = formatDateDisplay(now);
  const startTimeStr = now.toTimeString().slice(0, 5);
  const cycleMode = recipePayload.cycleMode || 'Сила';

  const exercisesQueue = recipePayload.exercises.map((ex, idx) => {
    const orderNum = idx + 1;
    const targetWeight = roundToGymStep(parseFloat(ex.weight) || 60);
    const plannedMethod = String(ex.method || 'Стандарт').trim();
    const isDropMethod = plannedMethod.toLowerCase().includes('дроп');
    const isClusterMethod = plannedMethod.toLowerCase().includes('кластер');

    const warmupSteps = (Array.isArray(ex.warmupSteps) && ex.warmupSteps.length > 0)
      ? ex.warmupSteps
      : buildFallbackWarmupSteps(orderNum, targetWeight, cycleMode);

    return {
      order: orderNum,
      name: ex.name || `Упражнение #${orderNum}`,
      targetMuscle: ex.target || '',
      targetWeight: targetWeight,
      targetSets: parseInt(ex.sets, 10) || 3,
      targetRepsStr: String(ex.reps || '6-8'),
      defaultReps: parseDefaultReps(ex.reps),
      targetRir: String(ex.rir || '1-2'),
      plannedMethod: plannedMethod,
      isDrop: isDropMethod,
      isCluster: isClusterMethod,
      dropWeight: isDropMethod ? roundToGymStep(targetWeight * 0.75) : 0,
      warmupText: ex.warmupText || '',
      warmupSteps: warmupSteps,
      notes: ex.notes || '',
      completedSets: [],
      isCompleted: false,
      allowBonusSet: false
    };
  });

  const firstEx = exercisesQueue[0];
  const initialDraft = computeSmartDraftSetForExercise(firstEx);

  activeSession = {
    sessionId: `live_${Date.now()}`,
    title: recipePayload.title || 'Тренировка А1 Сила',
    cycleId: recipePayload.cycleId || state.dbData.currentCycleId || 'C-2',
    splitDay: recipePayload.splitDay || 'А',
    cycleMode: cycleMode,
    waveIndex: recipePayload.waveIndex || '1',
    cycleWeek: recipePayload.cycleWeek || 1,
    date: dateStr,
    startTime: startTimeStr,
    startedAtMs: Date.now(),
    currentExerciseIndex: 0,
    exercises: exercisesQueue,
    draftSet: initialDraft,
    restState: {
      isActive: false,
      endsAtMs: 0,
      totalSeconds: 150,
      notified10s: false
    },
    sRPE: 8,
    isFinished: false
  };

  persistActiveSession();
  hideRecoveryBanner();
  openLiveWorkoutOverlay();
}

function persistActiveSession() {
  try {
    if (activeSession) {
      localStorage.setItem(STORAGE_KEY_ACTIVE_SESSION, JSON.stringify(activeSession));
    } else {
      localStorage.removeItem(STORAGE_KEY_ACTIVE_SESSION);
    }
  } catch (e) {
    console.warn('[LiveWorkout] Ошибка сохранения сессии в localStorage:', e);
  }
}

function checkCrashRecoverySession() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY_ACTIVE_SESSION);
    if (!raw) return;
    const parsed = JSON.parse(raw);
    if (parsed && !parsed.isFinished && Array.isArray(parsed.exercises)) {
      activeSession = parsed;
      showRecoveryBanner();
    }
  } catch (e) {
    console.warn('[LiveWorkout] Ошибка чтения сохраненной сессии:', e);
  }
}

function showRecoveryBanner() {
  const banner = document.getElementById('liveWorkoutRecoveryBanner');
  const infoText = document.getElementById('liveWorkoutRecoveryText');
  if (!banner || !activeSession) return;

  const totalWorkDone = activeSession.exercises.reduce(
    (acc, ex) => acc + ex.completedSets.filter(s => s.category === 'Рабочий').length,
    0
  );
  if (infoText) {
    infoText.innerText = `${activeSession.title} • Рабочих сетов: ${totalWorkDone}`;
  }
  banner.style.display = 'flex';
}

function hideRecoveryBanner() {
  const banner = document.getElementById('liveWorkoutRecoveryBanner');
  if (banner) banner.style.display = 'none';
}

async function requestScreenWakeLock() {
  if ('wakeLock' in navigator) {
    try {
      wakeLockSentinel = await navigator.wakeLock.request('screen');
    } catch (err) {
      console.warn('[WakeLock] Не удалось удерживать экран:', err.message);
    }
  }
}

async function releaseScreenWakeLock() {
  if (wakeLockSentinel) {
    try {
      await wakeLockSentinel.release();
      wakeLockSentinel = null;
    } catch (e) {}
  }
}

function triggerHaptic(pattern) {
  if ('vibrate' in navigator) {
    try {
      navigator.vibrate(pattern);
    } catch (e) {}
  }
}

function openLiveWorkoutOverlay() {
  const overlay = document.getElementById('liveWorkoutOverlay');
  if (!overlay || !activeSession) return;

  overlay.style.display = 'flex';
  document.body.style.overflow = 'hidden';

  requestScreenWakeLock();
  startDurationTicker();
  syncRestTimerWithWallClock();
  renderLiveWorkoutScreen();
}

function minimizeLiveWorkoutOverlay() {
  const overlay = document.getElementById('liveWorkoutOverlay');
  if (overlay) overlay.style.display = 'none';
  document.body.style.overflow = '';
  showRecoveryBanner();
}

function discardLiveWorkoutSession() {
  const confirmAbort = confirm('Отменить и удалить текущую тренировку без сохранения?');
  if (!confirmAbort) return;

  stopAllTimers();
  releaseScreenWakeLock();
  activeSession = null;
  persistActiveSession();
  hideRecoveryBanner();

  const overlay = document.getElementById('liveWorkoutOverlay');
  const closeoutModal = document.getElementById('liveCloseoutModal');
  if (overlay) overlay.style.display = 'none';
  if (closeoutModal) closeoutModal.style.display = 'none';
  document.body.style.overflow = '';
}

function stopAllTimers() {
  if (workoutDurationInterval) {
    clearInterval(workoutDurationInterval);
    workoutDurationInterval = null;
  }
  if (restTimerInterval) {
    clearInterval(restTimerInterval);
    restTimerInterval = null;
  }
}

function startDurationTicker() {
  if (workoutDurationInterval) clearInterval(workoutDurationInterval);
  const updateClock = () => {
    const clockEl = document.getElementById('liveHeaderTimer');
    if (!clockEl || !activeSession) return;
    const elapsedSec = Math.max(0, Math.floor((Date.now() - activeSession.startedAtMs) / 1000));
    const hrs = Math.floor(elapsedSec / 3600);
    const mins = String(Math.floor((elapsedSec % 3600) / 60)).padStart(2, '0');
    const secs = String(elapsedSec % 60).padStart(2, '0');
    clockEl.innerText = hrs > 0 ? `${hrs}:${mins}:${secs}` : `${mins}:${secs}`;
  };
  updateClock();
  workoutDurationInterval = setInterval(updateClock, 1000);
}

/**
 * -------------------------------------------------------------------------
 * ОТРИСОВКА МИНИ-КАРТЫ И ЭКРАНА «У СТАНКА»
 * -------------------------------------------------------------------------
 */
function renderExerciseMiniMap() {
  const mapBox = document.getElementById('liveExMiniMap');
  if (!mapBox || !activeSession) return;
  mapBox.innerHTML = '';

  activeSession.exercises.forEach((ex, idx) => {
    const workDone = ex.completedSets.filter(s => s.category === 'Рабочий').length;
    const isCompleted = ex.isCompleted || (workDone >= ex.targetSets);
    const isCurrent = (idx === activeSession.currentExerciseIndex);

    const pill = document.createElement('button');
    pill.className = `live-minimap-pill ${isCurrent ? 'current' : ''} ${isCompleted ? 'done' : ''}`;
    pill.innerHTML = isCompleted ? `✓ ${idx + 1}` : `${idx + 1}`;
    pill.title = ex.name;

    pill.onclick = () => {
      switchActiveExercise(idx);
    };

    mapBox.appendChild(pill);
  });
}

function renderLiveWorkoutScreen() {
  if (!activeSession) return;

  const exIdx = activeSession.currentExerciseIndex;
  const currentEx = activeSession.exercises[exIdx];
  if (!currentEx) return;

  renderExerciseMiniMap();

  const warmupSetsDone = currentEx.completedSets.filter(s => s.category === 'Разминка').length;
  const workSetsDone = currentEx.completedSets.filter(s => s.category === 'Рабочий').length;
  const totalWarmupSteps = Array.isArray(currentEx.warmupSteps) ? currentEx.warmupSteps.length : 0;

  const titleEl = document.getElementById('liveWorkoutTitle');
  const progressBadgeEl = document.getElementById('liveExProgressBadge');
  const exNameEl = document.getElementById('liveExName');
  const exTargetSubEl = document.getElementById('liveExTargetSubtitle');
  const warmupHintEl = document.getElementById('liveExWarmupHint');
  const intensifierBannerEl = document.getElementById('liveIntensifierBanner');

  if (titleEl) titleEl.innerText = activeSession.title;

  if (progressBadgeEl) {
    const doneTag = (currentEx.isCompleted || workSetsDone >= currentEx.targetSets) ? ' • ✅ ВЫПОЛНЕНО' : '';
    progressBadgeEl.innerText = `Упражнение ${exIdx + 1} из ${activeSession.exercises.length}${doneTag}`;
  }

  if (exNameEl) exNameEl.innerText = currentEx.name;

  if (exTargetSubEl) {
    const specText = (currentEx.plannedMethod && currentEx.plannedMethod !== 'Стандарт')
      ? ` • Финал: <b>${escapeHtml(currentEx.plannedMethod)}</b>`
      : '';
    exTargetSubEl.innerHTML = `План: <b>${currentEx.targetWeight} кг × ${escapeHtml(currentEx.targetRepsStr)}</b> (${currentEx.targetSets} раб. сета, RIR ${escapeHtml(currentEx.targetRir)})${specText}`;
  }

  if (warmupHintEl) {
    warmupHintEl.innerHTML = currentEx.warmupText
      ? `<span class="material-symbols-outlined" style="font-size:15px;">restart_alt</span> Разминка по плану: <b>${escapeHtml(currentEx.warmupText)}</b>`
      : '';
  }

  // Навигация Пред. / След.
  const prevBtn = document.getElementById('livePrevExBtn');
  const nextBtn = document.getElementById('liveNextExBtn');
  if (prevBtn) prevBtn.disabled = (exIdx <= 0);
  if (nextBtn) nextBtn.disabled = (exIdx >= activeSession.exercises.length - 1);

  const isTargetReached = (workSetsDone >= currentEx.targetSets) && !currentEx.allowBonusSet;
  const controlsCard = document.getElementById('liveActiveSetControlsCard');
  const completedCard = document.getElementById('liveExCompletedCard');

  if (isTargetReached) {
    // Все плановые подходы выполнены — показываем крупный блок завершения упражнения!
    if (controlsCard) controlsCard.style.display = 'none';
    if (intensifierBannerEl) intensifierBannerEl.style.display = 'none';
    if (completedCard) {
      completedCard.style.display = 'flex';
      const titleDone = document.getElementById('liveExCompletedTitle');
      const nextExBtn = document.getElementById('liveCompleteAndNextExBtn');
      const nextExIndex = findNextIncompleteExerciseIndex(exIdx);

      if (titleDone) {
        titleDone.innerText = `Упражнение выполнено (${workSetsDone} из ${currentEx.targetSets} рабочих сетов)!`;
      }
      if (nextExBtn) {
        if (nextExIndex !== -1) {
          const nextName = activeSession.exercises[nextExIndex].name;
          nextExBtn.innerHTML = `
            <span class="material-symbols-outlined">task_alt</span>
            <span>ЗАВЕРШИТЬ → УПР. #${nextExIndex + 1} (${escapeHtml(nextName.slice(0, 22))})</span>
          `;
        } else {
          nextExBtn.innerHTML = `
            <span class="material-symbols-outlined">emoji_events</span>
            <span>ЗАВЕРШИТЬ УПРАЖНЕНИЕ И ТРЕНИРОВКУ</span>
          `;
        }
      }
    }
    renderCompletedSetsHistory(currentEx);
    return;
  }

  // Обычный режим ввода подхода
  if (controlsCard) controlsCard.style.display = 'flex';
  if (completedCard) completedCard.style.display = 'none';

  const isWarmupMode = (activeSession.draftSet.category === 'Разминка');
  const isSpecialActive = (!isWarmupMode && activeSession.draftSet.useSpecialMethod);

  // Плашка подсказки интенсификатора показывается, когда активен спецметод
  if (intensifierBannerEl) {
    if (isSpecialActive && currentEx.isDrop) {
      const dropLoad = roundToGymStep(activeSession.draftSet.weight * 0.75);
      intensifierBannerEl.style.display = 'flex';
      intensifierBannerEl.innerHTML = `
        <span class="material-symbols-outlined" style="font-size:18px; color: var(--md-sys-color-warning);">bolt</span>
        <div><b>Финальный Дроп-сет:</b> после отказа сбросьте на <b>${dropLoad} кг (-25%)</b> и дожмите <b>4–6 повт.</b> без отдыха (RIR 0).</div>
      `;
    } else if (isSpecialActive && currentEx.isCluster) {
      const clusterInfo = parseClusterScheme(currentEx.plannedMethod, currentEx.defaultReps);
      intensifierBannerEl.style.display = 'flex';
      intensifierBannerEl.innerHTML = `
        <span class="material-symbols-outlined" style="font-size:18px; color: var(--md-sys-color-primary);">timer</span>
        <div><b>Финальный Кластер (${escapeHtml(clusterInfo.schemeText)}):</b> используйте кнопку <b>«Кластер-пауза 20с»</b> между сегментами. В зачет пойдет сумма повторений (${clusterInfo.totalReps}).</div>
      `;
    } else {
      intensifierBannerEl.style.display = 'none';
    }
  }

  // Заголовок текущего подхода
  const setBadgeEl = document.getElementById('liveCurrentSetLabel');
  if (setBadgeEl) {
    if (isWarmupMode) {
      const stepNum = Math.min(warmupSetsDone + 1, Math.max(1, totalWarmupSteps));
      setBadgeEl.innerText = `РАЗМИНКА: ШАГ ${stepNum} ИЗ ${Math.max(1, totalWarmupSteps)}`;
      setBadgeEl.style.color = 'var(--md-sys-color-success)';
    } else {
      const workNum = workSetsDone + 1;
      const finalBadge = (workNum === currentEx.targetSets) ? ' (ФИНАЛЬНЫЙ)' : '';
      setBadgeEl.innerText = `РАБОЧИЙ ПОДХОД #${workNum} ИЗ ${currentEx.targetSets}${finalBadge}`;
      setBadgeEl.style.color = 'var(--md-sys-color-primary)';
    }
  }

  // Переключатели Разминочный / Рабочий
  const catWarmupBtn = document.getElementById('liveCatWarmupBtn');
  const catWorkBtn = document.getElementById('liveCatWorkBtn');
  if (catWarmupBtn && catWorkBtn) {
    catWarmupBtn.classList.toggle('active', isWarmupMode);
    catWorkBtn.classList.toggle('active', !isWarmupMode);
    catWarmupBtn.innerText = totalWarmupSteps > 0
      ? `Разминка (${warmupSetsDone}/${totalWarmupSteps})`
      : `Разминка (${warmupSetsDone})`;
    catWorkBtn.innerText = `Рабочий (${workSetsDone}/${currentEx.targetSets})`;
  }

  // Кнопка переключения метода на текущем рабочем подходе (Обычный <-> Кластер/Дроп)
  const methodToggleRow = document.getElementById('liveMethodToggleRow');
  const methodToggleBtn = document.getElementById('liveToggleSpecialMethodBtn');
  if (methodToggleRow && methodToggleBtn) {
    if (!isWarmupMode && currentEx.plannedMethod && currentEx.plannedMethod !== 'Стандарт') {
      methodToggleRow.style.display = 'flex';
      if (isSpecialActive) {
        methodToggleBtn.classList.add('active');
        methodToggleBtn.innerText = `⚡ Активен метод: ${currentEx.plannedMethod} (нажмите для обычного)`;
      } else {
        methodToggleBtn.classList.remove('active');
        methodToggleBtn.innerText = `Обычный рабочий сет (включить ${currentEx.plannedMethod})`;
      }
    } else {
      methodToggleRow.style.display = 'none';
    }
  }

  // Отрисовка крупных значений Веса и Повторений
  const weightValEl = document.getElementById('liveWeightValue');
  const repsValEl = document.getElementById('liveRepsValue');
  if (weightValEl) weightValEl.innerText = activeSession.draftSet.weight;
  if (repsValEl) repsValEl.innerText = activeSession.draftSet.reps;

  // Блок RIR (скрываем на разминке, чтобы не перегружать внимание)
  const rirBlockEl = document.getElementById('liveRirBlock');
  if (rirBlockEl) {
    rirBlockEl.style.display = isWarmupMode ? 'none' : 'flex';
  }

  document.querySelectorAll('.live-rir-chip').forEach(chip => {
    const val = chip.getAttribute('data-rir');
    chip.classList.toggle('active', val === String(activeSession.draftSet.rir));
  });

  // Кнопка кластерной микропаузы 20с
  const clusterPauseBtn = document.getElementById('liveClusterPauseBtn');
  if (clusterPauseBtn) {
    const prefs = getTimerPrefs();
    clusterPauseBtn.style.display = isWarmupMode ? 'none' : 'inline-flex';
    clusterPauseBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:16px;">bolt</span><span>Пауза ${prefs.cluster}с</span>`;
  }

  // Главная зеленая кнопка записи подхода
  const recordBtn = document.getElementById('liveRecordSetBtn');
  if (recordBtn) {
    if (isWarmupMode) {
      const stepNum = warmupSetsDone + 1;
      recordBtn.innerHTML = `
        <span class="material-symbols-outlined">check_circle</span>
        <span>ЗАПИСАТЬ РАЗМИНКУ #${stepNum} (${activeSession.draftSet.weight} кг × ${activeSession.draftSet.reps})</span>
      `;
    } else {
      const workNum = workSetsDone + 1;
      const specLabel = isSpecialActive ? ` • ${currentEx.plannedMethod.split(' ')[0].toUpperCase()}` : '';
      recordBtn.innerHTML = `
        <span class="material-symbols-outlined">check_circle</span>
        <span>ЗАПИСАТЬ РАБОЧИЙ СЕТ #${workNum}${specLabel} (${activeSession.draftSet.weight} кг × ${activeSession.draftSet.reps})</span>
      `;
    }
  }

  renderCompletedSetsHistory(currentEx);
}

/**
 * Отрисовка истории с раздельной нумерацией: Разм. #1, #2 и Раб. #1, #2, #3, #4
 */
function renderCompletedSetsHistory(currentEx) {
  const listEl = document.getElementById('liveCompletedSetsList');
  if (!listEl) return;

  if (!currentEx.completedSets || currentEx.completedSets.length === 0) {
    listEl.innerHTML = `<div style="font-size: 0.8rem; color: var(--md-sys-color-on-surface-variant); text-align: center; padding: 8px 0;">Пока нет записанных подходов в этом упражнении</div>`;
    return;
  }

  listEl.innerHTML = '';
  let warmupCounter = 0;
  let workCounter = 0;

  currentEx.completedSets.forEach((s, idx) => {
    const row = document.createElement('div');
    row.className = 'live-history-row';

    const isWarmup = (s.category === 'Разминка');
    const displayNum = isWarmup ? (++warmupCounter) : (++workCounter);
    const labelText = isWarmup ? `Разм. #${displayNum}` : `Раб. #${displayNum}`;
    const badgeColor = isWarmup
      ? 'var(--md-sys-color-on-surface-variant)'
      : 'var(--md-sys-color-success)';

    row.innerHTML = `
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
        <span style="font-weight:700; color:${badgeColor}; min-width:68px;">${escapeHtml(labelText)}</span>
        <span><b>${s.weight} кг × ${s.reps}</b></span>
        ${!isWarmup && s.reserve ? `<span class="coach-card-chip">RIR ${escapeHtml(s.reserve.replace('+', ''))}</span>` : ''}
        ${!isWarmup && s.method ? `<span class="coach-method-badge">${escapeHtml(s.method)}</span>` : ''}
      </div>
      <button class="live-delete-set-btn" data-set-idx="${idx}" title="Удалить подход">
        <span class="material-symbols-outlined" style="font-size:18px;">delete</span>
      </button>
    `;

    const delBtn = row.querySelector('.live-delete-set-btn');
    if (delBtn) {
      delBtn.onclick = () => {
        currentEx.completedSets.splice(idx, 1);
        currentEx.completedSets.forEach((item, i) => { item.setNum = i + 1; });
        currentEx.isCompleted = false;
        currentEx.allowBonusSet = false;
        activeSession.draftSet = computeSmartDraftSetForExercise(currentEx);
        persistActiveSession();
        renderLiveWorkoutScreen();
      };
    }

    listEl.appendChild(row);
  });
}

/**
 * -------------------------------------------------------------------------
 * ЗАПИСЬ ПОДХОДА И УМНЫЙ ПЕРЕХОД ПО ШАГАМ
 * -------------------------------------------------------------------------
 */
function handleRecordCurrentSet() {
  if (!activeSession) return;
  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  if (!currentEx) return;

  const isWarmup = (activeSession.draftSet.category === 'Разминка');
  const weight = parseFloat(activeSession.draftSet.weight) || 0;
  const reps = parseInt(activeSession.draftSet.reps, 10) || 0;
  const rirRaw = String(activeSession.draftSet.rir || '2');

  if (weight <= 0 || reps <= 0) {
    alert('Вес и повторения должны быть больше нуля.');
    return;
  }

  let effort = 'Высокое';
  let reserve = `+${rirRaw.replace('+', '')}`;

  if (isWarmup) {
    effort = 'Размин.';
    reserve = '';
  } else if (rirRaw === '0') {
    effort = 'Максим.';
    reserve = '+0';
  } else if (rirRaw === '3+') {
    effort = 'Среднее';
    reserve = '+3';
  }

  // Метод пишется ТОЛЬКО если это рабочий подход и для него включен спецметод!
  const appliedMethod = (!isWarmup && activeSession.draftSet.useSpecialMethod && currentEx.plannedMethod !== 'Стандарт')
    ? currentEx.plannedMethod
    : '';

  let firstSegmentReps = reps;
  if (appliedMethod && currentEx.isCluster) {
    const clusterInfo = parseClusterScheme(appliedMethod, currentEx.defaultReps);
    firstSegmentReps = clusterInfo.firstSegmentReps;
  }

  const setNum = currentEx.completedSets.length + 1;
  const tonnage = parseFloat((weight * reps).toFixed(1));
  const e1rm = (!isWarmup && firstSegmentReps > 0 && weight > 0)
    ? (firstSegmentReps === 1 ? weight : parseFloat((weight * (1 + firstSegmentReps / 30)).toFixed(1)))
    : 0.0;

  const recordedSet = {
    setNum: setNum,
    weight: weight,
    reps: reps,
    firstSegmentReps: firstSegmentReps,
    effort: effort,
    reserve: reserve,
    method: appliedMethod,
    category: isWarmup ? 'Разминка' : 'Рабочий',
    tonnage: tonnage,
    e1rm: e1rm,
    recordedAt: new Date().toTimeString().slice(0, 8)
  };

  currentEx.completedSets.push(recordedSet);
  currentEx.allowBonusSet = false;

  const workDoneAfter = currentEx.completedSets.filter(s => s.category === 'Рабочий').length;
  if (workDoneAfter >= currentEx.targetSets) {
    currentEx.isCompleted = true;
  }

  triggerHaptic([80]);

  // Автоматический расчет следующего шага (Разминка #2 -> #3 -> Рабочий #1 -> ... -> Финальный с кластером)
  activeSession.draftSet = computeSmartDraftSetForExercise(currentEx);

  // Запуск таймера отдыха
  const prefs = getTimerPrefs();
  let restSeconds = prefs.compound;
  if (isWarmup) {
    restSeconds = prefs.warmup;
  } else if (currentEx.order > 2) {
    restSeconds = prefs.isolation;
  }

  startRestTimer(restSeconds);
  persistActiveSession();
  renderLiveWorkoutScreen();
}

function findNextIncompleteExerciseIndex(fromIndex) {
  if (!activeSession) return -1;
  const total = activeSession.exercises.length;
  for (let i = fromIndex + 1; i < total; i++) {
    const ex = activeSession.exercises[i];
    const workDone = ex.completedSets.filter(s => s.category === 'Рабочий').length;
    if (!ex.isCompleted && workDone < ex.targetSets) return i;
  }
  for (let i = 0; i < fromIndex; i++) {
    const ex = activeSession.exercises[i];
    const workDone = ex.completedSets.filter(s => s.category === 'Рабочий').length;
    if (!ex.isCompleted && workDone < ex.targetSets) return i;
  }
  return -1;
}

function handleCompleteCurrentAndMoveNext() {
  if (!activeSession) return;
  const curIdx = activeSession.currentExerciseIndex;
  const currentEx = activeSession.exercises[curIdx];
  if (currentEx) {
    currentEx.isCompleted = true;
    currentEx.allowBonusSet = false;
  }

  const nextIdx = findNextIncompleteExerciseIndex(curIdx);
  if (nextIdx !== -1) {
    switchActiveExercise(nextIdx);
  } else {
    persistActiveSession();
    renderLiveWorkoutScreen();
    openCloseoutModal();
  }
}

function startRestTimer(seconds) {
  if (!activeSession) return;

  activeSession.restState = {
    isActive: true,
    endsAtMs: Date.now() + (seconds * 1000),
    totalSeconds: seconds,
    notified10s: false
  };

  persistActiveSession();
  syncRestTimerWithWallClock();
}

function adjustRestTimer(deltaSeconds) {
  if (!activeSession || !activeSession.restState.isActive) return;
  activeSession.restState.endsAtMs += (deltaSeconds * 1000);
  activeSession.restState.totalSeconds = Math.max(10, activeSession.restState.totalSeconds + deltaSeconds);
  persistActiveSession();
  syncRestTimerWithWallClock();
}

function stopRestTimer() {
  if (!activeSession) return;
  activeSession.restState.isActive = false;
  activeSession.restState.endsAtMs = 0;
  if (restTimerInterval) {
    clearInterval(restTimerInterval);
    restTimerInterval = null;
  }
  const bar = document.getElementById('liveRestTimerBar');
  if (bar) bar.style.display = 'none';
  persistActiveSession();
}

function syncRestTimerWithWallClock() {
  const bar = document.getElementById('liveRestTimerBar');
  const countEl = document.getElementById('liveRestCountdown');
  if (!bar || !countEl || !activeSession) return;

  if (!activeSession.restState || !activeSession.restState.isActive) {
    bar.style.display = 'none';
    if (restTimerInterval) clearInterval(restTimerInterval);
    return;
  }

  bar.style.display = 'flex';
  if (restTimerInterval) clearInterval(restTimerInterval);

  const tick = () => {
    if (!activeSession || !activeSession.restState.isActive) return;
    const remainingSec = Math.ceil((activeSession.restState.endsAtMs - Date.now()) / 1000);

    if (remainingSec <= 10 && remainingSec > 0 && !activeSession.restState.notified10s) {
      activeSession.restState.notified10s = true;
      triggerHaptic([150, 100, 150]);
    }

    if (remainingSec <= 0) {
      triggerHaptic([400, 180, 400, 180, 400]);
      stopRestTimer();
      return;
    }

    const m = String(Math.floor(remainingSec / 60)).padStart(2, '0');
    const s = String(remainingSec % 60).padStart(2, '0');
    countEl.innerText = `${m}:${s}`;
  };

  tick();
  restTimerInterval = setInterval(tick, 250);
}

function switchActiveExercise(newIndex) {
  if (!activeSession) return;
  if (newIndex < 0 || newIndex >= activeSession.exercises.length) return;

  activeSession.currentExerciseIndex = newIndex;
  const ex = activeSession.exercises[newIndex];
  activeSession.draftSet = computeSmartDraftSetForExercise(ex);

  persistActiveSession();
  renderLiveWorkoutScreen();
}

/**
 * -------------------------------------------------------------------------
 * ЗАВЕРШЕНИЕ ТРЕНИРОВКИ И СИНХРОНИЗАЦИЯ С GOOGLE SHEETS
 * -------------------------------------------------------------------------
 */
function openCloseoutModal() {
  if (!activeSession) return;

  let totalWorkSets = 0;
  let totalWarmupSets = 0;
  let workTonnageKg = 0;

  activeSession.exercises.forEach(ex => {
    ex.completedSets.forEach(s => {
      if (s.category === 'Рабочий') {
        totalWorkSets++;
        workTonnageKg += (s.tonnage || 0);
      } else {
        totalWarmupSets++;
      }
    });
  });

  if (totalWorkSets === 0 && totalWarmupSets === 0) {
    alert('Вы еще не записали ни одного подхода!');
    return;
  }

  const elapsedMin = Math.max(1, Math.round((Date.now() - activeSession.startedAtMs) / 60000));
  const summaryBox = document.getElementById('liveCloseoutSummaryStats');
  if (summaryBox) {
    summaryBox.innerHTML = `
      <div>• Тренировка: <b>${escapeHtml(activeSession.title)}</b> (${escapeHtml(activeSession.date)})</div>
      <div>• Чистое время: <b>${elapsedMin} мин</b></div>
      <div>• Рабочих подходов: <b>${totalWorkSets}</b> (разминочных: ${totalWarmupSets})</div>
      <div>• Рабочий тоннаж: <b>${(workTonnageKg / 1000).toFixed(2)} т</b> (${Math.round(workTonnageKg)} кг)</div>
    `;
  }

  const modal = document.getElementById('liveCloseoutModal');
  if (modal) modal.style.display = 'flex';
}

async function finalizeAndSyncLiveWorkout() {
  if (!activeSession) return;
  const saveBtn = document.getElementById('liveConfirmFinishBtn');
  const statusEl = document.getElementById('liveCloseoutSyncStatus');

  const flatSets = [];
  const allExercises = [];
  let globalIdx = 0;

  activeSession.exercises.forEach(ex => {
    if (ex.completedSets.length > 0 && !allExercises.includes(ex.name)) {
      allExercises.push(ex.name);
    }

    ex.completedSets.forEach(s => {
      globalIdx++;
      const setId = `${activeSession.date}_${activeSession.startTime}_${ex.name}_set${s.setNum}_idx${globalIdx}`;
      flatSets.push({
        id: setId,
        date: activeSession.date,
        startTime: activeSession.startTime,
        title: activeSession.title,
        exercise: ex.name,
        setNum: s.setNum,
        weight: s.weight,
        reps: s.reps,
        firstSegmentReps: s.firstSegmentReps || s.reps,
        effort: s.effort,
        reserve: s.reserve,
        method: s.method,
        equipment: `sRPE ${activeSession.sRPE || 8}`,
        positioning: '',
        splitDay: activeSession.splitDay,
        cycleMode: activeSession.cycleMode,
        waveIndex: activeSession.waveIndex,
        cycleWeek: activeSession.cycleWeek,
        cycleId: activeSession.cycleId,
        category: s.category,
        tonnage: s.tonnage,
        e1rm: s.e1rm
      });
    });
  });

  if (saveBtn) saveBtn.disabled = true;
  if (statusEl) {
    statusEl.style.display = 'block';
    statusEl.style.color = 'var(--md-sys-color-primary)';
    statusEl.innerText = '⏳ Отправка тренировки в Google Таблицы и обратная верификация...';
  }

  try {
    const payload = {
      action: 'sync_sets',
      overwrite: true,
      date: activeSession.date,
      startTime: activeSession.startTime,
      sets: flatSets,
      allExercises: allExercises
    };

    await syncSetsToSheets(payload);
    const freshData = await fetchAnalyticsData();
    if (freshData.success && freshData.data) {
      setInitialData(freshData.data);
    }

    stopAllTimers();
    await releaseScreenWakeLock();
    activeSession = null;
    persistActiveSession();
    hideRecoveryBanner();

    const closeoutModal = document.getElementById('liveCloseoutModal');
    const overlay = document.getElementById('liveWorkoutOverlay');
    if (closeoutModal) closeoutModal.style.display = 'none';
    if (overlay) overlay.style.display = 'none';
    document.body.style.overflow = '';

    if (typeof onWorkoutCompletedCallback === 'function') {
      await onWorkoutCompletedCallback();
    }

    alert('Тренировка успешно сохранена в базу данных Google Таблиц!');
  } catch (err) {
    if (statusEl) {
      statusEl.style.color = 'var(--md-sys-color-error)';
      statusEl.innerText = `❌ Сбой сети: ${err.message}. Данные сохранены в памяти телефона — повторите отправку при появлении связи.`;
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

/**
 * -------------------------------------------------------------------------
 * ПРИВЯЗКА СОБЫТИЙ ИНТЕРФЕЙСА И НАСТРОЕК ТАЙМЕРОВ
 * -------------------------------------------------------------------------
 */
function bindLiveWorkoutDomEvents() {
  const resumeBtn = document.getElementById('liveResumeBannerBtn');
  if (resumeBtn) resumeBtn.onclick = () => openLiveWorkoutOverlay();

  const minBtn = document.getElementById('liveMinimizeBtn');
  if (minBtn) minBtn.onclick = () => minimizeLiveWorkoutOverlay();

  const finishOpenBtn = document.getElementById('liveOpenFinishModalBtn');
  if (finishOpenBtn) finishOpenBtn.onclick = () => openCloseoutModal();

  const prevBtn = document.getElementById('livePrevExBtn');
  const nextBtn = document.getElementById('liveNextExBtn');
  if (prevBtn) prevBtn.onclick = () => switchActiveExercise(activeSession.currentExerciseIndex - 1);
  if (nextBtn) nextBtn.onclick = () => switchActiveExercise(activeSession.currentExerciseIndex + 1);

  // Ручное переключение на вкладку Разминка / Рабочий сет
  const catWarmupBtn = document.getElementById('liveCatWarmupBtn');
  const catWorkBtn = document.getElementById('liveCatWorkBtn');
  if (catWarmupBtn) {
    catWarmupBtn.onclick = () => {
      if (!activeSession) return;
      const ex = activeSession.exercises[activeSession.currentExerciseIndex];
      const warmupDone = ex.completedSets.filter(s => s.category === 'Разминка').length;
      const steps = Array.isArray(ex.warmupSteps) && ex.warmupSteps.length > 0 ? ex.warmupSteps : [];
      const targetWarmupStep = steps[Math.min(warmupDone, Math.max(0, steps.length - 1))];

      activeSession.draftSet.category = 'Разминка';
      activeSession.draftSet.weight = targetWarmupStep ? targetWarmupStep.weight : roundToGymStep(ex.targetWeight * 0.6);
      activeSession.draftSet.reps = targetWarmupStep ? targetWarmupStep.reps : 6;
      activeSession.draftSet.useSpecialMethod = false;
      persistActiveSession();
      renderLiveWorkoutScreen();
    };
  }
  if (catWorkBtn) {
    catWorkBtn.onclick = () => {
      if (!activeSession) return;
      const ex = activeSession.exercises[activeSession.currentExerciseIndex];
      const workDone = ex.completedSets.filter(s => s.category === 'Рабочий').length;
      const isFinalSet = (workDone + 1 === ex.targetSets);
      const hasSpecial = ex.plannedMethod && ex.plannedMethod !== 'Стандарт';
      const useSpecial = Boolean(hasSpecial && isFinalSet);

      let reps = ex.defaultReps;
      if (useSpecial && ex.isCluster) {
        reps = parseClusterScheme(ex.plannedMethod, ex.defaultReps).totalReps;
      }

      activeSession.draftSet.category = 'Рабочий';
      activeSession.draftSet.weight = ex.targetWeight;
      activeSession.draftSet.reps = reps;
      activeSession.draftSet.useSpecialMethod = useSpecial;
      persistActiveSession();
      renderLiveWorkoutScreen();
    };
  }

  // Ручной тоггл спецметода (Кластер / Дроп-сет) на текущем рабочем подходе
  const toggleSpecialBtn = document.getElementById('liveToggleSpecialMethodBtn');
  if (toggleSpecialBtn) {
    toggleSpecialBtn.onclick = () => {
      if (!activeSession) return;
      const ex = activeSession.exercises[activeSession.currentExerciseIndex];
      activeSession.draftSet.useSpecialMethod = !activeSession.draftSet.useSpecialMethod;
      if (ex.isCluster) {
        if (activeSession.draftSet.useSpecialMethod) {
          activeSession.draftSet.reps = parseClusterScheme(ex.plannedMethod, ex.defaultReps).totalReps;
        } else {
          activeSession.draftSet.reps = ex.defaultReps;
        }
      }
      triggerHaptic(30);
      persistActiveSession();
      renderLiveWorkoutScreen();
    };
  }

  // Кнопки карточки выполненного упражнения
  const completeNextBtn = document.getElementById('liveCompleteAndNextExBtn');
  const addBonusSetBtn = document.getElementById('liveAddBonusSetBtn');
  if (completeNextBtn) {
    completeNextBtn.onclick = () => handleCompleteCurrentAndMoveNext();
  }
  if (addBonusSetBtn) {
    addBonusSetBtn.onclick = () => {
      if (!activeSession) return;
      const ex = activeSession.exercises[activeSession.currentExerciseIndex];
      ex.allowBonusSet = true;
      ex.isCompleted = false;
      activeSession.draftSet = {
        category: 'Рабочий',
        weight: ex.targetWeight,
        reps: ex.defaultReps,
        rir: '1',
        useSpecialMethod: false
      };
      persistActiveSession();
      renderLiveWorkoutScreen();
    };
  }

  // Степперы Веса (-2.5 / +2.5)
  const wMinus = document.getElementById('liveWeightMinusBtn');
  const wPlus = document.getElementById('liveWeightPlusBtn');
  if (wMinus) {
    wMinus.onclick = () => {
      if (!activeSession) return;
      activeSession.draftSet.weight = Math.max(0, activeSession.draftSet.weight - 2.5);
      triggerHaptic(20);
      persistActiveSession();
      renderLiveWorkoutScreen();
    };
  }
  if (wPlus) {
    wPlus.onclick = () => {
      if (!activeSession) return;
      activeSession.draftSet.weight = activeSession.draftSet.weight + 2.5;
      triggerHaptic(20);
      persistActiveSession();
      renderLiveWorkoutScreen();
    };
  }

  // Степперы Повторений (-1 / +1)
  const rMinus = document.getElementById('liveRepsMinusBtn');
  const rPlus = document.getElementById('liveRepsPlusBtn');
  if (rMinus) {
    rMinus.onclick = () => {
      if (!activeSession) return;
      activeSession.draftSet.reps = Math.max(1, activeSession.draftSet.reps - 1);
      triggerHaptic(20);
      persistActiveSession();
      renderLiveWorkoutScreen();
    };
  }
  if (rPlus) {
    rPlus.onclick = () => {
      if (!activeSession) return;
      activeSession.draftSet.reps = activeSession.draftSet.reps + 1;
      triggerHaptic(20);
      persistActiveSession();
      renderLiveWorkoutScreen();
    };
  }

  // Чипы RIR
  document.querySelectorAll('.live-rir-chip').forEach(chip => {
    chip.onclick = () => {
      if (!activeSession) return;
      activeSession.draftSet.rir = chip.getAttribute('data-rir') || '2';
      triggerHaptic(20);
      persistActiveSession();
      renderLiveWorkoutScreen();
    };
  });

  // Кластерная микропауза 20с
  const clusterBtn = document.getElementById('liveClusterPauseBtn');
  if (clusterBtn) {
    clusterBtn.onclick = () => {
      const prefs = getTimerPrefs();
      triggerHaptic(50);
      startRestTimer(prefs.cluster);
    };
  }

  // Запись подхода
  const recordBtn = document.getElementById('liveRecordSetBtn');
  if (recordBtn) {
    recordBtn.onclick = () => handleRecordCurrentSet();
  }

  // Управление таймером отдыха (-30с / +30с / Пропустить)
  const restMinusBtn = document.getElementById('liveRestMinus30Btn');
  const restPlusBtn = document.getElementById('liveRestPlus30Btn');
  const restSkipBtn = document.getElementById('liveRestSkipBtn');
  if (restMinusBtn) restMinusBtn.onclick = () => adjustRestTimer(-30);
  if (restPlusBtn) restPlusBtn.onclick = () => adjustRestTimer(30);
  if (restSkipBtn) restSkipBtn.onclick = () => stopRestTimer();

  // Настройки таймеров отдыха
  const openTimerPrefsBtn = document.getElementById('liveOpenTimerSettingsBtn');
  const timerPrefsModal = document.getElementById('liveTimerSettingsModal');
  const closeTimerPrefsBtn = document.getElementById('closeLiveTimerSettingsBtn');
  const saveTimerPrefsBtn = document.getElementById('saveLiveTimerSettingsBtn');

  if (openTimerPrefsBtn && timerPrefsModal) {
    openTimerPrefsBtn.onclick = () => {
      const prefs = getTimerPrefs();
      document.getElementById('prefTimerCompound').value = prefs.compound;
      document.getElementById('prefTimerIsolation').value = prefs.isolation;
      document.getElementById('prefTimerCluster').value = prefs.cluster;
      timerPrefsModal.style.display = 'flex';
    };
  }
  if (closeTimerPrefsBtn && timerPrefsModal) {
    closeTimerPrefsBtn.onclick = () => { timerPrefsModal.style.display = 'none'; };
  }
  if (saveTimerPrefsBtn && timerPrefsModal) {
    saveTimerPrefsBtn.onclick = () => {
      const newPrefs = {
        compound: Math.max(10, parseInt(document.getElementById('prefTimerCompound').value, 10) || 150),
        isolation: Math.max(10, parseInt(document.getElementById('prefTimerIsolation').value, 10) || 90),
        cluster: Math.max(5, parseInt(document.getElementById('prefTimerCluster').value, 10) || 20),
        warmup: 60
      };
      saveTimerPrefs(newPrefs);
      timerPrefsModal.style.display = 'none';
      renderLiveWorkoutScreen();
    };
  }

  // Модальное окно завершения (Close-out)
  const closeCloseoutBtn = document.getElementById('closeLiveCloseoutModalBtn');
  const confirmFinishBtn = document.getElementById('liveConfirmFinishBtn');
  const discardSessionBtn = document.getElementById('liveDiscardWorkoutBtn');

  if (closeCloseoutBtn) {
    closeCloseoutBtn.onclick = () => {
      document.getElementById('liveCloseoutModal').style.display = 'none';
    };
  }

  document.querySelectorAll('.live-srpe-chip').forEach(chip => {
    chip.onclick = () => {
      if (!activeSession) return;
      activeSession.sRPE = parseInt(chip.getAttribute('data-srpe'), 10) || 8;
      document.querySelectorAll('.live-srpe-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      persistActiveSession();
    };
  });

  if (confirmFinishBtn) {
    confirmFinishBtn.onclick = () => finalizeAndSyncLiveWorkout();
  }

  if (discardSessionBtn) {
    discardSessionBtn.onclick = () => discardLiveWorkoutSession();
  }
}
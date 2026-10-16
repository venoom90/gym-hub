/**
 * =========================================================================
 * GYM ANALYTICS HUB — LIVE WORKOUT ENGINE (V1.5.1 MODAL MANAGER + NOTES + LOG)
 * =========================================================================
 * V1.5.1:
 * - Логирование ключевых событий в общий терминал Sync (logToTerminal).
 * - Enter в поле «Оборудование» переводит фокус на «Технику» (без newline).
 * - Auto-resize textarea оборудования при вводе.
 */

import {
  state, setInitialData, formatDateDisplay, escapeHtml, computeE1RM,
  getLastSetFieldForExercise
} from './state.js';
import { syncSetsToSheets, fetchAnalyticsData } from './api.js';
import { registerModal, openModal, closeModal, isModalOpen, resetAllModals } from './modal_manager.js';
import { logToTerminal } from './sync.js';

const STORAGE_KEY_ACTIVE_SESSION = 'gym_active_live_workout_v1';
const STORAGE_KEY_TIMER_PREFS = 'gym_live_timer_prefs_v1';

let activeSession = null;
let workoutDurationInterval = null;
let restTimerInterval = null;
let wakeLockSentinel = null;
let onWorkoutCompletedCallback = null;
let isLiveWorkoutInitialized = false;

const DEFAULT_TIMERS = {
  compound: 150,
  isolation: 90,
  cluster: 20,
  warmup: 60
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

/* =========================================================
 * MODAL MANAGER registration
 * ========================================================= */

function registerLiveModals() {
  if (isLiveWorkoutInitialized) return;
  isLiveWorkoutInitialized = true;

  const overlay = document.getElementById('liveWorkoutOverlay');
  if (overlay) {
    registerModal('liveWorkoutOverlay', {
      el: overlay,
      displayStyle: 'flex',
      onOpen: () => {
        document.body.style.overflow = 'hidden';
        requestScreenWakeLock();
        startDurationTicker();
        syncRestTimerWithWallClock();
        renderLiveWorkoutScreen();
      },
      onClose: () => {
        document.body.style.overflow = '';
        showRecoveryBanner();
      }
    });
  }

  const closeoutModal = document.getElementById('liveCloseoutModal');
  if (closeoutModal) {
    registerModal('liveCloseoutModal', {
      el: closeoutModal,
      displayStyle: 'flex',
      onOpen: () => renderCloseoutSummaryBox()
    });
    const closeCloseoutBtn = document.getElementById('closeLiveCloseoutModalBtn');
    if (closeCloseoutBtn) closeCloseoutBtn.onclick = () => closeModal('liveCloseoutModal');
    closeoutModal.onclick = (e) => { if (e.target === closeoutModal) closeModal('liveCloseoutModal'); };
  }

  const timerSettingsModal = document.getElementById('liveTimerSettingsModal');
  if (timerSettingsModal) {
    registerModal('liveTimerSettingsModal', {
      el: timerSettingsModal,
      displayStyle: 'flex'
    });
    const closeBtn = document.getElementById('closeLiveTimerSettingsBtn');
    if (closeBtn) closeBtn.onclick = () => closeModal('liveTimerSettingsModal');
    timerSettingsModal.onclick = (e) => { if (e.target === timerSettingsModal) closeModal('liveTimerSettingsModal'); };
  }

  const notesSheet = document.getElementById('liveNotesSheet');
  if (notesSheet) {
    registerModal('liveNotesSheet', {
      el: notesSheet,
      displayStyle: 'flex'
    });
    notesSheet.onclick = (e) => { if (e.target === notesSheet) closeModal('liveNotesSheet'); };
  }
}

/* =========================================================
 * TIMER PREFS
 * ========================================================= */

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

/* =========================================================
 * HELPERS
 * ========================================================= */

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

function computeSmartDraftSetForExercise(ex) {
  const warmupDoneCount = ex.completedSets.filter(s => s.category === 'Разминка').length;
  const workDoneCount = ex.completedSets.filter(s => s.category === 'Рабочий').length;
  const warmupSteps = Array.isArray(ex.warmupSteps) && ex.warmupSteps.length > 0 ? ex.warmupSteps : [];

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

  const nextWorkSetNumber = workDoneCount + 1;
  const hasPlannedSpecialMethod = ex.plannedMethod && ex.plannedMethod !== 'Стандарт';
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

/* =========================================================
 * START WORKOUT
 * ========================================================= */

export function startNewLiveWorkout(recipePayload) {
  if (!recipePayload || !Array.isArray(recipePayload.exercises) || recipePayload.exercises.length === 0) {
    alert('План тренировки пуст. Сначала загрузите данные или сформируйте план у Тренера.');
    return;
  }

  if (activeSession && !activeSession.isFinished) {
    const confirmOverwrite = confirm('У вас уже есть незавершенная тренировка. Начать новую (текущий прогресс будет сброшен)?');
    if (!confirmOverwrite) {
      registerLiveModals();
      openModal('liveWorkoutOverlay');
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

    const historicalEquipment = getLastSetFieldForExercise(ex.name, 'equipment');
    const historicalTechnique = getLastSetFieldForExercise(ex.name, 'positioning');

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
      equipment: historicalEquipment || '',
      technique: historicalTechnique || '',
      completedSets: [],
      isCompleted: false,
      allowBonusSet: false
    };
  });

  const firstEx = exercisesQueue[0];
  const initialDraft = computeSmartDraftSetForExercise(firstEx);

  activeSession = {
    sessionId: `w_${Date.now()}`,
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
    readinessPre: '🟢 Оптимум',
    sRPE: 8,
    isFinished: false
  };

  persistActiveSession();
  hideRecoveryBanner();

  logToTerminal('LIVE_START', `Старт: ${activeSession.title} • ${exercisesQueue.length} упр.`, 'success');

  registerLiveModals();
  openModal('liveWorkoutOverlay');
}

/* =========================================================
 * PERSISTENCE / RECOVERY
 * ========================================================= */

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
      const totalWorkDone = activeSession.exercises.reduce(
        (acc, ex) => acc + ex.completedSets.filter(s => s.category === 'Рабочий').length,
        0
      );
      logToTerminal('LIVE_RECOVER', `Восстановлена сессия: ${activeSession.title} • ${totalWorkDone} раб. сетов`, 'info');
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

/* =========================================================
 * WAKE LOCK / HAPTIC
 * ========================================================= */

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

/* =========================================================
 * OVERLAY OPEN/MINIMIZE (через ModalManager)
 * ========================================================= */

function openLiveWorkoutOverlay() {
  if (!activeSession) return;
  registerLiveModals();
  openModal('liveWorkoutOverlay');
  logToTerminal('LIVE_RESUME', `Возврат в тренировку: ${activeSession.title}`, 'info');
}

function minimizeLiveWorkoutOverlay() {
  logToTerminal('LIVE_MINIMIZE', `Свернуто: ${activeSession ? activeSession.title : 'без сессии'}`, 'info');
  if (isModalOpen('liveWorkoutOverlay')) {
    closeModal('liveWorkoutOverlay');
  } else {
    const overlay = document.getElementById('liveWorkoutOverlay');
    if (overlay) overlay.style.display = 'none';
    document.body.style.overflow = '';
    showRecoveryBanner();
  }
}

function discardLiveWorkoutSession() {
  const confirmAbort = confirm('Отменить и удалить текущую тренировку без сохранения?');
  if (!confirmAbort) return;

  logToTerminal('LIVE_DISCARD', `Тренировка удалена без сохранения: ${activeSession ? activeSession.title : '—'}`, 'info');

  stopAllTimers();
  releaseScreenWakeLock();
  activeSession = null;
  persistActiveSession();
  hideRecoveryBanner();

  resetAllModals();
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

/* =========================================================
 * RENDER — MINIMAP
 * ========================================================= */

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

    pill.onclick = () => switchActiveExercise(idx);

    mapBox.appendChild(pill);
  });
}

/* =========================================================
 * NOTE CHIPS (equipment/technique)
 * ========================================================= */

function renderExerciseNoteChips() {
  if (!activeSession) return;
  const ex = activeSession.exercises[activeSession.currentExerciseIndex];
  if (!ex) return;

  const equipChip = document.getElementById('liveEquipmentChip');
  const equipVal = document.getElementById('liveEquipmentValue');
  const techChip = document.getElementById('liveTechniqueChip');
  const techVal = document.getElementById('liveTechniqueValue');

  if (equipChip && equipVal) {
    if (ex.equipment && String(ex.equipment).trim()) {
      equipChip.classList.remove('is-empty');
      equipVal.innerText = String(ex.equipment).trim();
    } else {
      equipChip.classList.add('is-empty');
      equipVal.innerText = '';
    }
  }

  if (techChip && techVal) {
    if (ex.technique && String(ex.technique).trim()) {
      techChip.classList.remove('is-empty');
      techVal.innerText = String(ex.technique).trim();
    } else {
      techChip.classList.add('is-empty');
      techVal.innerText = '';
    }
  }
}

function autoResizeNotesField(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 80) + 'px';
}

function openNotesSheet() {
  if (!activeSession) return;
  const ex = activeSession.exercises[activeSession.currentExerciseIndex];
  if (!ex) return;

  const equipInput = document.getElementById('liveNotesEquipmentInput');
  const techInput = document.getElementById('liveNotesTechniqueInput');
  const subtitleEl = document.getElementById('liveNotesSheetSubtitle');

  if (equipInput) equipInput.value = ex.equipment || '';
  if (techInput) techInput.value = ex.technique || '';
  if (subtitleEl) subtitleEl.innerText = ex.name;

  registerLiveModals();
  openModal('liveNotesSheet');

  // После отображения (когда layout посчитан) — auto-resize
  setTimeout(() => {
    if (equipInput) autoResizeNotesField(equipInput);
  }, 50);
}

function saveNotesSheet() {
  if (!activeSession) return;
  const ex = activeSession.exercises[activeSession.currentExerciseIndex];
  if (!ex) return;

  const equipInput = document.getElementById('liveNotesEquipmentInput');
  const techInput = document.getElementById('liveNotesTechniqueInput');

  ex.equipment = equipInput ? equipInput.value.trim() : '';
  ex.technique = techInput ? techInput.value.trim() : '';

  persistActiveSession();
  renderExerciseNoteChips();
  closeModal('liveNotesSheet');
  triggerHaptic([30]);
}

/* =========================================================
 * RENDER — MAIN SCREEN
 * ========================================================= */

function renderLiveWorkoutScreen() {
  if (!activeSession) return;

  const exIdx = activeSession.currentExerciseIndex;
  const currentEx = activeSession.exercises[exIdx];
  if (!currentEx) return;

  renderExerciseMiniMap();
  renderExerciseNoteChips();

  const warmupSetsDone = currentEx.completedSets.filter(s => s.category === 'Разминка').length;
  const workSetsDone = currentEx.completedSets.filter(s => s.category === 'Рабочий').length;
  const totalWarmupSteps = Math.max(1, Array.isArray(currentEx.warmupSteps) ? currentEx.warmupSteps.length : 1);

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

  const prevBtn = document.getElementById('livePrevExBtn');
  const nextBtn = document.getElementById('liveNextExBtn');
  if (prevBtn) prevBtn.disabled = (exIdx <= 0);
  if (nextBtn) nextBtn.disabled = (exIdx >= activeSession.exercises.length - 1);

  const isTargetReached = (workSetsDone >= currentEx.targetSets) && !currentEx.allowBonusSet;
  const controlsCard = document.getElementById('liveActiveSetControlsCard');
  const completedCard = document.getElementById('liveExCompletedCard');

  if (isTargetReached) {
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

  if (controlsCard) controlsCard.style.display = 'flex';
  if (completedCard) completedCard.style.display = 'none';

  const isWarmupMode = (activeSession.draftSet.category === 'Разминка');
  const isSpecialActive = (!isWarmupMode && activeSession.draftSet.useSpecialMethod);

  if (intensifierBannerEl) {
    if (isSpecialActive && currentEx.isDrop) {
      const dropLoad = roundToGymStep(activeSession.draftSet.weight * 0.75);
      intensifierBannerEl.style.display = 'flex';
      intensifierBannerEl.innerHTML = `
        <span class="material-symbols-outlined" style="font-size:18px; color: var(--app-color-warning);">bolt</span>
        <div><b>Финальный Дроп-сет:</b> после основного подхода сбросьте вес на <b>${dropLoad} кг (-25%)</b> и дожмите <b>5 повт.</b> без отдыха (учтется в тоннаже автоматически).</div>
      `;
    } else if (isSpecialActive && currentEx.isCluster) {
      const clusterInfo = parseClusterScheme(currentEx.plannedMethod, currentEx.defaultReps);
      intensifierBannerEl.style.display = 'flex';
      intensifierBannerEl.innerHTML = `
        <span class="material-symbols-outlined" style="font-size:18px; color: var(--md-sys-color-primary);">timer</span>
        <div><b>Финальный Кластер (${escapeHtml(clusterInfo.schemeText)}):</b> используйте кнопку <b>«Пауза 20с»</b> между сегментами. В зачет идет сумма повторений (${clusterInfo.totalReps}).</div>
      `;
    } else {
      intensifierBannerEl.style.display = 'none';
    }
  }

  const currentWarmupStepNum = Math.min(warmupSetsDone + 1, totalWarmupSteps);
  const currentWorkSetNum = workSetsDone + 1;

  const setBadgeEl = document.getElementById('liveCurrentSetLabel');
  if (setBadgeEl) {
    if (isWarmupMode) {
      setBadgeEl.innerText = `РАЗМИНКА: ШАГ ${currentWarmupStepNum} ИЗ ${totalWarmupSteps}`;
      setBadgeEl.style.color = 'var(--app-color-success)';
    } else {
      const finalBadge = (currentWorkSetNum === currentEx.targetSets) ? ' (ФИНАЛЬНЫЙ)' : '';
      setBadgeEl.innerText = `РАБОЧИЙ ПОДХОД #${currentWorkSetNum} ИЗ ${currentEx.targetSets}${finalBadge}`;
      setBadgeEl.style.color = 'var(--md-sys-color-primary)';
    }
  }

  const catWarmupBtn = document.getElementById('liveCatWarmupBtn');
  const catWorkBtn = document.getElementById('liveCatWorkBtn');
  if (catWarmupBtn && catWorkBtn) {
    catWarmupBtn.classList.toggle('active', isWarmupMode);
    catWorkBtn.classList.toggle('active', !isWarmupMode);

    if (isWarmupMode) {
      catWarmupBtn.innerText = `Разминка (Шаг ${currentWarmupStepNum}/${totalWarmupSteps})`;
      catWorkBtn.innerText = `Рабочие (0/${currentEx.targetSets})`;
    } else {
      const warmupDoneMark = warmupSetsDone >= totalWarmupSteps
        ? `✓ ${warmupSetsDone}/${totalWarmupSteps}`
        : `${warmupSetsDone}/${totalWarmupSteps}`;
      catWarmupBtn.innerText = `Разминка (${warmupDoneMark})`;
      catWorkBtn.innerText = `Рабочий (Сет ${currentWorkSetNum}/${currentEx.targetSets})`;
    }
  }

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

  const weightValEl = document.getElementById('liveWeightValue');
  const repsValEl = document.getElementById('liveRepsValue');
  if (weightValEl) weightValEl.innerText = activeSession.draftSet.weight;
  if (repsValEl) repsValEl.innerText = activeSession.draftSet.reps;

  const rirBlockEl = document.getElementById('liveRirBlock');
  if (rirBlockEl) {
    rirBlockEl.style.display = isWarmupMode ? 'none' : 'flex';
  }

  document.querySelectorAll('.live-rir-chip').forEach(chip => {
    const val = chip.getAttribute('data-rir');
    chip.classList.toggle('active', val === String(activeSession.draftSet.rir));
  });

  const clusterPauseBtn = document.getElementById('liveClusterPauseBtn');
  if (clusterPauseBtn) {
    const prefs = getTimerPrefs();
    clusterPauseBtn.style.display = isWarmupMode ? 'none' : 'inline-flex';
    clusterPauseBtn.innerHTML = `<span class="material-symbols-outlined" style="font-size:16px;">bolt</span><span>Пауза ${prefs.cluster}с</span>`;
  }

  const recordBtn = document.getElementById('liveRecordSetBtn');
  if (recordBtn) {
    if (isWarmupMode) {
      recordBtn.innerHTML = `
        <span class="material-symbols-outlined">check_circle</span>
        <span>ЗАПИСАТЬ РАЗМИНКУ #${currentWarmupStepNum} (${activeSession.draftSet.weight} кг × ${activeSession.draftSet.reps})</span>
      `;
    } else {
      const specLabel = isSpecialActive ? ` • ${currentEx.plannedMethod.split(' ')[0].toUpperCase()}` : '';
      recordBtn.innerHTML = `
        <span class="material-symbols-outlined">check_circle</span>
        <span>ЗАПИСАТЬ РАБОЧИЙ СЕТ #${currentWorkSetNum}${specLabel} (${activeSession.draftSet.weight} кг × ${activeSession.draftSet.reps})</span>
      `;
    }
  }

  renderCompletedSetsHistory(currentEx);
}

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
      : 'var(--app-color-success)';

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

/* =========================================================
 * RECORD SET
 * ========================================================= */

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

  const appliedMethod = (!isWarmup && activeSession.draftSet.useSpecialMethod && currentEx.plannedMethod !== 'Стандарт')
    ? currentEx.plannedMethod
    : '';

  let firstSegmentReps = reps;
  let totalTonnage = weight * reps;
  let dropWeight = 0;
  let dropReps = 0;

  if (appliedMethod && currentEx.isCluster) {
    const clusterInfo = parseClusterScheme(appliedMethod, currentEx.defaultReps);
    firstSegmentReps = clusterInfo.firstSegmentReps;
  } else if (appliedMethod && currentEx.isDrop) {
    firstSegmentReps = reps;
    dropWeight = roundToGymStep(weight * 0.75);
    dropReps = 5;
    totalTonnage += (dropWeight * dropReps);
  }

  const setNum = currentEx.completedSets.length + 1;
  const tonnage = parseFloat(totalTonnage.toFixed(1));

  const e1rm = isWarmup ? 0.0 : computeE1RM(weight, firstSegmentReps);

  const recordedSet = {
    setNum: setNum,
    weight: weight,
    reps: reps,
    firstSegmentReps: firstSegmentReps,
    dropWeight: dropWeight,
    dropReps: dropReps,
    effort: effort,
    reserve: reserve,
    method: appliedMethod,
    category: isWarmup ? 'Разминка' : 'Рабочий',
    tonnage: tonnage,
    e1rm: e1rm,
    equipment: currentEx.equipment || '',
    positioning: currentEx.technique || '',
    recordedAt: new Date().toTimeString().slice(0, 8),
    timestampMs: Date.now()
  };

  currentEx.completedSets.push(recordedSet);
  currentEx.allowBonusSet = false;

  const workDoneAfter = currentEx.completedSets.filter(s => s.category === 'Рабочий').length;
  if (workDoneAfter >= currentEx.targetSets) {
    currentEx.isCompleted = true;
  }

  triggerHaptic([80]);

  // V5.4.2: лог в общий терминал
  const kind = isWarmup ? 'Разминка' : 'Рабочий';
  const methodTag = appliedMethod ? ` [${appliedMethod}]` : '';
  logToTerminal('LIVE_SET', `${currentEx.name} • ${kind} #${setNum}: ${weight} кг × ${reps}${reserve ? ' (RIR ' + reserve + ')' : ''}${methodTag}`, 'success');

  activeSession.draftSet = computeSmartDraftSetForExercise(currentEx);

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

/* =========================================================
 * NAVIGATION BETWEEN EXERCISES
 * ========================================================= */

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

/* =========================================================
 * REST TIMER
 * ========================================================= */

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

/* =========================================================
 * SUMMARY METRICS
 * ========================================================= */

function calculateWorkoutSummaryMetrics() {
  let totalWorkSets = 0;
  let totalWarmupSets = 0;
  let workTonnageKg = 0;
  let rirSum = 0;
  let rirCount = 0;
  const allTimestamps = [];

  activeSession.exercises.forEach(ex => {
    ex.completedSets.forEach(s => {
      if (s.timestampMs) {
        allTimestamps.push(s.timestampMs);
      }
      if (s.category === 'Рабочий') {
        totalWorkSets++;
        workTonnageKg += (s.tonnage || 0);
        const rirClean = parseFloat(String(s.reserve || '').replace('+', ''));
        if (!isNaN(rirClean)) {
          rirSum += rirClean;
          rirCount++;
        }
      } else {
        totalWarmupSets++;
      }
    });
  });

  allTimestamps.sort((a, b) => a - b);

  const endTimestampMs = allTimestamps.length > 0
    ? allTimestamps[allTimestamps.length - 1] + 120000
    : Date.now();
  const startReferenceMs = Math.min(activeSession.startedAtMs, allTimestamps[0] || activeSession.startedAtMs);

  const durationMin = Math.max(1, Math.round((endTimestampMs - startReferenceMs) / 60000));
  const workTonnage = parseFloat(workTonnageKg.toFixed(1));
  const density = parseFloat((workTonnage / durationMin).toFixed(1));
  const avgRir = rirCount > 0 ? parseFloat((rirSum / rirCount).toFixed(1)) : 2.0;

  let restDiffsSum = 0;
  let restDiffsCount = 0;
  for (let i = 1; i < allTimestamps.length; i++) {
    const diffSec = Math.round((allTimestamps[i] - allTimestamps[i - 1]) / 1000);
    if (diffSec >= 15 && diffSec <= 600) {
      restDiffsSum += diffSec;
      restDiffsCount++;
    }
  }
  const avgRestSec = restDiffsCount > 0 ? Math.round(restDiffsSum / restDiffsCount) : 0;
  const sRPE = parseFloat(activeSession.sRPE) || 8;
  const trainingLoad = Math.round(durationMin * sRPE);

  return {
    workoutId: activeSession.sessionId,
    date: activeSession.date,
    cycleId: activeSession.cycleId,
    week: activeSession.cycleWeek || 1,
    split: activeSession.splitDay || 'А',
    durationMin: durationMin,
    workTonnage: workTonnage,
    density: density,
    avgRestSec: avgRestSec,
    avgRir: avgRir,
    readinessPre: activeSession.readinessPre || '🟢 Оптимум',
    sRPE: sRPE,
    trainingLoad: trainingLoad,
    totalWorkSets: totalWorkSets,
    totalWarmupSets: totalWarmupSets
  };
}

/* =========================================================
 * CLOSEOUT MODAL
 * ========================================================= */

function openCloseoutModal() {
  if (!activeSession) return;

  const metrics = calculateWorkoutSummaryMetrics();
  if (metrics.totalWorkSets === 0 && metrics.totalWarmupSets === 0) {
    alert('Вы еще не записали ни одного подхода!');
    return;
  }

  registerLiveModals();
  openModal('liveCloseoutModal');
}

function renderCloseoutSummaryBox() {
  const summaryBox = document.getElementById('liveCloseoutSummaryStats');
  if (!summaryBox || !activeSession) return;

  const m = calculateWorkoutSummaryMetrics();
  summaryBox.innerHTML = `
    <div>• Сессия: <b>${escapeHtml(activeSession.title)}</b> (${escapeHtml(m.date)})</div>
    <div>• Длительность: <b>${m.durationMin} мин</b> • Плотность: <b>${m.density} кг/мин</b></div>
    <div>• Подходы: <b>${m.totalWorkSets} рабочих</b> (разминка: ${m.totalWarmupSets}) • Ср. RIR: <b>${m.avgRir}</b></div>
    <div>• Рабочий тоннаж: <b>${(m.workTonnage / 1000).toFixed(2)} т</b> (${Math.round(m.workTonnage)} кг)</div>
    <div>• Средний отдых: <b>${m.avgRestSec > 0 ? m.avgRestSec + ' сек' : 'н/д'}</b> • Нагрузка (Фостер): <b>${m.trainingLoad} ед.</b></div>
  `;
}

/* =========================================================
 * FINALIZE SYNC
 * ========================================================= */

async function finalizeAndSyncLiveWorkout() {
  if (!activeSession) return;
  const saveBtn = document.getElementById('liveConfirmFinishBtn');
  const statusEl = document.getElementById('liveCloseoutSyncStatus');

  const workoutSummary = calculateWorkoutSummaryMetrics();
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
        dropWeight: s.dropWeight || 0,
        dropReps: s.dropReps || 0,
        effort: s.effort,
        reserve: s.reserve,
        method: s.method,
        equipment: s.equipment || '',
        positioning: s.positioning || '',
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
    statusEl.innerText = '⏳ Отправка подходов (Log) и сводки тренировки (Workouts) в Google Таблицы...';
  }

  logToTerminal('LIVE_SYNC_START', `Отправка ${flatSets.length} сетов за ${activeSession.date}...`, 'info');

  try {
    const payload = {
      action: 'sync_sets',
      overwrite: true,
      date: activeSession.date,
      startTime: activeSession.startTime,
      sets: flatSets,
      allExercises: allExercises,
      workoutSummary: workoutSummary
    };

    const t0 = performance.now();
    await syncSetsToSheets(payload);
    const elapsed = Math.round(performance.now() - t0);

    logToTerminal('LIVE_SYNC_OK', `Записано ${flatSets.length} строк за ${elapsed} мс. Верификация...`, 'success');

    const freshData = await fetchAnalyticsData();
    if (freshData.success && freshData.data) {
      setInitialData(freshData.data);
    }

    logToTerminal('LIVE_SYNC_VERIFIED', `Локальный кэш обновлен: ${(freshData.data.sets || []).length} сетов`, 'success');

    stopAllTimers();
    await releaseScreenWakeLock();
    const closedTitle = activeSession ? activeSession.title : '';
    activeSession = null;
    persistActiveSession();
    hideRecoveryBanner();

    if (isModalOpen('liveCloseoutModal')) closeModal('liveCloseoutModal');
    setTimeout(() => {
      if (isModalOpen('liveWorkoutOverlay')) closeModal('liveWorkoutOverlay');
      document.body.style.overflow = '';
    }, 280);

    if (typeof onWorkoutCompletedCallback === 'function') {
      await onWorkoutCompletedCallback();
    }

    setTimeout(() => {
      alert(`Тренировка «${closedTitle}» сохранена в Google Таблицы.`);
    }, 320);
  } catch (err) {
    logToTerminal('LIVE_SYNC_ERR', `Сбой: ${err.message}`, 'error');
    if (statusEl) {
      statusEl.style.color = 'var(--md-sys-color-error)';
      statusEl.innerText = `❌ Сбой сети: ${err.message}. Данные сохранены в памяти телефона — повторите отправку при появлении связи.`;
    }
  } finally {
    if (saveBtn) saveBtn.disabled = false;
  }
}

/* =========================================================
 * DOM EVENTS
 * ========================================================= */

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

  const equipChip = document.getElementById('liveEquipmentChip');
  const techChip = document.getElementById('liveTechniqueChip');
  if (equipChip) equipChip.onclick = () => openNotesSheet();
  if (techChip) techChip.onclick = () => openNotesSheet();

  const notesSaveBtn = document.getElementById('liveNotesSaveBtn');
  const notesCancelBtn = document.getElementById('liveNotesCancelBtn');
  if (notesSaveBtn) notesSaveBtn.onclick = () => saveNotesSheet();
  if (notesCancelBtn) notesCancelBtn.onclick = () => closeModal('liveNotesSheet');

  // V5.4.2: Enter в textarea «Оборудование» → фокус на «Технику», без newline.
  // Плюс auto-resize при вводе.
  const equipInput = document.getElementById('liveNotesEquipmentInput');
  if (equipInput) {
    equipInput.addEventListener('input', () => autoResizeNotesField(equipInput));
    equipInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const techInput = document.getElementById('liveNotesTechniqueInput');
        if (techInput) techInput.focus();
      }
    });
  }

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

  const completeNextBtn = document.getElementById('liveCompleteAndNextExBtn');
  const addBonusSetBtn = document.getElementById('liveAddBonusSetBtn');
  if (completeNextBtn) completeNextBtn.onclick = () => handleCompleteCurrentAndMoveNext();
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

  document.querySelectorAll('.live-rir-chip').forEach(chip => {
    chip.onclick = () => {
      if (!activeSession) return;
      activeSession.draftSet.rir = chip.getAttribute('data-rir') || '2';
      triggerHaptic(20);
      persistActiveSession();
      renderLiveWorkoutScreen();
    };
  });

  const clusterBtn = document.getElementById('liveClusterPauseBtn');
  if (clusterBtn) {
    clusterBtn.onclick = () => {
      const prefs = getTimerPrefs();
      triggerHaptic(50);
      startRestTimer(prefs.cluster);
    };
  }

  const recordBtn = document.getElementById('liveRecordSetBtn');
  if (recordBtn) recordBtn.onclick = () => handleRecordCurrentSet();

  const restMinusBtn = document.getElementById('liveRestMinus30Btn');
  const restPlusBtn = document.getElementById('liveRestPlus30Btn');
  const restSkipBtn = document.getElementById('liveRestSkipBtn');
  if (restMinusBtn) restMinusBtn.onclick = () => adjustRestTimer(-30);
  if (restPlusBtn) restPlusBtn.onclick = () => adjustRestTimer(30);
  if (restSkipBtn) restSkipBtn.onclick = () => stopRestTimer();

  const openTimerPrefsBtn = document.getElementById('liveOpenTimerSettingsBtn');
  const saveTimerPrefsBtn = document.getElementById('saveLiveTimerSettingsBtn');

  if (openTimerPrefsBtn) {
    openTimerPrefsBtn.onclick = () => {
      const prefs = getTimerPrefs();
      document.getElementById('prefTimerCompound').value = prefs.compound;
      document.getElementById('prefTimerIsolation').value = prefs.isolation;
      document.getElementById('prefTimerCluster').value = prefs.cluster;
      registerLiveModals();
      openModal('liveTimerSettingsModal');
    };
  }

  if (saveTimerPrefsBtn) {
    saveTimerPrefsBtn.onclick = () => {
      const newPrefs = {
        compound: Math.max(10, parseInt(document.getElementById('prefTimerCompound').value, 10) || 150),
        isolation: Math.max(10, parseInt(document.getElementById('prefTimerIsolation').value, 10) || 90),
        cluster: Math.max(5, parseInt(document.getElementById('prefTimerCluster').value, 10) || 20),
        warmup: 60
      };
      saveTimerPrefs(newPrefs);
      closeModal('liveTimerSettingsModal');
      renderLiveWorkoutScreen();
    };
  }

  const confirmFinishBtn = document.getElementById('liveConfirmFinishBtn');
  const discardSessionBtn = document.getElementById('liveDiscardWorkoutBtn');

  document.querySelectorAll('.live-readiness-chip').forEach(chip => {
    chip.onclick = () => {
      if (!activeSession) return;
      activeSession.readinessPre = chip.getAttribute('data-readiness') || '🟢 Оптимум';
      document.querySelectorAll('.live-readiness-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      persistActiveSession();
    };
  });

  document.querySelectorAll('.live-srpe-chip').forEach(chip => {
    chip.onclick = () => {
      if (!activeSession) return;
      activeSession.sRPE = parseInt(chip.getAttribute('data-srpe'), 10) || 8;
      document.querySelectorAll('.live-srpe-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      persistActiveSession();
      renderCloseoutSummaryBox();
    };
  });

  if (confirmFinishBtn) confirmFinishBtn.onclick = () => finalizeAndSyncLiveWorkout();
  if (discardSessionBtn) discardSessionBtn.onclick = () => discardLiveWorkoutSession();
}
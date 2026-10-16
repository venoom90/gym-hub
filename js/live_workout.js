/**
 * =========================================================================
 * GYM ANALYTICS HUB — LIVE WORKOUT ENGINE (V2.4 DROPS ARRAY FIX)
 * =========================================================================
 * V2.4:
 * - Сет хранит полный массив дропов: `drops: [{weight, reps, rir}, ...]`.
 *   Раньше сохранялся только первый дроп — остальные терялись.
 * - renderHistoryRow показывает все дропы:
 *     • 1 дроп → inline: `42.5×8 + 32.5×5`
 *     • 2+ дропа → цепочкой на второй строке: `+ 32.5×5 → 25×5 → 20×5`
 * - renderHistoryGroups meta показывает `+N дроп.` для много-дроповых сетов.
 * - finalizeAndSync передаёт массив drops в payload (для будущего бэкенда).
 * - Fallback на legacy dropWeight/dropReps для старых сессий.
 *
 * V2.3 (сохранено):
 * - Big Clock — пассивный секундомер вверх, 3 строки в углу.
 * - Круглая кнопка-часы в PAB (method-combo).
 * - Компактные двухстрочные Cluster/Drop Sheet.
 * - Логирование отдыха: startedAtMs / recordedAtMs → честный avgRestSec.
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

let bigClockStartedAtMs = 0;
let bigClockInterval = null;

let activeClusterSheetState = null;
let activeDropSheetState = null;

const DEFAULT_TIMERS = {
  compound: 150,
  isolation: 90,
  cluster: 20,
  drop: 15,
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
      syncBigClockWithWallClock();
    }
  });
}

/* =========================================================
 * MODAL MANAGER
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
        renderLiveWorkoutScreen();
        syncRestTimerWithWallClock();
      },
      onClose: () => {
        document.body.style.overflow = '';
        showRecoveryBanner();
      }
    });
  }

  const bigClock = document.getElementById('liveBigClockOverlay');
  if (bigClock) {
    registerModal('liveBigClockOverlay', {
      el: bigClock,
      displayStyle: 'flex',
      onOpen: () => { startBigClockCountUp(); },
      onClose: () => { stopBigClock(); }
    });
  }

  const clusterSheet = document.getElementById('liveClusterSheet');
  if (clusterSheet) {
    registerModal('liveClusterSheet', {
      el: clusterSheet,
      displayStyle: 'flex',
      onClose: () => { activeClusterSheetState = null; }
    });
    clusterSheet.onclick = (e) => { if (e.target === clusterSheet) closeModal('liveClusterSheet'); };
  }

  const dropSheet = document.getElementById('liveDropSheet');
  if (dropSheet) {
    registerModal('liveDropSheet', {
      el: dropSheet,
      displayStyle: 'flex',
      onClose: () => { activeDropSheetState = null; }
    });
    dropSheet.onclick = (e) => { if (e.target === dropSheet) closeModal('liveDropSheet'); };
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
        segments: segments,
        totalReps: sum,
        firstSegmentReps: segments[0]
      };
    }
  }
  if (str.toLowerCase().includes('кластер')) {
    return {
      isCluster: true,
      schemeText: '4+3+2',
      segments: [4, 3, 2],
      totalReps: 9,
      firstSegmentReps: 4
    };
  }
  return {
    isCluster: false,
    schemeText: '',
    segments: [defaultWorkReps],
    totalReps: defaultWorkReps,
    firstSegmentReps: defaultWorkReps
  };
}

function defaultRirForSegment(index, total) {
  if (total <= 1) return '1';
  if (index === 0) return '3';
  if (index === total - 1) return '1';
  return '2';
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
    lastRestEndMs: 0,
    readinessPre: '🟢 Оптимум',
    sRPE: 8,
    isFinished: false,
    headerCollapsed: false,
    headerManuallyToggled: false,
    historyUiState: { warmupCollapsed: false, workCollapsed: false }
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
      if (typeof parsed.headerCollapsed !== 'boolean') parsed.headerCollapsed = false;
      if (typeof parsed.headerManuallyToggled !== 'boolean') parsed.headerManuallyToggled = false;
      if (!parsed.historyUiState || typeof parsed.historyUiState !== 'object') {
        parsed.historyUiState = { warmupCollapsed: false, workCollapsed: false };
      }
      if (typeof parsed.lastRestEndMs !== 'number') parsed.lastRestEndMs = 0;
      activeSession = parsed;
      const totalWorkDone = activeSession.exercises.reduce(
        (acc, ex) => acc + ex.completedSets.filter(s => s.category === 'Рабочий').length, 0
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
    (acc, ex) => acc + ex.completedSets.filter(s => s.category === 'Рабочий').length, 0
  );
  if (infoText) infoText.innerText = `${activeSession.title} • Рабочих сетов: ${totalWorkDone}`;
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
    try { navigator.vibrate(pattern); } catch (e) {}
  }
}

/* =========================================================
 * OVERLAY OPEN/MINIMIZE
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
  stopBigClock();
  releaseScreenWakeLock();
  activeSession = null;
  persistActiveSession();
  hideRecoveryBanner();
  resetAllModals();
  document.body.style.overflow = '';
}

function stopAllTimers() {
  if (workoutDurationInterval) { clearInterval(workoutDurationInterval); workoutDurationInterval = null; }
  if (restTimerInterval) { clearInterval(restTimerInterval); restTimerInterval = null; }
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
 * BIG CLOCK
 * ========================================================= */

function openBigClockOverlay() {
  registerLiveModals();
  openModal('liveBigClockOverlay');
}

function startBigClockCountUp() {
  bigClockStartedAtMs = Date.now();

  const digitsEl = document.getElementById('liveBigClockDigits');
  const nowEl = document.getElementById('liveBigClockNow');
  const etaRelEl = document.getElementById('liveBigClockEtaRel');
  const etaAbsEl = document.getElementById('liveBigClockEtaAbs');

  const eta = computeSessionEta();

  const update = () => {
    if (!bigClockStartedAtMs) return;

    const elapsedSec = Math.max(0, Math.floor((Date.now() - bigClockStartedAtMs) / 1000));
    const m = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
    const s = String(elapsedSec % 60).padStart(2, '0');

    if (digitsEl) digitsEl.innerText = `${m}:${s}`;

    const now = new Date();
    const nowHH = String(now.getHours()).padStart(2, '0');
    const nowMM = String(now.getMinutes()).padStart(2, '0');
    if (nowEl) nowEl.innerHTML = `Сейчас <b>${nowHH}:${nowMM}</b>`;

    if (eta) {
      const remMin = Math.max(0, Math.round((eta.endsAtMs - Date.now()) / 60000));
      const remHH = String(Math.floor(remMin / 60)).padStart(2, '0');
      const remMM = String(remMin % 60).padStart(2, '0');
      if (etaRelEl) etaRelEl.innerHTML = `До финиша <b>${remHH}:${remMM}</b>`;

      const endsAt = new Date(eta.endsAtMs);
      const endHH = String(endsAt.getHours()).padStart(2, '0');
      const endMM = String(endsAt.getMinutes()).padStart(2, '0');
      if (etaAbsEl) etaAbsEl.innerHTML = `Окончание ~<b>${endHH}:${endMM}</b>`;
    } else {
      if (etaRelEl) etaRelEl.innerHTML = 'До финиша —';
      if (etaAbsEl) etaAbsEl.innerHTML = 'Окончание —';
    }
  };

  if (bigClockInterval) clearInterval(bigClockInterval);
  update();
  bigClockInterval = setInterval(update, 500);
}

function stopBigClock() {
  if (bigClockInterval) { clearInterval(bigClockInterval); bigClockInterval = null; }
  bigClockStartedAtMs = 0;
}

function syncBigClockWithWallClock() {
  if (bigClockStartedAtMs && !bigClockInterval) {
    startBigClockCountUp();
  }
}

function computeSessionEta() {
  if (!activeSession) return null;

  const history = Array.isArray(state.dbData.workouts) ? state.dbData.workouts : [];
  const mySplit = String(activeSession.splitDay || '').toUpperCase();

  const sameSplit = history.filter(w => {
    const s = String(w.split || '').toUpperCase();
    if (!s) return false;
    if (s === mySplit) return true;
    if (mySplit === 'А' && s === 'A') return true;
    if (mySplit === 'Б' && s === 'B') return true;
    return false;
  });

  let avgDurationMin = 55;

  if (sameSplit.length >= 1) {
    const recent = sameSplit.slice(-5);
    const sum = recent.reduce((acc, w) => acc + (parseFloat(w.durationMin) || 0), 0);
    if (sum > 0) avgDurationMin = Math.round(sum / recent.length);
  }

  return {
    avgDurationMin,
    endsAtMs: activeSession.startedAtMs + avgDurationMin * 60 * 1000
  };
}

/* =========================================================
 * MAIN RENDER
 * ========================================================= */

function renderLiveWorkoutScreen() {
  if (!activeSession) return;
  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  if (!currentEx) return;

  if (typeof activeSession.headerCollapsed !== 'boolean') activeSession.headerCollapsed = false;
  if (typeof activeSession.headerManuallyToggled !== 'boolean') activeSession.headerManuallyToggled = false;
  if (!activeSession.historyUiState) activeSession.historyUiState = { warmupCollapsed: false, workCollapsed: false };

  renderProgressStrip();
  renderExerciseHeader();
  renderExerciseNoteChips();
  renderCurrentSetLabel();
  renderCategoryToggle();
  renderMethodToggle();
  renderStepperValues();
  renderRirChips();
  renderIntensifierBanner();
  renderControlsVisibility();
  renderCompletedCard();
  renderHistoryGroups();
  renderPAB();
}

function renderProgressStrip() {
  const container = document.getElementById('liveProgressSegments');
  const counter = document.getElementById('liveExProgressBadge');
  const prevBtn = document.getElementById('livePrevExBtn');
  const nextBtn = document.getElementById('liveNextExBtn');
  if (!container || !activeSession) return;

  const current = activeSession.currentExerciseIndex;
  const total = activeSession.exercises.length;
  container.innerHTML = '';

  activeSession.exercises.forEach((ex, idx) => {
    const seg = document.createElement('div');
    seg.className = 'live-progress-segment';
    const width = Math.max(1, parseInt(ex.targetSets, 10) || 3);
    seg.style.flexGrow = String(width);
    seg.style.flexBasis = '0';
    const workDone = ex.completedSets.filter(s => s.category === 'Рабочий').length;
    const isDone = ex.isCompleted || workDone >= ex.targetSets;
    if (isDone) seg.classList.add('is-done');
    else if (idx === current) seg.classList.add('is-current');
    seg.setAttribute('title', ex.name);
    container.appendChild(seg);
  });

  if (counter) counter.innerText = `${current + 1}/${total}`;
  if (prevBtn) prevBtn.disabled = current <= 0;
  if (nextBtn) nextBtn.disabled = current >= total - 1;
}

function renderExerciseHeader() {
  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  if (!currentEx) return;

  const card = document.getElementById('liveExHeaderCard');
  const compactEl = document.getElementById('liveExHeaderCompact');
  const fullEl = document.getElementById('liveExHeaderFull');
  if (!card) return;

  const isCollapsed = activeSession.headerCollapsed === true;
  const workDone = currentEx.completedSets.filter(s => s.category === 'Рабочий').length;
  const totalSets = currentEx.targetSets;

  if (isCollapsed) {
    if (compactEl) compactEl.style.display = 'flex';
    if (fullEl) fullEl.style.display = 'none';
    card.classList.add('is-collapsed');

    const nameEl = document.getElementById('liveExNameCompact');
    if (nameEl) nameEl.innerText = currentEx.name;

    const chipsContainer = document.getElementById('liveExCompactChips');
    if (chipsContainer) {
      const chips = [];
      const progressClass = workDone >= totalSets ? 'is-success' : '';
      chips.push(`<span class="live-compact-chip ${progressClass}">${workDone}/${totalSets}${workDone >= totalSets ? ' ✓' : ''}</span>`);
      chips.push(`<span class="live-compact-chip is-primary">${currentEx.targetWeight}×${escapeHtml(currentEx.targetRepsStr)}</span>`);
      chips.push(`<span class="live-compact-chip">RIR ${escapeHtml(currentEx.targetRir)}</span>`);

      if (currentEx.plannedMethod && currentEx.plannedMethod !== 'Стандарт') {
        let methodLabel = currentEx.plannedMethod;
        const schemeMatch = currentEx.plannedMethod.match(/(\d+(?:\+\d+)+)/);
        if (schemeMatch) methodLabel = `⚡ ${schemeMatch[1]}`;
        else if (methodLabel.toLowerCase().includes('дроп')) methodLabel = '⚡ Дроп';
        else if (methodLabel.toLowerCase().includes('кластер')) methodLabel = '⚡ Кластер';
        else methodLabel = `⚡ ${methodLabel}`;
        chips.push(`<span class="live-compact-chip is-method">${escapeHtml(methodLabel)}</span>`);
      }

      const lastWorkSet = [...currentEx.completedSets].reverse().find(s => s.category === 'Рабочий');
      if (lastWorkSet) {
        const rirTxt = lastWorkSet.reserve ? ` RIR${lastWorkSet.reserve.replace('+','')}` : '';
        chips.push(`<span class="live-compact-chip">Посл. ${lastWorkSet.weight}×${lastWorkSet.reps}${rirTxt}</span>`);
      }

      chipsContainer.innerHTML = chips.join('');
    }
  } else {
    if (compactEl) compactEl.style.display = 'none';
    if (fullEl) fullEl.style.display = 'flex';
    card.classList.remove('is-collapsed');

    const nameEl = document.getElementById('liveExName');
    const subEl = document.getElementById('liveExTargetSubtitle');
    if (nameEl) nameEl.innerText = currentEx.name;
    if (subEl) {
      const specText = (currentEx.plannedMethod && currentEx.plannedMethod !== 'Стандарт')
        ? ` • Финал: <b>${escapeHtml(currentEx.plannedMethod)}</b>` : '';
      subEl.innerHTML = `План: <b>${currentEx.targetWeight} кг × ${escapeHtml(currentEx.targetRepsStr)}</b> (${currentEx.targetSets} раб. сета, RIR ${escapeHtml(currentEx.targetRir)})${specText}`;
    }

    const warmupHintEl = document.getElementById('liveExWarmupHint');
    if (warmupHintEl) {
      warmupHintEl.innerHTML = currentEx.warmupText
        ? `<span class="material-symbols-outlined" style="font-size:15px;">restart_alt</span> Разминка по плану: <b>${escapeHtml(currentEx.warmupText)}</b>`
        : '';
    }
  }
}

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

function renderCurrentSetLabel() {
  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  const isWarmupMode = (activeSession.draftSet.category === 'Разминка');
  const warmupSetsDone = currentEx.completedSets.filter(s => s.category === 'Разминка').length;
  const workSetsDone = currentEx.completedSets.filter(s => s.category === 'Рабочий').length;
  const totalWarmupSteps = Math.max(1, (currentEx.warmupSteps || []).length);
  const el = document.getElementById('liveCurrentSetLabel');
  if (!el) return;

  if (isWarmupMode) {
    const step = Math.min(warmupSetsDone + 1, totalWarmupSteps);
    el.innerText = `РАЗМИНКА: ШАГ ${step} ИЗ ${totalWarmupSteps}`;
    el.style.color = 'var(--app-color-success)';
  } else {
    const setNum = workSetsDone + 1;
    const isFinal = (setNum === currentEx.targetSets);
    el.innerText = `РАБОЧИЙ ПОДХОД #${setNum} ИЗ ${currentEx.targetSets}${isFinal ? ' (ФИНАЛЬНЫЙ)' : ''}`;
    el.style.color = 'var(--md-sys-color-primary)';
  }
}

function renderCategoryToggle() {
  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  const isWarmupMode = (activeSession.draftSet.category === 'Разминка');
  const warmupSetsDone = currentEx.completedSets.filter(s => s.category === 'Разминка').length;
  const workSetsDone = currentEx.completedSets.filter(s => s.category === 'Рабочий').length;
  const totalWarmupSteps = Math.max(1, (currentEx.warmupSteps || []).length);

  const wBtn = document.getElementById('liveCatWarmupBtn');
  const kBtn = document.getElementById('liveCatWorkBtn');
  if (!wBtn || !kBtn) return;

  wBtn.classList.toggle('active', isWarmupMode);
  kBtn.classList.toggle('active', !isWarmupMode);

  if (isWarmupMode) {
    const step = Math.min(warmupSetsDone + 1, totalWarmupSteps);
    wBtn.innerText = `Разминка (Шаг ${step}/${totalWarmupSteps})`;
    kBtn.innerText = `Рабочие (0/${currentEx.targetSets})`;
  } else {
    const warmupDoneMark = warmupSetsDone >= totalWarmupSteps
      ? `✓ ${warmupSetsDone}/${totalWarmupSteps}`
      : `${warmupSetsDone}/${totalWarmupSteps}`;
    wBtn.innerText = `Разминка (${warmupDoneMark})`;
    kBtn.innerText = `Рабочий (Сет ${workSetsDone + 1}/${currentEx.targetSets})`;
  }
}

function renderMethodToggle() {
  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  const isWarmupMode = activeSession.draftSet.category === 'Разминка';
  const isSpecialActive = (!isWarmupMode && activeSession.draftSet.useSpecialMethod);

  const btn = document.getElementById('liveMethodToggleBtn');
  const txt = document.getElementById('liveMethodChipText');
  if (!btn || !txt) return;

  if (!isWarmupMode && currentEx.plannedMethod && currentEx.plannedMethod !== 'Стандарт') {
    btn.hidden = false;
    let chipLabel = currentEx.plannedMethod;
    const schemeMatch = currentEx.plannedMethod.match(/(\d+(?:\+\d+)+)/);
    if (schemeMatch) chipLabel = schemeMatch[1];
    else if (chipLabel.toLowerCase().includes('дроп')) chipLabel = 'Дроп';
    else if (chipLabel.toLowerCase().includes('кластер')) chipLabel = 'Кластер';
    txt.innerText = chipLabel;
    btn.classList.toggle('is-active', isSpecialActive);
  } else {
    btn.hidden = true;
  }
}

function renderStepperValues() {
  const wEl = document.getElementById('liveWeightValue');
  const rEl = document.getElementById('liveRepsValue');
  if (wEl) wEl.innerText = activeSession.draftSet.weight;
  if (rEl) rEl.innerText = activeSession.draftSet.reps;
}

function renderRirChips() {
  const isWarmupMode = activeSession.draftSet.category === 'Разминка';
  const rirBlock = document.getElementById('liveRirBlock');
  if (rirBlock) rirBlock.style.display = isWarmupMode ? 'none' : 'flex';

  document.querySelectorAll('.live-rir-chip').forEach(chip => {
    const v = chip.getAttribute('data-rir');
    const isActive = v === String(activeSession.draftSet.rir);
    chip.classList.toggle('active', isActive);
    chip.setAttribute('aria-checked', isActive ? 'true' : 'false');
  });
}

function renderIntensifierBanner() {
  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  const isWarmupMode = activeSession.draftSet.category === 'Разминка';
  const isSpecialActive = (!isWarmupMode && activeSession.draftSet.useSpecialMethod);
  const el = document.getElementById('liveIntensifierBanner');
  if (!el) return;

  if (isSpecialActive && currentEx.isDrop) {
    const dropLoad = roundToGymStep(activeSession.draftSet.weight * 0.75);
    el.style.display = 'flex';
    el.innerHTML = `
      <span class="material-symbols-outlined" style="font-size:18px; color: var(--app-color-warning);">bolt</span>
      <div><b>Финальный Дроп-сет:</b> после основного подхода сбросьте вес на <b>${dropLoad} кг (-25%)</b> и дожмите <b>5 повт.</b> без отдыха. Запись — <b>[✓ ЗАПИСАТЬ ДРОП-СЕТ]</b>.</div>
    `;
  } else if (isSpecialActive && currentEx.isCluster) {
    const clusterInfo = parseClusterScheme(currentEx.plannedMethod, currentEx.defaultReps);
    el.style.display = 'flex';
    el.innerHTML = `
      <span class="material-symbols-outlined" style="font-size:18px; color: var(--md-sys-color-primary);">timer</span>
      <div><b>Финальный Кластер (${escapeHtml(clusterInfo.schemeText)}):</b> тап по пилюле ⏱ в топбаре или по круглой кнопке внизу откроет секундомер. Запись — <b>[✓ ЗАПИСАТЬ КЛАСТЕР]</b>.</div>
    `;
  } else {
    el.style.display = 'none';
  }
}

function renderControlsVisibility() {
  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  const workDone = currentEx.completedSets.filter(s => s.category === 'Рабочий').length;
  const isTargetReached = (workDone >= currentEx.targetSets) && !currentEx.allowBonusSet;
  const controls = document.getElementById('liveActiveSetControlsCard');
  if (controls) controls.style.display = isTargetReached ? 'none' : 'flex';
}

function renderCompletedCard() {
  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  const workDone = currentEx.completedSets.filter(s => s.category === 'Рабочий').length;
  const isTargetReached = (workDone >= currentEx.targetSets) && !currentEx.allowBonusSet;

  const card = document.getElementById('liveExCompletedCard');
  const title = document.getElementById('liveExCompletedTitle');
  if (!card) return;

  if (isTargetReached) {
    card.style.display = 'flex';
    if (title) {
      const bonusTag = workDone > currentEx.targetSets ? ` (+${workDone - currentEx.targetSets} бонус)` : '';
      title.innerText = `✅ Упражнение выполнено (${Math.min(workDone, currentEx.targetSets)} из ${currentEx.targetSets}${bonusTag})`;
    }
  } else {
    card.style.display = 'none';
  }
}

function renderHistoryGroups() {
  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  if (!currentEx) return;

  const warmupSets = currentEx.completedSets.filter(s => s.category === 'Разминка');
  const workSets = currentEx.completedSets.filter(s => s.category === 'Рабочий');

  const warmupGroup = document.getElementById('liveWarmupGroup');
  const workGroup = document.getElementById('liveWorkGroup');
  const warmupBody = document.getElementById('liveWarmupGroupBody');
  const workBody = document.getElementById('liveWorkGroupBody');
  const warmupMeta = document.getElementById('liveWarmupGroupMeta');
  const workMeta = document.getElementById('liveWorkGroupMeta');

  if (warmupSets.length > 0 && warmupGroup && warmupBody) {
    warmupGroup.style.display = 'block';
    const last = warmupSets[warmupSets.length - 1];
    if (warmupMeta) warmupMeta.innerText = `${warmupSets.length} • посл. ${last.weight} кг × ${last.reps}`;
    const isCollapsed = activeSession.historyUiState.warmupCollapsed === true;
    warmupGroup.classList.toggle('is-collapsed', isCollapsed);
    const chevron = document.getElementById('liveWarmupChevron');
    if (chevron) chevron.style.transform = isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
    const header = document.getElementById('liveWarmupGroupHeader');
    if (header) header.setAttribute('aria-expanded', String(!isCollapsed));
    warmupBody.innerHTML = warmupSets.map((s, idx) => renderHistoryRow(s, idx + 1, 'warmup')).join('');
    attachHistoryRowHandlers(warmupBody, warmupSets, currentEx);
  } else if (warmupGroup) {
    warmupGroup.style.display = 'none';
  }

  if (workSets.length > 0 && workGroup && workBody) {
    workGroup.style.display = 'block';
    const last = workSets[workSets.length - 1];

    // V2.4: мета с учётом дропов
    const lastDropsCount = Array.isArray(last.drops) ? last.drops.length : (last.dropWeight > 0 ? 1 : 0);
    const dropsMetaTxt = lastDropsCount > 1 ? ` (+${lastDropsCount} дроп.)` : '';
    const rirTxt = last.reserve ? ` · RIR ${last.reserve.replace('+','')}` : '';
    if (workMeta) workMeta.innerText = `${workSets.length} / ${currentEx.targetSets} • посл. ${last.weight}×${last.reps}${dropsMetaTxt}${rirTxt}`;

    const isCollapsed = activeSession.historyUiState.workCollapsed === true;
    workGroup.classList.toggle('is-collapsed', isCollapsed);
    const chevron = document.getElementById('liveWorkChevron');
    if (chevron) chevron.style.transform = isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
    const header = document.getElementById('liveWorkGroupHeader');
    if (header) header.setAttribute('aria-expanded', String(!isCollapsed));
    workBody.innerHTML = workSets.map((s, idx) => renderHistoryRow(s, idx + 1, 'work')).join('');
    attachHistoryRowHandlers(workBody, workSets, currentEx);
  } else if (workGroup) {
    workGroup.style.display = 'none';
  }
}

/**
 * V2.4: рендер строки с поддержкой массива дропов.
 *   - 1 дроп → inline: `42.5×8 + 32.5×5`
 *   - 2+ дропа → main + цепочка на 2-й строке: `+ 32.5×5 → 25×5 → 20×5`
 *   - legacy (dropWeight/dropReps без массива) → как раньше, inline.
 */
function renderHistoryRow(set, displayNum, kind) {
  const label = kind === 'warmup' ? `Разм. #${displayNum}` : `Раб. #${displayNum}`;
  const color = kind === 'warmup' ? 'var(--md-sys-color-on-surface-variant)' : 'var(--app-color-success)';

  const chips = [];
  const methodLower = String(set.method || '').toLowerCase();
  const isDrop = kind === 'work' && methodLower.includes('дроп');

  const dropsArr = Array.isArray(set.drops) ? set.drops : [];
  const hasArrayDrops = dropsArr.length > 0;
  const hasLegacyDrop = set.dropWeight > 0 && set.dropReps > 0;

  let mainLine = `${set.weight} кг × ${set.reps}`;
  let dropsChainHtml = '';

  if (isDrop) {
    if (hasArrayDrops && dropsArr.length === 1) {
      const d = dropsArr[0];
      mainLine = `${set.weight}×${set.reps} + ${d.weight}×${d.reps}`;
    } else if (hasArrayDrops && dropsArr.length > 1) {
      mainLine = `${set.weight}×${set.reps}`;
      const dropsStr = dropsArr.map(d => `${d.weight}×${d.reps}`).join(' → ');
      dropsChainHtml = `<div style="margin-top:4px; font-size:0.75rem; color:var(--md-sys-color-on-surface-variant); padding-left:2px;">+ ${dropsStr}</div>`;
    } else if (!hasArrayDrops && hasLegacyDrop) {
      mainLine = `${set.weight}×${set.reps} + ${set.dropWeight}×${set.dropReps}`;
    }
  }

  if (kind === 'work' && set.reserve) {
    chips.push(`<span class="coach-card-chip">RIR ${escapeHtml(set.reserve.replace('+',''))}</span>`);
  }

  if (kind === 'work' && set.method) {
    let methodLabel = set.method;
    const schemeMatch = set.method.match(/(\d+(?:\+\d+)+)/);
    if (schemeMatch) methodLabel = `⚡ ${schemeMatch[1]}`;
    else if (methodLower.includes('дроп')) methodLabel = '⚡ Дроп';
    else if (methodLower.includes('кластер')) methodLabel = '⚡ Кластер';
    else methodLabel = `⚡ ${methodLabel}`;
    chips.push(`<span class="coach-method-badge">${escapeHtml(methodLabel)}</span>`);
  }

  return `
    <div class="live-history-row">
      <div style="display:flex; flex-direction:column; flex:1; min-width:0;">
        <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap;">
          <span style="font-weight:700; color:${color}; min-width:66px; flex-shrink:0;">${label}</span>
          <span><b>${mainLine}</b></span>
          ${chips.join('')}
        </div>
        ${dropsChainHtml}
      </div>
      <button class="live-delete-set-btn" data-set-idx="${displayNum - 1}" data-kind="${kind}" data-state="idle" title="Удалить подход (двойной тап)">
        <span class="material-symbols-outlined" style="font-size:18px;">delete</span>
        <span class="delete-label">Удалить?</span>
      </button>
    </div>
  `;
}

function attachHistoryRowHandlers(container, sets, currentEx) {
  container.querySelectorAll('.live-delete-set-btn').forEach(btn => {
    const idx = parseInt(btn.getAttribute('data-set-idx'), 10);
    let resetTimer = null;

    btn.onclick = () => {
      const stateAttr = btn.getAttribute('data-state') || 'idle';
      if (stateAttr === 'idle') {
        btn.setAttribute('data-state', 'confirm');
        btn.classList.add('is-confirm');
        if (resetTimer) clearTimeout(resetTimer);
        resetTimer = setTimeout(() => {
          btn.setAttribute('data-state', 'idle');
          btn.classList.remove('is-confirm');
          resetTimer = null;
        }, 3000);
        triggerHaptic([20]);
        return;
      }

      if (stateAttr === 'confirm') {
        if (resetTimer) clearTimeout(resetTimer);
        const targetSet = sets[idx];
        if (!targetSet) return;
        const globalIdx = currentEx.completedSets.indexOf(targetSet);
        if (globalIdx === -1) return;
        currentEx.completedSets.splice(globalIdx, 1);
        currentEx.completedSets.forEach((item, i) => { item.setNum = i + 1; });
        currentEx.isCompleted = false;
        currentEx.allowBonusSet = false;
        activeSession.draftSet = computeSmartDraftSetForExercise(currentEx);
        persistActiveSession();
        triggerHaptic([60]);
        renderLiveWorkoutScreen();
      }
    };
  });
}

/* =========================================================
 * PAB
 * ========================================================= */

function renderPAB() {
  const pab = document.getElementById('liveBottomActionBar');
  if (!pab || !activeSession) return;

  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  if (!currentEx) return;

  pab.classList.remove('is-warning');

  const workDone = currentEx.completedSets.filter(s => s.category === 'Рабочий').length;
  const isTargetReached = (workDone >= currentEx.targetSets) && !currentEx.allowBonusSet;

  if (isTargetReached) {
    const nextExIdx = findNextIncompleteExerciseIndex(activeSession.currentExerciseIndex);
    let primaryLabel = 'ЗАВЕРШИТЬ УПРАЖНЕНИЕ';
    let secondaryLabel = 'Все упражнения → финиш тренировки';
    if (nextExIdx !== -1) {
      const nextName = activeSession.exercises[nextExIdx].name;
      primaryLabel = `ЗАВЕРШИТЬ → УПР. #${nextExIdx + 1}`;
      secondaryLabel = nextName;
    }

    let restInlineHtml = '';
    if (activeSession.restState && activeSession.restState.isActive) {
      const remainingSec = Math.max(0, Math.ceil((activeSession.restState.endsAtMs - Date.now()) / 1000));
      const m = String(Math.floor(remainingSec / 60)).padStart(2, '0');
      const s = String(remainingSec % 60).padStart(2, '0');
      restInlineHtml = `<div class="live-pab-rest-info" style="margin-bottom:6px;">
        <span class="live-pab-rest-label">⏱ Отдых (можно подождать)</span>
        <span class="live-pab-rest-countdown" id="livePabRestCountdownInline">${m}:${s}</span>
      </div>`;
      if (remainingSec <= 15 && remainingSec > 0) pab.classList.add('is-warning');
    }

    pab.innerHTML = `
      <div class="live-pab-content">
        ${restInlineHtml}
        <button class="live-pab-completed-btn" id="livePabCompleteNext" type="button">
          <span class="live-pab-primary-label">${escapeHtml(primaryLabel)}</span>
          <span class="live-pab-secondary-label">${escapeHtml(secondaryLabel)}</span>
        </button>
      </div>
    `;
    const nextBtn = document.getElementById('livePabCompleteNext');
    if (nextBtn) nextBtn.onclick = () => handleCompleteCurrentAndMoveNext();
    return;
  }

  if (activeSession.restState && activeSession.restState.isActive) {
    const remainingSec = Math.max(0, Math.ceil((activeSession.restState.endsAtMs - Date.now()) / 1000));
    const isWarning = remainingSec <= 15 && remainingSec > 0;
    if (isWarning) pab.classList.add('is-warning');

    const m = String(Math.floor(remainingSec / 60)).padStart(2, '0');
    const s = String(remainingSec % 60).padStart(2, '0');

    pab.innerHTML = `
      <div class="live-pab-content">
        <div class="live-pab-rest-info">
          <span class="live-pab-rest-label">⏱ Отдых · ATP-CrP</span>
          <span class="live-pab-rest-countdown" id="livePabRestCountdown">${m}:${s}</span>
        </div>
        <div class="live-pab-rest">
          <button class="live-pab-rest-btn" id="livePabRestMinus30" type="button">− 30 сек</button>
          <button class="live-pab-rest-btn" id="livePabRestPlus30" type="button">+ 30 сек</button>
          <button class="live-pab-rest-btn is-primary" id="livePabRestSkip" type="button">Пропустить &gt;&gt;</button>
        </div>
      </div>
    `;
    const minus = document.getElementById('livePabRestMinus30');
    const plus = document.getElementById('livePabRestPlus30');
    const skip = document.getElementById('livePabRestSkip');
    if (minus) minus.onclick = () => adjustRestTimer(-30);
    if (plus) plus.onclick = () => adjustRestTimer(30);
    if (skip) skip.onclick = () => stopRestTimer();
    return;
  }

  const isWarmupMode = (activeSession.draftSet.category === 'Разминка');
  const isSpecialActive = (!isWarmupMode && activeSession.draftSet.useSpecialMethod);
  const warmupSetsDone = currentEx.completedSets.filter(s => s.category === 'Разминка').length;
  const currentWarmupStepNum = Math.min(warmupSetsDone + 1, Math.max(1, (currentEx.warmupSteps || []).length));

  if (isSpecialActive && currentEx.isCluster) {
    const clusterInfo = parseClusterScheme(currentEx.plannedMethod, currentEx.defaultReps);
    const totalReps = clusterInfo.totalReps;
    pab.innerHTML = `
      <div class="live-pab-content">
        <div class="live-pab-method-combo">
          <button class="live-pab-method-btn" id="livePabRecordCluster" type="button">
            <span class="live-pab-primary-label">ЗАПИСАТЬ КЛАСТЕР ${escapeHtml(clusterInfo.schemeText)}</span>
            <span class="live-pab-secondary-label">${activeSession.draftSet.weight} кг · ~${totalReps} повт</span>
          </button>
          <button class="live-pab-clock-round" id="livePabBigClockBtn" type="button" aria-label="Открыть секундомер">
            <span class="material-symbols-outlined" aria-hidden="true">timer</span>
          </button>
        </div>
      </div>
    `;
    const recBtn = document.getElementById('livePabRecordCluster');
    if (recBtn) recBtn.onclick = () => openClusterSheet();
    const clockBtn = document.getElementById('livePabBigClockBtn');
    if (clockBtn) clockBtn.onclick = () => openBigClockOverlay();
    return;
  }

  if (isSpecialActive && currentEx.isDrop) {
    const dropEstimate = roundToGymStep(activeSession.draftSet.weight * 0.75);
    pab.innerHTML = `
      <div class="live-pab-content">
        <div class="live-pab-method-combo">
          <button class="live-pab-method-btn" id="livePabRecordDrop" type="button">
            <span class="live-pab-primary-label">ЗАПИСАТЬ ДРОП-СЕТ</span>
            <span class="live-pab-secondary-label">${activeSession.draftSet.weight} кг → ~${dropEstimate} кг</span>
          </button>
          <button class="live-pab-clock-round" id="livePabBigClockBtn" type="button" aria-label="Открыть секундомер">
            <span class="material-symbols-outlined" aria-hidden="true">timer</span>
          </button>
        </div>
      </div>
    `;
    const recBtn = document.getElementById('livePabRecordDrop');
    if (recBtn) recBtn.onclick = () => openDropSheet();
    const clockBtn = document.getElementById('livePabBigClockBtn');
    if (clockBtn) clockBtn.onclick = () => openBigClockOverlay();
    return;
  }

  let primaryLabel = '';
  let secondaryLabel = '';
  if (isWarmupMode) {
    primaryLabel = `ЗАПИСАТЬ РАЗМИНКУ #${currentWarmupStepNum}`;
    secondaryLabel = `${activeSession.draftSet.weight} кг × ${activeSession.draftSet.reps}`;
  } else {
    const currentWorkSetNum = workDone + 1;
    primaryLabel = `ЗАПИСАТЬ СЕТ #${currentWorkSetNum}`;
    secondaryLabel = `${activeSession.draftSet.weight} кг × ${activeSession.draftSet.reps}`;
  }

  pab.innerHTML = `
    <div class="live-pab-content">
      <button class="live-pab-record-btn" id="livePabRecord" type="button">
        <span class="live-pab-primary-label">${escapeHtml(primaryLabel)}</span>
        <span class="live-pab-secondary-label">${escapeHtml(secondaryLabel)}</span>
      </button>
    </div>
  `;
  const recBtn = document.getElementById('livePabRecord');
  if (recBtn) recBtn.onclick = () => handleRecordCurrentSet();
}

function patchDraftSetDisplay() {
  if (!activeSession) return;
  const wEl = document.getElementById('liveWeightValue');
  const rEl = document.getElementById('liveRepsValue');
  if (wEl) wEl.innerText = activeSession.draftSet.weight;
  if (rEl) rEl.innerText = activeSession.draftSet.reps;

  document.querySelectorAll('.live-rir-chip').forEach(chip => {
    const v = chip.getAttribute('data-rir');
    const isActive = v === String(activeSession.draftSet.rir);
    chip.classList.toggle('active', isActive);
    chip.setAttribute('aria-checked', isActive ? 'true' : 'false');
  });

  renderPAB();
}

/* =========================================================
 * NOTE CHIPS
 * ========================================================= */

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
 * RECORD ROUTER
 * ========================================================= */

function handleRecordCurrentSet() {
  if (!activeSession) return;
  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  if (!currentEx) return;

  const isWarmupMode = (activeSession.draftSet.category === 'Разминка');
  const isSpecialActive = !isWarmupMode && activeSession.draftSet.useSpecialMethod;

  if (isSpecialActive && currentEx.isCluster) { openClusterSheet(); return; }
  if (isSpecialActive && currentEx.isDrop) { openDropSheet(); return; }

  recordSimpleSet();
}

function recordSimpleSet() {
  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
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
  if (isWarmup) { effort = 'Размин.'; reserve = ''; }
  else if (rirRaw === '0') { effort = 'Максим.'; reserve = '+0'; }
  else if (rirRaw === '3+') { effort = 'Среднее'; reserve = '+3'; }

  const setNum = currentEx.completedSets.length + 1;
  const tonnage = parseFloat((weight * reps).toFixed(1));
  const e1rm = isWarmup ? 0.0 : computeE1RM(weight, reps);

  commitRecordedSet({
    setNum: setNum,
    weight: weight,
    reps: reps,
    firstSegmentReps: reps,
    dropWeight: 0,
    dropReps: 0,
    drops: [],
    effort: effort,
    reserve: reserve,
    method: '',
    category: isWarmup ? 'Разминка' : 'Рабочий',
    tonnage: tonnage,
    e1rm: e1rm
  });

  const kind = isWarmup ? 'Разминка' : 'Рабочий';
  logToTerminal('LIVE_SET', `${currentEx.name} • ${kind} #${setNum}: ${weight} кг × ${reps}${reserve ? ' (RIR ' + reserve + ')' : ''}`, 'success');
}

function commitRecordedSet(partialSet) {
  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];

  const nowMs = Date.now();
  const startedAtMs = activeSession.lastRestEndMs || nowMs;

  const recordedSet = {
    setNum: partialSet.setNum,
    weight: partialSet.weight,
    reps: partialSet.reps,
    firstSegmentReps: partialSet.firstSegmentReps,
    dropWeight: partialSet.dropWeight,
    dropReps: partialSet.dropReps,
    drops: Array.isArray(partialSet.drops) ? partialSet.drops : [],
    effort: partialSet.effort,
    reserve: partialSet.reserve,
    method: partialSet.method,
    category: partialSet.category,
    tonnage: partialSet.tonnage,
    e1rm: partialSet.e1rm,
    equipment: currentEx.equipment || '',
    positioning: currentEx.technique || '',
    startedAtMs: startedAtMs,
    recordedAtMs: nowMs,
    recordedAt: new Date(nowMs).toTimeString().slice(0, 8)
  };

  currentEx.completedSets.push(recordedSet);
  currentEx.allowBonusSet = false;

  const workDoneAfter = currentEx.completedSets.filter(s => s.category === 'Рабочий').length;
  if (workDoneAfter >= currentEx.targetSets) currentEx.isCompleted = true;

  if (!activeSession.headerManuallyToggled && currentEx.completedSets.length === 1) {
    activeSession.headerCollapsed = true;
  }

  if (recordedSet.category === 'Рабочий' && !activeSession.historyUiState.warmupCollapsed) {
    const warmupCount = currentEx.completedSets.filter(s => s.category === 'Разминка').length;
    if (warmupCount > 0) activeSession.historyUiState.warmupCollapsed = true;
  }

  triggerHaptic([80]);

  activeSession.draftSet = computeSmartDraftSetForExercise(currentEx);
  activeSession.lastRestEndMs = 0;

  const prefs = getTimerPrefs();
  let restSeconds = prefs.compound;
  if (recordedSet.category === 'Разминка') restSeconds = prefs.warmup;
  else if (currentEx.order > 2) restSeconds = prefs.isolation;

  startRestTimer(restSeconds);
  persistActiveSession();
  renderLiveWorkoutScreen();
}

/* =========================================================
 * CLUSTER SHEET
 * ========================================================= */

function openClusterSheet() {
  if (!activeSession) return;
  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  if (!currentEx) return;

  const scheme = parseClusterScheme(currentEx.plannedMethod, currentEx.defaultReps);
  const segments = scheme.segments.length > 0 ? scheme.segments : [4, 3, 2];

  activeClusterSheetState = {
    schemeText: scheme.schemeText || segments.join('+'),
    weight: activeSession.draftSet.weight,
    segments: segments.map((reps, idx) => ({
      reps: reps,
      rir: defaultRirForSegment(idx, segments.length)
    }))
  };

  renderClusterSheet();
  registerLiveModals();
  openModal('liveClusterSheet');
}

function renderClusterSheet() {
  const sheetState = activeClusterSheetState;
  if (!sheetState) return;

  const titleEl = document.getElementById('liveClusterSheetTitle');
  const subtitleEl = document.getElementById('liveClusterSheetSubtitle');
  const container = document.getElementById('liveClusterSegmentsContainer');
  const summaryEl = document.getElementById('liveClusterSummary');
  if (!container) return;

  if (titleEl) titleEl.innerText = `Запись кластера ${sheetState.schemeText}`;
  if (subtitleEl) subtitleEl.innerText = `Вес ${sheetState.weight} кг · рабочий подход`;

  container.innerHTML = sheetState.segments.map((seg, idx) => `
    <div class="live-sheet-row-2">
      <div class="live-sheet-row-2-top">
        <span class="live-sheet-row-2-label">Сегмент ${idx + 1}</span>
        <div class="live-sheet-rir">
          ${['0','1','2','3+'].map(v => `
            <button class="live-sheet-rir-chip ${seg.rir === v ? 'active' : ''}" data-cluster-rir="${idx}" data-rir-val="${v}" type="button">${v}</button>
          `).join('')}
        </div>
      </div>
      <div class="live-sheet-row-2-bottom">
        <button class="live-sheet-mini-btn" data-cluster-reps="${idx}" data-delta="-1" type="button">−</button>
        <span class="live-sheet-value">${seg.reps}</span>
        <button class="live-sheet-mini-btn" data-cluster-reps="${idx}" data-delta="+1" type="button">+</button>
        <span class="live-sheet-unit">повт</span>
      </div>
    </div>
  `).join('');

  const totalReps = sheetState.segments.reduce((a, s) => a + s.reps, 0);
  const tonnage = parseFloat((sheetState.weight * totalReps).toFixed(1));
  const firstSeg = sheetState.segments[0] ? sheetState.segments[0].reps : totalReps;
  const e1rm = computeE1RM(sheetState.weight, firstSeg);

  if (summaryEl) {
    summaryEl.innerHTML = `Итого: <b>${totalReps} повт.</b> · тоннаж <b>${tonnage} кг</b> · e1RM по 1-му сегменту: <b>~${e1rm} кг</b>`;
  }

  container.querySelectorAll('[data-cluster-reps]').forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.getAttribute('data-cluster-reps'), 10);
      const delta = parseInt(btn.getAttribute('data-delta'), 10);
      sheetState.segments[idx].reps = Math.max(1, sheetState.segments[idx].reps + delta);
      triggerHaptic([15]);
      renderClusterSheet();
    };
  });
  container.querySelectorAll('[data-cluster-rir]').forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.getAttribute('data-cluster-rir'), 10);
      const val = btn.getAttribute('data-rir-val');
      sheetState.segments[idx].rir = val;
      triggerHaptic([15]);
      renderClusterSheet();
    };
  });
}

function saveClusterSet() {
  const sheetState = activeClusterSheetState;
  if (!sheetState || !activeSession) return;

  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  const segments = sheetState.segments;
  const totalReps = segments.reduce((a, s) => a + s.reps, 0);
  const firstSegmentReps = segments[0] ? segments[0].reps : totalReps;
  const lastRir = segments[segments.length - 1] ? segments[segments.length - 1].rir : '1';
  const rirChain = segments.map(s => s.rir).join('/');
  const weight = sheetState.weight;
  const tonnage = parseFloat((weight * totalReps).toFixed(1));
  const e1rm = computeE1RM(weight, firstSegmentReps);

  const method = `Кластер ${sheetState.schemeText} (RIR ${rirChain})`;
  const setNum = currentEx.completedSets.length + 1;

  commitRecordedSet({
    setNum: setNum,
    weight: weight,
    reps: totalReps,
    firstSegmentReps: firstSegmentReps,
    dropWeight: 0,
    dropReps: 0,
    drops: [],
    effort: 'Максим.',
    reserve: `+${lastRir.replace('+','')}`,
    method: method,
    category: 'Рабочий',
    tonnage: tonnage,
    e1rm: e1rm
  });

  logToTerminal('LIVE_SET', `${currentEx.name} • Кластер #${setNum}: ${weight} кг [${sheetState.schemeText}] = ${totalReps} повт (RIR ${rirChain})`, 'success');

  activeClusterSheetState = null;
  closeModal('liveClusterSheet');
}

/* =========================================================
 * DROP SHEET — V2.4: сохраняем ПОЛНЫЙ массив drops
 * ========================================================= */

function openDropSheet() {
  if (!activeSession) return;
  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  if (!currentEx) return;

  const mainWeight = parseFloat(activeSession.draftSet.weight) || currentEx.targetWeight;
  const mainReps = parseInt(activeSession.draftSet.reps, 10) || currentEx.defaultReps;
  const mainRir = String(activeSession.draftSet.rir || '2');
  const firstDropWeight = roundToGymStep(mainWeight * 0.75);

  activeDropSheetState = {
    mainWeight: mainWeight,
    mainReps: mainReps,
    mainRir: mainRir,
    drops: [
      { weight: firstDropWeight, reps: 5, rir: '0' }
    ]
  };

  renderDropSheet();
  registerLiveModals();
  openModal('liveDropSheet');
}

function renderDropSheet() {
  const sheetState = activeDropSheetState;
  if (!sheetState) return;

  const subtitleEl = document.getElementById('liveDropSheetSubtitle');
  const mainWeightEl = document.getElementById('liveDropMainWeight');
  const mainRepsEl = document.getElementById('liveDropMainReps');
  const mainRirEl = document.getElementById('liveDropMainRir');
  const dropsContainer = document.getElementById('liveDropDropsContainer');
  const summaryEl = document.getElementById('liveDropSummary');
  if (!dropsContainer) return;

  if (subtitleEl) subtitleEl.innerText = `Вес ${sheetState.mainWeight} кг · основной + ${sheetState.drops.length} дроп${sheetState.drops.length > 1 ? 'а' : ''}`;
  if (mainWeightEl) mainWeightEl.innerText = sheetState.mainWeight;
  if (mainRepsEl) mainRepsEl.innerText = sheetState.mainReps;

  if (mainRirEl) {
    mainRirEl.innerHTML = ['0','1','2','3+'].map(v => `
      <button class="live-sheet-rir-chip ${sheetState.mainRir === v ? 'active' : ''}" data-drop-main-rir="${v}" type="button">${v}</button>
    `).join('');
  }

  dropsContainer.innerHTML = sheetState.drops.map((drop, idx) => `
    <div class="live-sheet-row-2">
      <div class="live-sheet-row-2-top">
        <span class="live-sheet-row-2-label">Дроп ${idx + 1}</span>
        <div class="live-sheet-rir">
          ${['0','1','2','3+'].map(v => `
            <button class="live-sheet-rir-chip ${drop.rir === v ? 'active' : ''}" data-drop-rir="${idx}" data-rir-val="${v}" type="button">${v}</button>
          `).join('')}
        </div>
      </div>
      <div class="live-sheet-row-2-bottom">
        <button class="live-sheet-mini-btn" data-drop-adjust="weight" data-drop-idx="${idx}" data-delta="-2.5" type="button">−</button>
        <span class="live-sheet-value">${drop.weight}</span>
        <button class="live-sheet-mini-btn" data-drop-adjust="weight" data-drop-idx="${idx}" data-delta="+2.5" type="button">+</button>
        <span class="live-sheet-unit">кг ×</span>
        <button class="live-sheet-mini-btn" data-drop-adjust="reps" data-drop-idx="${idx}" data-delta="-1" type="button">−</button>
        <span class="live-sheet-value">${drop.reps}</span>
        <button class="live-sheet-mini-btn" data-drop-adjust="reps" data-drop-idx="${idx}" data-delta="+1" type="button">+</button>
        <span class="live-sheet-unit">повт</span>
      </div>
    </div>
  `).join('');

  const totalTonnage = sheetState.mainWeight * sheetState.mainReps
    + sheetState.drops.reduce((a, d) => a + d.weight * d.reps, 0);
  const e1rm = computeE1RM(sheetState.mainWeight, sheetState.mainReps);

  if (summaryEl) {
    summaryEl.innerHTML = `Тоннаж: <b>${totalTonnage.toFixed(1)} кг</b> · e1RM по основному: <b>~${e1rm} кг</b>`;
  }

  dropsContainer.querySelectorAll('[data-drop-adjust]').forEach(btn => {
    btn.onclick = () => {
      const field = btn.getAttribute('data-drop-adjust');
      const idx = parseInt(btn.getAttribute('data-drop-idx'), 10);
      const delta = parseFloat(btn.getAttribute('data-delta'));
      if (field === 'weight') {
        sheetState.drops[idx].weight = Math.max(0, parseFloat((sheetState.drops[idx].weight + delta).toFixed(2)));
      } else {
        sheetState.drops[idx].reps = Math.max(1, sheetState.drops[idx].reps + Math.round(delta));
      }
      triggerHaptic([15]);
      renderDropSheet();
    };
  });
  dropsContainer.querySelectorAll('[data-drop-rir]').forEach(btn => {
    btn.onclick = () => {
      const idx = parseInt(btn.getAttribute('data-drop-rir'), 10);
      const val = btn.getAttribute('data-rir-val');
      sheetState.drops[idx].rir = val;
      triggerHaptic([15]);
      renderDropSheet();
    };
  });

  const mainRow = document.getElementById('liveDropMainRow');
  if (mainRow) {
    mainRow.querySelectorAll('[data-drop-adjust]').forEach(btn => {
      btn.onclick = () => {
        const field = btn.getAttribute('data-drop-adjust');
        const delta = parseFloat(btn.getAttribute('data-delta'));
        if (field === 'main-weight') {
          sheetState.mainWeight = Math.max(0, parseFloat((sheetState.mainWeight + delta).toFixed(2)));
        } else if (field === 'main-reps') {
          sheetState.mainReps = Math.max(1, sheetState.mainReps + Math.round(delta));
        }
        triggerHaptic([15]);
        renderDropSheet();
      };
    });
  }
  if (mainRirEl) {
    mainRirEl.querySelectorAll('[data-drop-main-rir]').forEach(btn => {
      btn.onclick = () => {
        sheetState.mainRir = btn.getAttribute('data-drop-main-rir');
        triggerHaptic([15]);
        renderDropSheet();
      };
    });
  }
}

function addDropStep() {
  const sheetState = activeDropSheetState;
  if (!sheetState || !sheetState.drops.length) return;
  const lastDrop = sheetState.drops[sheetState.drops.length - 1];
  const newWeight = roundToGymStep(lastDrop.weight * 0.75);
  sheetState.drops.push({ weight: newWeight, reps: 5, rir: '0' });
  triggerHaptic([25]);
  renderDropSheet();
}

function saveDropSet() {
  const sheetState = activeDropSheetState;
  if (!sheetState || !activeSession) return;

  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  const mainWeight = sheetState.mainWeight;
  const mainReps = sheetState.mainReps;
  const mainRir = sheetState.mainRir;
  const drops = sheetState.drops;

  const firstDrop = drops[0] || { weight: 0, reps: 0 };
  const totalTonnage = mainWeight * mainReps + drops.reduce((a, d) => a + d.weight * d.reps, 0);
  const e1rm = computeE1RM(mainWeight, mainReps);

  let methodLabel;
  if (drops.length === 1) methodLabel = `Дроп-сет (осн. RIR ${mainRir.replace('+','')})`;
  else if (drops.length === 2) methodLabel = `Двойной дроп-сет (осн. RIR ${mainRir.replace('+','')})`;
  else methodLabel = `${drops.length}-й дроп-сет (осн. RIR ${mainRir.replace('+','')})`;

  const setNum = currentEx.completedSets.length + 1;

  // V2.4: сохраняем массив drops целиком
  const dropsPayload = drops.map(d => ({
    weight: parseFloat(d.weight) || 0,
    reps: parseInt(d.reps, 10) || 0,
    rir: String(d.rir || '0')
  }));

  commitRecordedSet({
    setNum: setNum,
    weight: mainWeight,
    reps: mainReps,
    firstSegmentReps: mainReps,
    dropWeight: firstDrop.weight,
    dropReps: firstDrop.reps,
    drops: dropsPayload,
    effort: 'Максим.',
    reserve: `+${mainRir.replace('+','')}`,
    method: methodLabel,
    category: 'Рабочий',
    tonnage: parseFloat(totalTonnage.toFixed(1)),
    e1rm: e1rm
  });

  const chain = drops.map(d => `${d.weight}×${d.reps}`).join(' → ');
  logToTerminal('LIVE_SET', `${currentEx.name} • ${methodLabel}: ${mainWeight}×${mainReps} → ${chain}`, 'success');

  activeDropSheetState = null;
  closeModal('liveDropSheet');
}

/* =========================================================
 * NAVIGATION
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
    const prefs = getTimerPrefs();
    startRestTimer(prefs.compound);
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
  renderPAB();
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
  activeSession.lastRestEndMs = Date.now();
  if (restTimerInterval) { clearInterval(restTimerInterval); restTimerInterval = null; }
  persistActiveSession();
  renderPAB();
}

function syncRestTimerWithWallClock() {
  if (!activeSession) return;

  if (!activeSession.restState || !activeSession.restState.isActive) {
    if (restTimerInterval) { clearInterval(restTimerInterval); restTimerInterval = null; }
    return;
  }

  if (!document.getElementById('livePabRestCountdown') && !document.getElementById('livePabRestCountdownInline')) {
    renderPAB();
  }

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

    const countdownEl = document.getElementById('livePabRestCountdown');
    const inlineEl = document.getElementById('livePabRestCountdownInline');
    const pab = document.getElementById('liveBottomActionBar');

    if (countdownEl) countdownEl.innerText = `${m}:${s}`;
    if (inlineEl) inlineEl.innerText = `${m}:${s}`;

    if (pab) {
      const isWarning = remainingSec <= 15 && remainingSec > 0;
      pab.classList.toggle('is-warning', isWarning);
    }
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
  activeSession.headerCollapsed = (ex.completedSets.length > 0);
  activeSession.headerManuallyToggled = false;
  activeSession.historyUiState = { warmupCollapsed: false, workCollapsed: false };

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
  const workRestDiffs = [];

  activeSession.exercises.forEach(ex => {
    const allSets = ex.completedSets;
    const ordered = [...allSets].sort((a, b) => (a.recordedAtMs || 0) - (b.recordedAtMs || 0));
    for (let i = 1; i < ordered.length; i++) {
      const prev = ordered[i - 1];
      const cur = ordered[i];
      if (cur.startedAtMs && prev.recordedAtMs) {
        const restSec = Math.round((cur.startedAtMs - prev.recordedAtMs) / 1000);
        if (restSec >= 15 && restSec <= 900) workRestDiffs.push(restSec);
      }
    }

    allSets.forEach(s => {
      if (s.category === 'Рабочий') {
        totalWorkSets++;
        workTonnageKg += (s.tonnage || 0);
        const rirClean = parseFloat(String(s.reserve || '').replace('+', ''));
        if (!isNaN(rirClean)) { rirSum += rirClean; rirCount++; }
      } else {
        totalWarmupSets++;
      }
    });
  });

  const endTimestampMs = Date.now();
  const startReferenceMs = activeSession.startedAtMs;
  const durationMin = Math.max(1, Math.round((endTimestampMs - startReferenceMs) / 60000));
  const workTonnage = parseFloat(workTonnageKg.toFixed(1));
  const density = parseFloat((workTonnage / durationMin).toFixed(1));
  const avgRir = rirCount > 0 ? parseFloat((rirSum / rirCount).toFixed(1)) : 2.0;

  const avgRestSec = workRestDiffs.length > 0
    ? Math.round(workRestDiffs.reduce((a, b) => a + b, 0) / workRestDiffs.length)
    : 0;

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
    <div>• Подходы: <b>${m.totalWorkSets} раб.</b> (разм: ${m.totalWarmupSets}) • Ср. RIR: <b>${m.avgRir}</b></div>
    <div>• Тоннаж: <b>${(m.workTonnage / 1000).toFixed(2)} т</b> (${Math.round(m.workTonnage)} кг)</div>
    <div>• Ср. отдых: <b>${m.avgRestSec > 0 ? m.avgRestSec + ' сек' : 'н/д'}</b> • Фостер: <b>${m.trainingLoad} ед.</b></div>
  `;
}

/* =========================================================
 * FINALIZE SYNC — V2.4: передаём массив drops в payload
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
        drops: Array.isArray(s.drops) ? s.drops : [],
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
    statusEl.innerText = '⏳ Отправка подходов и сводки в Google Таблицы...';
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
    if (freshData.success && freshData.data) setInitialData(freshData.data);

    logToTerminal('LIVE_SYNC_VERIFIED', `Локальный кэш обновлен: ${(freshData.data.sets || []).length} сетов`, 'success');

    stopAllTimers();
    stopBigClock();
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

  const timerPillBtn = document.getElementById('liveHeaderTimer');
  if (timerPillBtn) timerPillBtn.onclick = () => openBigClockOverlay();

  const prevBtn = document.getElementById('livePrevExBtn');
  const nextBtn = document.getElementById('liveNextExBtn');
  if (prevBtn) prevBtn.onclick = () => { if (activeSession) switchActiveExercise(activeSession.currentExerciseIndex - 1); };
  if (nextBtn) nextBtn.onclick = () => { if (activeSession) switchActiveExercise(activeSession.currentExerciseIndex + 1); };

  const headerCompact = document.getElementById('liveExHeaderCompact');
  if (headerCompact) {
    headerCompact.onclick = () => toggleHeaderCollapse(false);
    headerCompact.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHeaderCollapse(false); }
    });
  }
  const headerCollapseBtn = document.getElementById('liveExHeaderCollapseBtn');
  if (headerCollapseBtn) {
    headerCollapseBtn.onclick = (e) => { e.stopPropagation(); toggleHeaderCollapse(true); };
  }

  const warmupGroupHeader = document.getElementById('liveWarmupGroupHeader');
  if (warmupGroupHeader) {
    warmupGroupHeader.onclick = () => {
      if (!activeSession) return;
      activeSession.historyUiState.warmupCollapsed = !activeSession.historyUiState.warmupCollapsed;
      persistActiveSession();
      renderHistoryGroups();
    };
  }
  const workGroupHeader = document.getElementById('liveWorkGroupHeader');
  if (workGroupHeader) {
    workGroupHeader.onclick = () => {
      if (!activeSession) return;
      activeSession.historyUiState.workCollapsed = !activeSession.historyUiState.workCollapsed;
      persistActiveSession();
      renderHistoryGroups();
    };
  }

  const equipChip = document.getElementById('liveEquipmentChip');
  const techChip = document.getElementById('liveTechniqueChip');
  if (equipChip) equipChip.onclick = () => openNotesSheet();
  if (techChip) techChip.onclick = () => openNotesSheet();

  const notesSaveBtn = document.getElementById('liveNotesSaveBtn');
  const notesCancelBtn = document.getElementById('liveNotesCancelBtn');
  if (notesSaveBtn) notesSaveBtn.onclick = () => saveNotesSheet();
  if (notesCancelBtn) notesCancelBtn.onclick = () => closeModal('liveNotesSheet');

  const equipInput = document.getElementById('liveNotesEquipmentInput');
  if (equipInput) {
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
      if (useSpecial && ex.isCluster) reps = parseClusterScheme(ex.plannedMethod, ex.defaultReps).totalReps;
      activeSession.draftSet.category = 'Рабочий';
      activeSession.draftSet.weight = ex.targetWeight;
      activeSession.draftSet.reps = reps;
      activeSession.draftSet.useSpecialMethod = useSpecial;
      persistActiveSession();
      renderLiveWorkoutScreen();
    };
  }

  const methodChip = document.getElementById('liveMethodToggleBtn');
  if (methodChip) {
    methodChip.onclick = () => {
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

  const addBonusSetBtn = document.getElementById('liveAddBonusSetBtn');
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
      patchDraftSetDisplay();
    };
  }
  if (wPlus) {
    wPlus.onclick = () => {
      if (!activeSession) return;
      activeSession.draftSet.weight = activeSession.draftSet.weight + 2.5;
      triggerHaptic(20);
      persistActiveSession();
      patchDraftSetDisplay();
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
      patchDraftSetDisplay();
    };
  }
  if (rPlus) {
    rPlus.onclick = () => {
      if (!activeSession) return;
      activeSession.draftSet.reps = activeSession.draftSet.reps + 1;
      triggerHaptic(20);
      persistActiveSession();
      patchDraftSetDisplay();
    };
  }

  document.querySelectorAll('.live-rir-chip').forEach(chip => {
    chip.onclick = () => {
      if (!activeSession) return;
      activeSession.draftSet.rir = chip.getAttribute('data-rir') || '2';
      triggerHaptic(20);
      persistActiveSession();
      patchDraftSetDisplay();
    };
  });

  const bigClockClose = document.getElementById('liveBigClockClose');
  if (bigClockClose) bigClockClose.onclick = () => closeModal('liveBigClockOverlay');

  const clusterSaveBtn = document.getElementById('liveClusterSaveBtn');
  const clusterCancelBtn = document.getElementById('liveClusterCancelBtn');
  if (clusterSaveBtn) clusterSaveBtn.onclick = () => saveClusterSet();
  if (clusterCancelBtn) clusterCancelBtn.onclick = () => closeModal('liveClusterSheet');

  const dropSaveBtn = document.getElementById('liveDropSaveBtn');
  const dropCancelBtn = document.getElementById('liveDropCancelBtn');
  const dropAddBtn = document.getElementById('liveDropAddBtn');
  if (dropSaveBtn) dropSaveBtn.onclick = () => saveDropSet();
  if (dropCancelBtn) dropCancelBtn.onclick = () => closeModal('liveDropSheet');
  if (dropAddBtn) dropAddBtn.onclick = () => addDropStep();

  const openTimerPrefsBtn = document.getElementById('liveOpenTimerSettingsBtn');
  const saveTimerPrefsBtn = document.getElementById('saveLiveTimerSettingsBtn');
  if (openTimerPrefsBtn) {
    openTimerPrefsBtn.onclick = () => {
      const prefs = getTimerPrefs();
      const cEl = document.getElementById('prefTimerCompound');
      const iEl = document.getElementById('prefTimerIsolation');
      const clEl = document.getElementById('prefTimerCluster');
      const dEl = document.getElementById('prefTimerDrop');
      if (cEl) cEl.value = prefs.compound;
      if (iEl) iEl.value = prefs.isolation;
      if (clEl) clEl.value = prefs.cluster;
      if (dEl) dEl.value = prefs.drop;
      registerLiveModals();
      openModal('liveTimerSettingsModal');
    };
  }
  if (saveTimerPrefsBtn) {
    saveTimerPrefsBtn.onclick = () => {
      const cEl = document.getElementById('prefTimerCompound');
      const iEl = document.getElementById('prefTimerIsolation');
      const clEl = document.getElementById('prefTimerCluster');
      const dEl = document.getElementById('prefTimerDrop');
      const newPrefs = {
        compound: Math.max(10, parseInt(cEl ? cEl.value : '150', 10) || 150),
        isolation: Math.max(10, parseInt(iEl ? iEl.value : '90', 10) || 90),
        cluster: Math.max(5, parseInt(clEl ? clEl.value : '20', 10) || 20),
        drop: Math.max(5, parseInt(dEl ? dEl.value : '15', 10) || 15),
        warmup: 60
      };
      saveTimerPrefs(newPrefs);
      closeModal('liveTimerSettingsModal');
      renderPAB();
    };
  }

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

  const confirmFinishBtn = document.getElementById('liveConfirmFinishBtn');
  const discardSessionBtn = document.getElementById('liveDiscardWorkoutBtn');
  if (confirmFinishBtn) confirmFinishBtn.onclick = () => finalizeAndSyncLiveWorkout();
  if (discardSessionBtn) discardSessionBtn.onclick = () => discardLiveWorkoutSession();
}

/* =========================================================
 * HEADER COLLAPSE
 * ========================================================= */

function toggleHeaderCollapse(forceCollapsed) {
  if (!activeSession) return;
  if (typeof forceCollapsed === 'boolean') {
    activeSession.headerCollapsed = forceCollapsed;
  } else {
    activeSession.headerCollapsed = !activeSession.headerCollapsed;
  }
  activeSession.headerManuallyToggled = true;
  persistActiveSession();
  renderExerciseHeader();
}
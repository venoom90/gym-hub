/**
 * =========================================================================
 * GYM ANALYTICS HUB — LIVE WORKOUT ENGINE (V2.0 COMPACT & FLOATING)
 * =========================================================================
 * V2.0 «Compact & Thumb»:
 * - Компактный топбар 48px: ‹ | таймер | ⚙ | Финиш
 * - Progress Strip 44px: chevrons + сегменты + счётчик (вместо мини-карты)
 * - Сворачиваемый header упражнения (автосвёртка после первого сета)
 * - PAB (Persistent Action Bar) — fixed bottom, blur, меняется по контексту:
 *     • запись сета → зелёная кнопка «ЗАПИСАТЬ»
 *     • отдых → 3 кнопки −30/+30/Пропустить + обратный отсчёт
 *     • упражнение выполнено → primary «ЗАВЕРШИТЬ → УПР. #N»
 * - Rest-timer живёт в PAB, красный при <15 сек
 * - Точечные апдейты DOM для RIR/степперов (без полного re-render)
 * - Журнал: группы Разминка (свёрнута) / Рабочие (развёрнуты)
 * - Floating-кнопка «Пауза 20с» над PAB при активном кластере
 * - V1.5.2: Enter в «Оборудование» → фокус на «Технику» (bottom sheet)
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
        renderLiveWorkoutScreen();
        syncRestTimerWithWallClock();
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
    isFinished: false,
    // V2.0 UI state
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
      // V2.0: миграция старых сессий
      if (typeof parsed.headerCollapsed !== 'boolean') parsed.headerCollapsed = false;
      if (typeof parsed.headerManuallyToggled !== 'boolean') parsed.headerManuallyToggled = false;
      if (!parsed.historyUiState || typeof parsed.historyUiState !== 'object') {
        parsed.historyUiState = { warmupCollapsed: false, workCollapsed: false };
      }
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
 * MAIN RENDER (V2.0 — точечный, разбит на подмодули)
 * ========================================================= */

function renderLiveWorkoutScreen() {
  if (!activeSession) return;
  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  if (!currentEx) return;

  // Ensure UI state defaults exist (migration safety)
  if (typeof activeSession.headerCollapsed !== 'boolean') activeSession.headerCollapsed = false;
  if (typeof activeSession.headerManuallyToggled !== 'boolean') activeSession.headerManuallyToggled = false;
  if (!activeSession.historyUiState) {
    activeSession.historyUiState = { warmupCollapsed: false, workCollapsed: false };
  }

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
  renderClusterFloatBtn();
}

/* -------- Progress Strip -------- */

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
    const isCurrent = idx === current;

    if (isDone) seg.classList.add('is-done');
    else if (isCurrent) seg.classList.add('is-current');
    seg.setAttribute('title', ex.name);
    container.appendChild(seg);
  });

  if (counter) counter.innerText = `${current + 1}/${total}`;
  if (prevBtn) prevBtn.disabled = current <= 0;
  if (nextBtn) nextBtn.disabled = current >= total - 1;
}

/* -------- Exercise Header (collapsible) -------- */

function renderExerciseHeader() {
  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  if (!currentEx) return;

  const card = document.getElementById('liveExHeaderCard');
  const compactEl = document.getElementById('liveExHeaderCompact');
  const fullEl = document.getElementById('liveExHeaderFull');
  if (!card) return;

  const isCollapsed = activeSession.headerCollapsed === true;

  if (isCollapsed) {
    if (compactEl) compactEl.style.display = 'flex';
    if (fullEl) fullEl.style.display = 'none';
    card.classList.add('is-collapsed');

    const nameEl = document.getElementById('liveExNameCompact');
    const subEl = document.getElementById('liveExSubCompact');
    if (nameEl) nameEl.innerText = currentEx.name;

    const lastWorkSet = [...currentEx.completedSets].reverse().find(s => s.category === 'Рабочий');
    const planPart = `план ${currentEx.targetWeight}×${currentEx.targetRepsStr}`;
    let lastPart = '';
    if (lastWorkSet) {
      const rirTxt = lastWorkSet.reserve ? ` (RIR ${lastWorkSet.reserve.replace('+','')})` : '';
      lastPart = ` · посл. ${lastWorkSet.weight}×${lastWorkSet.reps}${rirTxt}`;
    }
    if (subEl) subEl.innerText = `${planPart}${lastPart}`;
  } else {
    if (compactEl) compactEl.style.display = 'none';
    if (fullEl) fullEl.style.display = 'flex';
    card.classList.remove('is-collapsed');

    const nameEl = document.getElementById('liveExName');
    const subEl = document.getElementById('liveExTargetSubtitle');
    if (nameEl) nameEl.innerText = currentEx.name;
    if (subEl) {
      const specText = (currentEx.plannedMethod && currentEx.plannedMethod !== 'Стандарт')
        ? ` • Финал: <b>${escapeHtml(currentEx.plannedMethod)}</b>`
        : '';
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

/* -------- Note chips -------- */

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

/* -------- Current set label -------- */

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

/* -------- Category toggle -------- */

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

/* -------- Method toggle -------- */

function renderMethodToggle() {
  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  const isWarmupMode = activeSession.draftSet.category === 'Разминка';
  const isSpecialActive = (!isWarmupMode && activeSession.draftSet.useSpecialMethod);

  const row = document.getElementById('liveMethodToggleRow');
  const btn = document.getElementById('liveToggleSpecialMethodBtn');
  if (!row || !btn) return;

  if (!isWarmupMode && currentEx.plannedMethod && currentEx.plannedMethod !== 'Стандарт') {
    row.style.display = 'flex';
    if (isSpecialActive) {
      btn.classList.add('active');
      btn.innerText = `⚡ Активен метод: ${currentEx.plannedMethod} (нажмите для обычного)`;
    } else {
      btn.classList.remove('active');
      btn.innerText = `Обычный рабочий сет (включить ${currentEx.plannedMethod})`;
    }
  } else {
    row.style.display = 'none';
  }
}

/* -------- Stepper values -------- */

function renderStepperValues() {
  const wEl = document.getElementById('liveWeightValue');
  const rEl = document.getElementById('liveRepsValue');
  if (wEl) wEl.innerText = activeSession.draftSet.weight;
  if (rEl) rEl.innerText = activeSession.draftSet.reps;
}

/* -------- RIR chips -------- */

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

/* -------- Intensifier banner -------- */

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
      <div><b>Финальный Дроп-сет:</b> после основного подхода сбросьте вес на <b>${dropLoad} кг (-25%)</b> и дожмите <b>5 повт.</b> без отдыха (учтётся в тоннаже автоматически).</div>
    `;
  } else if (isSpecialActive && currentEx.isCluster) {
    const clusterInfo = parseClusterScheme(currentEx.plannedMethod, currentEx.defaultReps);
    el.style.display = 'flex';
    el.innerHTML = `
      <span class="material-symbols-outlined" style="font-size:18px; color: var(--md-sys-color-primary);">timer</span>
      <div><b>Финальный Кластер (${escapeHtml(clusterInfo.schemeText)}):</b> кнопка «Пауза» — плавающая справа внизу. В зачёт идёт сумма повторений (${clusterInfo.totalReps}).</div>
    `;
  } else {
    el.style.display = 'none';
  }
}

/* -------- Controls visibility -------- */

function renderControlsVisibility() {
  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  const workDone = currentEx.completedSets.filter(s => s.category === 'Рабочий').length;
  const isTargetReached = (workDone >= currentEx.targetSets) && !currentEx.allowBonusSet;

  const controls = document.getElementById('liveActiveSetControlsCard');
  if (controls) controls.style.display = isTargetReached ? 'none' : 'flex';
}

/* -------- Completed card -------- */

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
      const bonusTag = workDone > currentEx.targetSets
        ? ` (+${workDone - currentEx.targetSets} бонус)`
        : '';
      title.innerText = `✅ Упражнение выполнено (${Math.min(workDone, currentEx.targetSets)} из ${currentEx.targetSets}${bonusTag})`;
    }
  } else {
    card.style.display = 'none';
  }
}

/* -------- History groups -------- */

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

  // --- Warmup group ---
  if (warmupSets.length > 0 && warmupGroup && warmupBody) {
    warmupGroup.style.display = 'block';
    const last = warmupSets[warmupSets.length - 1];
    if (warmupMeta) {
      warmupMeta.innerText = `${warmupSets.length} • посл. ${last.weight} кг × ${last.reps}`;
    }
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

  // --- Work group ---
  if (workSets.length > 0 && workGroup && workBody) {
    workGroup.style.display = 'block';
    const last = workSets[workSets.length - 1];
    const rirTxt = last.reserve ? ` · RIR ${last.reserve.replace('+','')}` : '';
    if (workMeta) {
      workMeta.innerText = `${workSets.length} / ${currentEx.targetSets} • посл. ${last.weight}×${last.reps}${rirTxt}`;
    }
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

function renderHistoryRow(set, displayNum, kind) {
  const label = kind === 'warmup' ? `Разм. #${displayNum}` : `Раб. #${displayNum}`;
  const color = kind === 'warmup'
    ? 'var(--md-sys-color-on-surface-variant)'
    : 'var(--app-color-success)';

  const rirChip = (kind === 'work' && set.reserve)
    ? `<span class="coach-card-chip">RIR ${escapeHtml(set.reserve.replace('+',''))}</span>` : '';
  const methodChip = (kind === 'work' && set.method)
    ? `<span class="coach-method-badge">${escapeHtml(set.method)}</span>` : '';

  return `
    <div class="live-history-row">
      <div style="display:flex; align-items:center; gap:8px; flex-wrap:wrap; flex:1; min-width:0;">
        <span style="font-weight:700; color:${color}; min-width:66px; flex-shrink:0;">${label}</span>
        <span><b>${set.weight} кг × ${set.reps}</b></span>
        ${rirChip}
        ${methodChip}
      </div>
      <button class="live-delete-set-btn" data-set-idx="${displayNum - 1}" data-kind="${kind}" title="Удалить подход">
        <span class="material-symbols-outlined" style="font-size:18px;">delete</span>
      </button>
    </div>
  `;
}

function attachHistoryRowHandlers(container, sets, currentEx) {
  container.querySelectorAll('.live-delete-set-btn').forEach(btn => {
    const idx = parseInt(btn.getAttribute('data-set-idx'), 10);
    btn.onclick = () => {
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
      renderLiveWorkoutScreen();
    };
  });
}

/* -------- Cluster floating button -------- */

function renderClusterFloatBtn() {
  const btn = document.getElementById('liveClusterPauseBtn');
  if (!btn || !activeSession) return;

  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  if (!currentEx) return;

  const isWarmupMode = activeSession.draftSet.category === 'Разминка';
  const isClusterActive = !isWarmupMode && activeSession.draftSet.useSpecialMethod && currentEx.isCluster;
  const restActive = activeSession.restState && activeSession.restState.isActive;

  if (isClusterActive && !restActive) {
    const prefs = getTimerPrefs();
    const labelEl = document.getElementById('liveClusterFloatLabel');
    if (labelEl) labelEl.innerText = `${prefs.cluster}с`;
    btn.style.display = 'flex';
  } else {
    btn.style.display = 'none';
  }
}

/* =========================================================
 * PAB (Persistent Action Bar)
 * ========================================================= */

function renderPAB() {
  const pab = document.getElementById('liveBottomActionBar');
  if (!pab || !activeSession) return;

  const currentEx = activeSession.exercises[activeSession.currentExerciseIndex];
  if (!currentEx) return;

  pab.classList.remove('is-warning');

  // ----- State 1: Rest active -----
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

  // ----- State 2: Exercise completed -----
  const workDone = currentEx.completedSets.filter(s => s.category === 'Рабочий').length;
  const isTargetReached = (workDone >= currentEx.targetSets) && !currentEx.allowBonusSet;

  if (isTargetReached) {
    const nextExIdx = findNextIncompleteExerciseIndex(activeSession.currentExerciseIndex);
    let primaryLabel = 'ЗАВЕРШИТЬ УПРАЖНЕНИЕ';
    let secondaryLabel = 'Все упражнения → финиш тренировки';
    if (nextExIdx !== -1) {
      const nextName = activeSession.exercises[nextExIdx].name;
      primaryLabel = `ЗАВЕРШИТЬ → УПР. #${nextExIdx + 1}`;
      secondaryLabel = nextName.length > 30 ? (nextName.slice(0, 28) + '…') : nextName;
    }
    pab.innerHTML = `
      <div class="live-pab-content">
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

  // ----- State 3: Recording -----
  const isWarmupMode = (activeSession.draftSet.category === 'Разминка');
  const warmupSetsDone = currentEx.completedSets.filter(s => s.category === 'Разминка').length;
  const currentWarmupStepNum = Math.min(warmupSetsDone + 1, Math.max(1, (currentEx.warmupSteps || []).length));

  let primaryLabel = '';
  let secondaryLabel = '';

  if (isWarmupMode) {
    primaryLabel = `ЗАПИСАТЬ РАЗМИНКУ #${currentWarmupStepNum}`;
    secondaryLabel = `${activeSession.draftSet.weight} кг × ${activeSession.draftSet.reps}`;
  } else {
    const currentWorkSetNum = workDone + 1;
    const isSpecial = activeSession.draftSet.useSpecialMethod && currentEx.plannedMethod && currentEx.plannedMethod !== 'Стандарт';
    const specialTag = isSpecial ? ' • ' + currentEx.plannedMethod.split(' ')[0].toUpperCase() : '';
    primaryLabel = `ЗАПИСАТЬ СЕТ #${currentWorkSetNum}${specialTag}`;
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

/* =========================================================
 * POINT-WISE UPDATES (без полного re-render)
 * ========================================================= */

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
 * NOTE CHIPS (equipment/technique)
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

  // V2.0: авто-свёртка header после ПЕРВОГО сета (если пользователь не разворачивал вручную)
  if (!activeSession.headerManuallyToggled && currentEx.completedSets.length === 1) {
    activeSession.headerCollapsed = true;
  }

  // V2.0: авто-свёртка группы разминки при первом рабочем сете
  if (recordedSet.category === 'Рабочий' && !activeSession.historyUiState.warmupCollapsed) {
    const warmupCount = currentEx.completedSets.filter(s => s.category === 'Разминка').length;
    if (warmupCount > 0) {
      activeSession.historyUiState.warmupCollapsed = true;
    }
  }

  triggerHaptic([80]);

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
  if (restTimerInterval) {
    clearInterval(restTimerInterval);
    restTimerInterval = null;
  }
  persistActiveSession();
  renderPAB();
  renderClusterFloatBtn();
}

function syncRestTimerWithWallClock() {
  if (!activeSession) return;

  // Ensure PAB shows rest state
  if (!activeSession.restState || !activeSession.restState.isActive) {
    if (restTimerInterval) {
      clearInterval(restTimerInterval);
      restTimerInterval = null;
    }
    return;
  }

  if (!document.getElementById('livePabRestCountdown')) {
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
    const pab = document.getElementById('liveBottomActionBar');

    if (countdownEl) countdownEl.innerText = `${m}:${s}`;

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

  // V2.0: сброс UI-состояния на новом упражнении
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
  if (prevBtn) prevBtn.onclick = () => {
    if (activeSession) switchActiveExercise(activeSession.currentExerciseIndex - 1);
  };
  if (nextBtn) nextBtn.onclick = () => {
    if (activeSession) switchActiveExercise(activeSession.currentExerciseIndex + 1);
  };

  // Collapsible header
  const headerCompact = document.getElementById('liveExHeaderCompact');
  if (headerCompact) {
    headerCompact.onclick = () => toggleHeaderCollapse(false);
    headerCompact.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleHeaderCollapse(false);
      }
    });
  }
  const headerCollapseBtn = document.getElementById('liveExHeaderCollapseBtn');
  if (headerCollapseBtn) {
    headerCollapseBtn.onclick = (e) => {
      e.stopPropagation();
      toggleHeaderCollapse(true);
    };
  }

  // History group headers
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

  // Note chips
  const equipChip = document.getElementById('liveEquipmentChip');
  const techChip = document.getElementById('liveTechniqueChip');
  if (equipChip) equipChip.onclick = () => openNotesSheet();
  if (techChip) techChip.onclick = () => openNotesSheet();

  const notesSaveBtn = document.getElementById('liveNotesSaveBtn');
  const notesCancelBtn = document.getElementById('liveNotesCancelBtn');
  if (notesSaveBtn) notesSaveBtn.onclick = () => saveNotesSheet();
  if (notesCancelBtn) notesCancelBtn.onclick = () => closeModal('liveNotesSheet');

  // Enter в «Оборудование» → фокус на «Технику» (без newline).
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

  // Category toggles
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

  // Method toggle
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

  // Bonus set button
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

  // Weight steppers — ТОЧЕЧНЫЕ апдейты
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

  // Reps steppers — ТОЧЕЧНЫЕ апдейты
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

  // RIR chips — ТОЧЕЧНЫЕ апдейты (без скролл-прыжка)
  document.querySelectorAll('.live-rir-chip').forEach(chip => {
    chip.onclick = () => {
      if (!activeSession) return;
      activeSession.draftSet.rir = chip.getAttribute('data-rir') || '2';
      triggerHaptic(20);
      persistActiveSession();
      patchDraftSetDisplay();
    };
  });

  // Cluster pause floating button
  const clusterBtn = document.getElementById('liveClusterPauseBtn');
  if (clusterBtn) {
    clusterBtn.onclick = () => {
      const prefs = getTimerPrefs();
      triggerHaptic(50);
      startRestTimer(prefs.cluster);
    };
  }

  // Timer settings
  const openTimerPrefsBtn = document.getElementById('liveOpenTimerSettingsBtn');
  const saveTimerPrefsBtn = document.getElementById('saveLiveTimerSettingsBtn');

  if (openTimerPrefsBtn) {
    openTimerPrefsBtn.onclick = () => {
      const prefs = getTimerPrefs();
      const cEl = document.getElementById('prefTimerCompound');
      const iEl = document.getElementById('prefTimerIsolation');
      const clEl = document.getElementById('prefTimerCluster');
      if (cEl) cEl.value = prefs.compound;
      if (iEl) iEl.value = prefs.isolation;
      if (clEl) clEl.value = prefs.cluster;
      registerLiveModals();
      openModal('liveTimerSettingsModal');
    };
  }

  if (saveTimerPrefsBtn) {
    saveTimerPrefsBtn.onclick = () => {
      const cEl = document.getElementById('prefTimerCompound');
      const iEl = document.getElementById('prefTimerIsolation');
      const clEl = document.getElementById('prefTimerCluster');
      const newPrefs = {
        compound: Math.max(10, parseInt(cEl ? cEl.value : '150', 10) || 150),
        isolation: Math.max(10, parseInt(iEl ? iEl.value : '90', 10) || 90),
        cluster: Math.max(5, parseInt(clEl ? clEl.value : '20', 10) || 20),
        warmup: 60
      };
      saveTimerPrefs(newPrefs);
      closeModal('liveTimerSettingsModal');
      renderClusterFloatBtn();
    };
  }

  // Closeout modal chips
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
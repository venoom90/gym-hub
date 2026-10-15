import { state, normalizeDate, escapeHtml, computeE1RM } from './state.js';
import { askGasGeminiCoach, saveAiPlanToSheets } from './api.js';

let activeSplitView = 'A';
let cachedPlanData = null;
let isCoachInitialized = false;

export function renderCoachModule() {
  initSosCalculator();
  initCyclePlanner();
  loadCachedPlan();
}

/**
 * 1. SOS-АВТОРЕГУЛЯТОР У СТАНКА
 */
function initSosCalculator() {
  const selectEl = document.getElementById('coachSosExerciseSelect');
  const weightInput = document.getElementById('coachSosTargetWeight');
  const targetRepsInput = document.getElementById('coachSosTargetReps');
  const actualRepsInput = document.getElementById('coachSosActualReps');
  const calcBtn = document.getElementById('calculateSosBtn');
  const resultBox = document.getElementById('coachSosResultContainer');

  if (!selectEl || !calcBtn) return;

  const exercises = state.dbData.exercises || [];
  const currentSelected = selectEl.value;

  selectEl.innerHTML = '<option value="" disabled selected>Выберите текущее упражнение...</option>';
  exercises.forEach(ex => {
    const opt = document.createElement('option');
    opt.value = ex;
    opt.textContent = ex;
    if (ex === currentSelected) opt.selected = true;
    selectEl.appendChild(opt);
  });

  selectEl.onchange = () => {
    const chosen = selectEl.value;
    
    const workSets = (state.dbData.sets || [])
      .filter(s => 
        (s.exercise || '').trim() === chosen && 
        s.category === 'Рабочий' && 
        s.effort !== 'Размин.'
      )
      .sort((a, b) => {
        const da = normalizeDate(a.date);
        const db = normalizeDate(b.date);
        const tDiff = (da ? da.getTime() : 0) - (db ? db.getTime() : 0);
        if (tDiff !== 0) return tDiff;
        return (parseInt(a.setNum, 10) || 0) - (parseInt(b.setNum, 10) || 0);
      });

    if (workSets.length > 0) {
      const lastSet = workSets[workSets.length - 1];
      if (lastSet.weight && weightInput) weightInput.value = lastSet.weight;
      if (lastSet.reps && targetRepsInput && !targetRepsInput.value) targetRepsInput.value = lastSet.reps;
    }
  };

  calcBtn.onclick = () => {
    const weight = parseFloat(weightInput?.value) || 0;
    const targetReps = parseInt(targetRepsInput?.value, 10) || 0;
    const actualReps = parseInt(actualRepsInput?.value, 10) || 0;

    if (weight <= 0 || targetReps <= 0) {
      alert('Укажите корректный рабочий вес и целевые повторения.');
      return;
    }

    if (actualReps >= targetReps) {
      renderSosSuccess(resultBox, weight, targetReps);
      return;
    }

    calculateAutoregulationDecision(resultBox, weight, targetReps, actualReps);
  };
}

function calculateAutoregulationDecision(container, weight, targetReps, actualReps) {
  if (!container) return;

  const repDeficit = targetReps - actualReps;
  const isSevereFailure = (actualReps <= Math.floor(targetReps / 2));
  const roundToStep = (val) => Math.round(val / 2.5) * 2.5;

  const backoffWeight = roundToStep(weight * 0.85);
  const clusterRepsA = Math.max(1, actualReps);
  const clusterRepsB = Math.max(1, Math.floor(repDeficit / 2));
  const clusterRepsC = Math.max(1, repDeficit - clusterRepsB);

  container.style.display = 'block';
  container.innerHTML = `
    <div class="coach-sos-result-card">
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <b style="color: var(--app-color-warning); font-size: 0.95rem;">Решение авторегулятора (Отказ на ${actualReps} повт.)</b>
        <span class="coach-method-badge">Дефицит: -${repDeficit}</span>
      </div>

      <div style="font-size: 0.85rem; color: var(--md-sys-color-on-surface); line-height: 1.4; margin-top: 4px;">
        ${isSevereFailure
          ? `⚠️ <b>Системное утомление ЦНС/синергистов:</b> продолжать с текущим весом неэффективно.`
          : `⚡ <b>Локальный метаболический блок:</b> примените одну из стратегий адаптации.`}
      </div>

      <div style="background: var(--md-sys-color-surface-container-highest); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 6px; margin-top: 4px;">
        <span style="font-size: 0.8rem; font-weight: 700; color: var(--md-sys-color-primary);">ВАРИАНТ А (Сброс веса / Back-off):</span>
        <div style="font-size: 0.85rem;">
          Установите <b>${backoffWeight} кг</b> (-15%) и выполните <b>${targetReps} повторений</b> с подконтрольной негативной фазой.
        </div>
      </div>

      <div style="background: var(--md-sys-color-surface-container-highest); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 6px;">
        <span style="font-size: 0.8rem; font-weight: 700; color: var(--app-color-success);">ВАРИАНТ Б (Кластерная доработка на текущем весе):</span>
        <div style="font-size: 0.85rem;">
          Оставьте <b>${weight} кг</b> и выполните схему: 
          <b>${clusterRepsA} повт.</b> → отдых 20 сек → <b>${clusterRepsB} повт.</b> → отдых 20 сек → <b>${clusterRepsC} повт.</b>
        </div>
      </div>
    </div>
  `;
}

function renderSosSuccess(container, weight, reps) {
  container.style.display = 'block';
  container.innerHTML = `
    <div class="coach-sos-result-card" style="border-color: var(--app-color-success);">
      <b style="color: var(--app-color-success);">План перевыполнен!</b>
      <div style="font-size: 0.85rem; color: var(--md-sys-color-on-surface); margin-top: 4px;">
        Стимул максимален. В следующем сете сохраняйте <b>${weight} кг</b>. 
        На следующей тренировке запланируйте прогрессию <b>+2.5 кг</b> (${weight + 2.5} кг).
      </div>
    </div>
  `;
}

/**
 * 2. СТРАТЕГИЧЕСКИЙ ПЛАНИРОВЩИК МЕЗОЦИКЛА (AI COPILOT)
 */
function initCyclePlanner() {
  if (isCoachInitialized) return;

  const intentInput = document.getElementById('coachBlockIntent');
  const genBtn = document.getElementById('generateCyclePlanBtn');
  const splitTabA = document.getElementById('coachSplitTabA');
  const splitTabB = document.getElementById('coachSplitTabB');
  const syncCloudBtn = document.getElementById('syncCachedPlanToCloudBtn');

  if (intentInput) {
    const saved = localStorage.getItem('gym_ai_block_intent');
    if (saved) intentInput.value = saved;
    intentInput.addEventListener('input', () => {
      localStorage.setItem('gym_ai_block_intent', intentInput.value.trim());
    });
  }

  if (splitTabA && splitTabB) {
    splitTabA.onclick = () => {
      activeSplitView = 'A';
      splitTabA.classList.add('active');
      splitTabB.classList.remove('active');
      renderStructuredCards();
    };

    splitTabB.onclick = () => {
      activeSplitView = 'B';
      splitTabB.classList.add('active');
      splitTabA.classList.remove('active');
      renderStructuredCards();
    };
  }

  if (genBtn) {
    genBtn.onclick = () => generateMesocyclePlan();
  }

  if (syncCloudBtn) {
    syncCloudBtn.onclick = () => syncCachedPlanToSheets();
  }

  isCoachInitialized = true;
}

async function syncCachedPlanToSheets() {
  const syncCloudBtn = document.getElementById('syncCachedPlanToCloudBtn');
  if (!cachedPlanData || !cachedPlanData.splits) {
    alert('Нет сохраненного плана мезоцикла для отправки.');
    return;
  }

  if (syncCloudBtn) syncCloudBtn.disabled = true;

  try {
    const { _pendingCloudSync, ...cleanPlan } = cachedPlanData;
    const res = await saveAiPlanToSheets(cleanPlan);

    if (res && res.success) {
      cachedPlanData = cleanPlan;
      localStorage.setItem('gym_ai_coach_plan', JSON.stringify(cachedPlanData));
      renderStructuredCards();
      alert(`✅ Оба тренировочных дня (День А + День Б, всего ${res.savedRows || 14} упр.) успешно сохранены на лист AI_Plan в Google Таблице!`);
    } else {
      alert('Ошибка сохранения плана: ' + (res?.error || 'Неизвестная ошибка на сервере'));
    }
  } catch (err) {
    alert('Сбой при отправке плана: ' + err.message);
  } finally {
    if (syncCloudBtn) syncCloudBtn.disabled = false;
  }
}

async function generateMesocyclePlan() {
  const loadingBox = document.getElementById('coachPlanLoadingBox');
  const genBtn = document.getElementById('generateCyclePlanBtn');
  const intentInput = document.getElementById('coachBlockIntent');

  const userIntent = intentInput ? intentInput.value.trim() : '';

  const sets = state.dbData.sets || [];
  const exerciseStatsMap = {};

  sets.forEach(s => {
    const ex = (s.exercise || '').trim();
    if (!ex) return;
    const isWork = (s.category === 'Рабочий') && (s.effort !== 'Размин.');
    if (!isWork) return;

    const w = parseFloat(s.weight) || 0;
    const r = parseInt(s.reps, 10) || 0;
    const serverE1 = parseFloat(s.e1rm);

    if (!exerciseStatsMap[ex]) {
      exerciseStatsMap[ex] = { maxWeight: 0, max1
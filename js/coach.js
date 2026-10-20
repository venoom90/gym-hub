import {
  state, normalizeDate, escapeHtml, computeE1RM,
  MUSCLE_THRESHOLDS, MUSCLE_ADVICE, classifyMuscleState,
  rirWeight, isIsolationExercise, isDeloadSet, getExerciseMultiplier
} from './state.js';
import { askGasGeminiCoach, saveAiPlanToSheets } from './api.js';
import { showErrorToast, showSuccessToast, showWarningToast, openConfirmSheet } from './ui.js';

let activeSplitView = 'A';
let cachedPlanData = null;
let isCoachInitialized = false;

export function renderCoachModule() {
  initSosCalculator();
  initCyclePlanner();
  loadCachedPlan();
}

/* =========================================================
 * 1. SOS-АВТОРЕГУЛЯТОР У СТАНКА
 * ========================================================= */

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
      showErrorToast('Укажите корректный рабочий вес и целевые повторения');
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

/* =========================================================
 * 2. СТРАТЕГИЧЕСКИЙ ПЛАНИРОВЩИК МЕЗОЦИКЛА (AI COPILOT)
 * ========================================================= */

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

function syncCachedPlanToSheets() {
  if (!cachedPlanData || !cachedPlanData.splits) {
    showErrorToast('Нет сохраненного плана мезоцикла для отправки');
    return;
  }

  if (!cachedPlanData._pendingCloudSync) {
    openConfirmSheet({
      title: 'Перезаписать план?',
      message: 'План уже сохранён в AI_Plan. Отправить повторно (перезапишет лист)?',
      confirmLabel: 'Перезаписать',
      cancelLabel: 'Отмена',
      danger: true,
      onConfirm: () => executeSyncCachedPlan()
    });
    return;
  }

  executeSyncCachedPlan();
}

async function executeSyncCachedPlan() {
  if (!cachedPlanData || !cachedPlanData.splits) {
    showErrorToast('Нет сохраненного плана мезоцикла для отправки');
    return;
  }

  const syncCloudBtn = document.getElementById('syncCachedPlanToCloudBtn');
  if (syncCloudBtn) syncCloudBtn.disabled = true;

  try {
    const { _pendingCloudSync, ...cleanPlan } = cachedPlanData;
    const res = await saveAiPlanToSheets(cleanPlan);

    if (res && res.success) {
      cachedPlanData = cleanPlan;
      localStorage.setItem('gym_ai_coach_plan', JSON.stringify(cachedPlanData));
      renderStructuredCards();
      showSuccessToast(`План успешно сохранён на лист AI_Plan (Записано строк: ${res.savedRows})`);
    } else {
      showErrorToast('Ошибка сохранения плана: ' + (res?.error || 'Неизвестная ошибка на сервере'));
    }
  } catch (err) {
    showErrorToast('Сбой при отправке плана: ' + err.message);
  } finally {
    if (syncCloudBtn) syncCloudBtn.disabled = false;
  }
}

function detectNextCyclePhase() {
  const sets = state.dbData.sets || [];
  if (sets.length === 0) {
    return { nextWeek: 1, nextMode: 'Сила', nextWave: '1', nextSplit: 'А', cycleId: state.dbData.currentCycleId || 'C-1' };
  }

  const sorted = [...sets].sort((a, b) => {
    const da = normalizeDate(a.date);
    const db = normalizeDate(b.date);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  });

  const latest = sorted[0];
  const currentWeek = parseInt(latest.cycleWeek, 10) || 1;
  const currentSplit = (latest.splitDay || 'А').toUpperCase();
  const currentCycleId = latest.cycleId || state.dbData.currentCycleId || 'C-1';

  let nextWeek = currentWeek;
  let nextMode = latest.cycleMode || 'Сила';
  let nextWave = String(latest.waveIndex || '1');
  let nextSplit = (currentSplit === 'А' || currentSplit === 'A') ? 'Б' : 'А';
  let cycleId = currentCycleId;

  if (nextSplit === 'А') {
    nextWeek += 1;
    if (nextWeek === 2) { nextMode = 'Объем'; nextWave = '1'; }
    else if (nextWeek === 3) { nextMode = 'Сила'; nextWave = '2'; }
    else if (nextWeek === 4) { nextMode = 'Объем'; nextWave = '2'; }
    else if (nextWeek >= 5) { nextMode = 'Делоад'; nextWave = 'Делоад'; nextWeek = 5; }
  }

  return { nextWeek, nextMode, nextWave, nextSplit, cycleId };
}

function buildAthleteSituationPromptBlock() {
  const allSets = (state.dbData.sets || []).filter(s =>
    s.category === 'Рабочий' &&
    s.effort !== 'Размин.' &&
    !isDeloadSet(s.cycleWeek, s.cycleMode)
  );
  if (allSets.length === 0) return '';

  const cycleId = state.dbData.currentCycleId || 'C-1';

  const cycleSets = allSets.filter(s => (s.cycleId || 'C-1') === cycleId);
  if (cycleSets.length === 0) return '';

  const weekBuckets = new Set();
  cycleSets.forEach(s => {
    const d = normalizeDate(s.date);
    if (d) weekBuckets.add(Math.floor((d.getTime() + 3 * 86400000) / (7 * 86400000)));
  });
  const activeWeeks = Math.max(1, weekBuckets.size);

  const catalogMap = {};
  (state.dbData.catalog || []).forEach(c => {
    if (c && c.name) catalogMap[c.name.trim()] = c;
  });

  const volume = {};
  cycleSets.forEach(s => {
    const cat = catalogMap[(s.exercise || '').trim()];
    if (!cat || cat.status === 'Требует разметки') return;

    const coef = rirWeight(s.reserve, isIsolationExercise(s.exercise));
    if (coef <= 0) return;

    const targets = [
      { m: cat.primaryMuscle, r: parseFloat(cat.primaryRatio) || 1.0 },
      { m: cat.secondaryMuscle, r: parseFloat(cat.secondaryRatio) || 0.5 },
      { m: cat.tertiaryMuscle, r: parseFloat(cat.tertiaryRatio) || 0.25 }
    ];

    targets.forEach(t => {
      if (!t.m) return;
      volume[t.m] = (volume[t.m] || 0) + (t.r * coef);
    });
  });

  const lagging = [];
  Object.keys(MUSCLE_THRESHOLDS).forEach(m => {
    const th = MUSCLE_THRESHOLDS[m];
    if (th.isMaintenance) return;

    const weekly = parseFloat(((volume[m] || 0) / activeWeeks).toFixed(1));
    const cls = classifyMuscleState(weekly, th);

    if (cls.status === 'lagging') {
      const deficit = Math.max(1, Math.ceil(th.mev - weekly));
      const advice = MUSCLE_ADVICE[m] || 'изоляция';
      lagging.push(`- ${m}: ${weekly} сетов/нед (MEV ${th.mev}) → нужно +${deficit} подхода (${advice})`);
    }
  });

  const rirStats = cycleSets.reduce((acc, s) => {
    const clean = parseFloat(String(s.reserve || '').replace('+', ''));
    if (!isNaN(clean)) { acc.sum += clean; acc.count++; }
    return acc;
  }, { sum: 0, count: 0 });
  const avgRir = rirStats.count > 0
    ? parseFloat((rirStats.sum / rirStats.count).toFixed(1))
    : 2.0;

  const rirAdvice = avgRir <= 1.0
    ? 'Атлет работает близко к отказу — НЕ занижай RIR на объёме, оставляй 1-2.'
    : avgRir >= 2.5
      ? 'Атлет бережёт ЦНС — на объёме оставляй RIR 2-3, на силе 1-2.'
      : 'Работай в стандартном диапазоне RIR (сила 1-2, объём 2-3).';

  const laggingText = lagging.length === 0 ? 'Все мышцы в норме.' : lagging.join('\n');

  return `[ТЕКУЩАЯ СИТУАЦИЯ АТЛЕТА (ЛАГАЮЩИЕ МЫШЦЫ)]
${laggingText}

[СРЕДНИЙ RIR ЗА ЦИКЛ]
Средний RIR: ${avgRir}. ${rirAdvice}`;
}

function getFallbackWeight(muscleTarget, cycleMode) {
  const baseMap = {
    'Грудь': 80, 'Широчайшие': 80, 'Верх спины': 70,
    'Средняя дельта': 25, 'Передняя дельта': 30, 'Задняя дельта': 20,
    'Трицепс': 30, 'Бицепс': 30, 'Квадрицепс': 120,
    'Бицепс бедра': 80, 'Ягодичные': 100, 'Икры': 60, 'Кор': 40
  };
  const base = baseMap[String(muscleTarget || '').trim()] || 40;
  let coef = 0.85;
  if (cycleMode === 'Объём' || cycleMode === 'Объем') coef = 0.65;
  else if (cycleMode === 'Делоад') coef = 0.5;
  return Math.round((base * coef) / 2.5) * 2.5;
}

function extractAndValidatePlan(rawAnswer) {
  if (!rawAnswer || typeof rawAnswer !== 'string') {
    throw new Error('Модель вернула пустой ответ');
  }
  const jsonMatch = rawAnswer.match(/\{[\s\S]*\}/);
  if (!jsonMatch) {
    throw new Error('Модель не вернула валидную JSON-структуру (нет фигурных скобок)');
  }

  let parsed;
  try {
    parsed = JSON.parse(jsonMatch[0]);
  } catch (e) {
    throw new Error('Невалидный JSON: ' + e.message);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('JSON не является объектом');
  }
  if (!parsed.cycleId || typeof parsed.cycleId !== 'string') {
    throw new Error('Отсутствует или невалидный cycleId');
  }
  if (!parsed.splits || typeof parsed.splits !== 'object') {
    throw new Error('Отсутствует splits');
  }

  ['A', 'B'].forEach(function (key) {
    const split = parsed.splits[key];
    if (!split) throw new Error('Отсутствует splits.' + key);
    if (!split.title || typeof split.title !== 'string') {
      throw new Error('Отсутствует splits.' + key + '.title');
    }
    if (!Array.isArray(split.exercises) || split.exercises.length < 5) {
      const got = split.exercises ? split.exercises.length : 0;
      throw new Error('splits.' + key + '.exercises должен содержать минимум 5 упражнений (получено ' + got + ')');
    }
    split.exercises.forEach(function (ex, i) {
      if (!ex || typeof ex !== 'object') {
        throw new Error('splits.' + key + '.exercises[' + i + '] не является объектом');
      }
      if (!ex.name || typeof ex.name !== 'string') {
        throw new Error('splits.' + key + '.exercises[' + i + '].name отсутствует');
      }
      if (typeof ex.weight !== 'number' || !isFinite(ex.weight) || ex.weight <= 0) {
        throw new Error('splits.' + key + '.exercises[' + i + '].weight невалидный (должен быть > 0)');
      }
      if (typeof ex.sets !== 'number' || !isFinite(ex.sets) || ex.sets < 1 || ex.sets > 10) {
        throw new Error('splits.' + key + '.exercises[' + i + '].sets невалидный (1..10)');
      }
      if (!ex.reps || typeof ex.reps !== 'string') {
        throw new Error('splits.' + key + '.exercises[' + i + '].reps невалидный (строка)');
      }
    });
  });

  return parsed;
}

function buildPromptWithAttempt(basePrompt, attempt) {
  if (attempt <= 1) return basePrompt;
  return basePrompt + `\n\n[ПОВТОРНАЯ ПОПЫТКА №${attempt} — КРИТИЧЕСКОЕ ТРЕБОВАНИЕ]
Предыдущий ответ не прошёл валидацию схемы. Верни СТРОГО валидный JSON БЕЗ Markdown-тегов и внешнего текста.
Все поля обязательны:
- cycleId (строка), splits.A.title (строка), splits.B.title (строка);
- splits.A.exercises и splits.B.exercises — массивы МИНИМУМ из 5 упражнений каждый;
- у каждого упражнения: name (строка), weight (число > 0), sets (число 1..10), reps (строка).
НЕ добавляй комментарии, НЕ оборачивай в \`\`\`json. Только чистый JSON.`;
}

async function generateMesocyclePlan() {
  const loadingBox = document.getElementById('coachPlanLoadingBox');
  const genBtn = document.getElementById('generateCyclePlanBtn');
  const intentInput = document.getElementById('coachBlockIntent');

  const userIntent = intentInput ? intentInput.value.trim() : '';
  const phase = detectNextCyclePhase();

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
      exerciseStatsMap[ex] = { maxWeight: 0, max1RM: 0, split: (s.splitDay || s.split || '').toUpperCase() };
    }
    if (w > exerciseStatsMap[ex].maxWeight) {
      exerciseStatsMap[ex].maxWeight = w;
    }

    const validE1 = (!isNaN(serverE1) && serverE1 > 0) ? serverE1 : computeE1RM(w, r);
    if (validE1 > exerciseStatsMap[ex].max1RM) {
      exerciseStatsMap[ex].max1RM = parseFloat(validE1.toFixed(1));
    }
  });

  const dayAExercises = [];
  const dayBExercises = [];

  Object.keys(exerciseStatsMap).forEach(ex => {
    const item = exerciseStatsMap[ex];
    const mult = getExerciseMultiplier(ex);

    const displayMaxWeight = parseFloat((item.maxWeight / mult).toFixed(1));
    const displayMax1RM = parseFloat((item.max1RM / mult).toFixed(1));
    const line = `${ex}: рабочий вес ${displayMaxWeight} кг (1ПМ ${displayMax1RM} кг)`;

    if (item.split === 'Б' || item.split === 'B') {
      dayBExercises.push(line);
    } else {
      dayAExercises.push(line);
    }
  });

  const dayAFormatted = dayAExercises.length > 0 ? dayAExercises.map((ex, i) => `${i+1}. ${ex}`).join('\n') : 'Нет данных';
  const dayBFormatted = dayBExercises.length > 0 ? dayBExercises.map((ex, i) => `${i+1}. ${ex}`).join('\n') : 'Нет данных';
  const athleteSituation = buildAthleteSituationPromptBlock();

  const catalog = state.dbData.catalog || [];
  const catalogList = catalog
    .filter(c => c.status !== 'Требует разметки' && c.name)
    .map(c => `- ${c.name} [Целевая: ${c.primaryMuscle || '—'}]`)
    .join('\n');

  const prompt = `Ты — ведущий эксперт силовой подготовки и DUP-периодизации (Mike Israetel, Eric Helms).
Составь тренировочный план на Неделю ${phase.nextWeek} (Режим: ${phase.nextMode}) мезоцикла ${phase.cycleId}.

[ТВОЯ ЗАДАЧА]
Перераспределить нагрузку, убрать дублирование рук и грамотно распределить упражнения на лагающие мышцы по разным дням, строго соблюдая правила.

[ПРИОРИТЕТ 1: ПРЯМЫЕ УКАЗАНИЯ АТЛЕТА (АБСОЛЮТНЫЙ ЗАКОН)]
${userIntent || 'Нет специфических указаний, следуй фазе цикла и аналитике.'}
Если в этом блоке запрошены конкретные упражнения, методы, подходы или веса — они ОБЯЗАТЕЛЬНЫ к исполнению.

[ТЕКУЩИЙ АРХИВ (Что атлет делал на Неделе 1)]
День А:
${dayAFormatted}

День Б:
${dayBFormatted}

[ПРИОРИТЕТ 2: ТЕКУЩАЯ СИТУАЦИЯ АТЛЕТА (ЛАГАЮЩИЕ МЫШЦЫ)]
${athleteSituation}

[ДОСТУПНЫЙ КАТАЛОГ УПРАЖНЕНИЙ (ВЫБИРАЙ СТРОГО ИЗ НЕГО)]
${catalogList || 'Нет размеченных упражнений в каталоге.'}

[ПРИОРИТЕТ 3: ЦЕЛЕВАЯ ФАЗА ЦИКЛА]
Сгенерируй план СТРОГО на Неделю ${phase.nextWeek} (Режим: ${phase.nextMode}).
- Если Объем: 12-16 повторов, RIR 2-3. ВЕС: 75-80% от указанного рабочего веса силовой недели (это 65-70% от 1ПМ!). Не занижай вес!
- Если Сила: 4-6 повторов, RIR 1-2. ВЕС: 100% от указанного рабочего веса.

[СТРОГИЕ ПРАВИЛА]
1. НОГИ: КАТЕГОРИЧЕСКИЙ ЗАПРЕТ на добавление любых новых упражнений на ноги. ЗАПРЕЩЕНЫ сгибания ног, разгибания ног, становая тяга, выпады. Из упражнений на ноги разрешено использовать СТРОГО ТОЛЬКО жим ногами и подъемы на носки.
2. РУКИ: Убери дублирование. Оставь изоляцию на Бицепс только в одном дне (например, в А), а изоляцию на Трицепс — только в другом (например, в Б).
3. РАСПРЕДЕЛЕНИЕ ЛАГАЮЩИХ МЫШЦ: Не ставь два упражнения на одну мышцу в ОДИН день. Так как средняя дельта сильно отстает, используй два разных упражнения за неделю: в День А поставь "Разведение в тренажере плечи" (3-4 подхода, без дропа), а в День Б добавь из каталога "Отведение руки в сторону на нижнем блоке" (4 подхода).
4. ДРОП-СЕТЫ НА ЛАГАХ: Для отстающих мышц (Средняя дельта, Задняя дельта, Икры, Трицепс) в финальном подходе обязательно используй метод "Дроп-сет -25%" и RIR 0.
5. ВЕСА: Строго кратны 2.5 кг.
6. Для КАЖДОГО упражнения напиши краткое обоснование (justification).

ФОРМАТ ОТВЕТА:
Верни СТРОГО валидный компактный JSON БЕЗ какого-либо внешнего текста или Markdown-тегов:
{
  "cycleId": "${phase.cycleId}",
  "cycleWeek": ${phase.nextWeek},
  "cycleMode": "${phase.nextMode}",
  "splits": {
    "A": {
      "title": "Тренировка А${phase.nextWave} (${phase.nextMode})",
      "exercises": [
        {
          "order": 1,
          "name": "Название",
          "target": "Мышца",
          "weight": 100,
          "sets": 4,
          "reps": "12-16",
          "rir": "+2..+3",
          "method": "Стандарт",
          "notes": "",
          "justification": "Почему это упражнение здесь и зачем столько подходов."
        }
      ]
    },
    "B": {
      "title": "Тренировка Б${phase.nextWave} (${phase.nextMode})",
      "exercises": []
    }
  },
  "rationale": "Общая стратегия: как распределили руки и закрыли лаги."
}`;

  let elapsedSeconds = 0;
  let timerInterval = null;

  if (loadingBox) {
    loadingBox.style.display = 'block';
    loadingBox.innerText = `🤖 Gemini генерирует программу мезоцикла... (0с)`;
    timerInterval = setInterval(() => {
      elapsedSeconds++;
      loadingBox.innerText = `🤖 Gemini генерирует программу мезоцикла... (${elapsedSeconds}с)`;
    }, 1000);
  }

  if (genBtn) genBtn.disabled = true;

  try {
    const MAX_ATTEMPTS = 2;
    let parsedPlan = null;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (attempt > 1 && loadingBox) {
        loadingBox.innerText = `🤖 Повторная попытка (${attempt}/${MAX_ATTEMPTS})...`;
      }
      try {
        const attemptPrompt = buildPromptWithAttempt(prompt, attempt);
        const rawAnswer = await askGasGeminiCoach(attemptPrompt);
        parsedPlan = extractAndValidatePlan(rawAnswer);
        break;
      } catch (err) {
        lastError = err;
        if (attempt === MAX_ATTEMPTS) {
          throw new Error(`${err.message} (после ${MAX_ATTEMPTS} попыток)`);
        }
      }
    }

    if (!parsedPlan) {
      throw new Error(lastError ? lastError.message : 'Не удалось получить валидный план после всех попыток');
    }

    ['A', 'B'].forEach(splitKey => {
      parsedPlan.splits[splitKey].exercises.forEach(ex => {
        const hist = exerciseStatsMap[ex.name];
        if (hist && hist.maxWeight > 0) {
          const mult = getExerciseMultiplier(ex.name);
          const displayMaxWeight = hist.maxWeight / mult;

          let maxAllowed = 0;
          if (phase.nextMode === 'Объем') {
            maxAllowed = displayMaxWeight * 0.82;
          } else if (phase.nextMode === 'Сила') {
            maxAllowed = displayMaxWeight * 1.05;
          } else if (phase.nextMode === 'Делоад') {
            maxAllowed = displayMaxWeight * 0.65;
          }

          if (ex.weight > maxAllowed && maxAllowed > 0) {
            ex.weight = Math.round(maxAllowed / 2.5) * 2.5;
            ex.notes = (ex.notes || '') + ' (Вес скорректирован физиологическим лимитом)';
          }
        } else {
          const fallbackCap = getFallbackWeight(ex.target, phase.nextMode);
          if (fallbackCap > 0 && ex.weight > fallbackCap * 3) {
            ex.weight = fallbackCap;
            ex.notes = (ex.notes || '') + ' (Защита от галлюцинации: fallback веса по мышечной группе)';
          }
        }
      });
    });

    const effectivePlan = convertPlanToEffective(parsedPlan);

    effectivePlan.cycleId = phase.cycleId;
    effectivePlan.cycleWeek = phase.nextWeek;
    effectivePlan.cycleMode = phase.nextMode;
    effectivePlan.generatedAt = Date.now();
    delete effectivePlan._pendingCloudSync;

    cachedPlanData = effectivePlan;
    localStorage.setItem('gym_ai_coach_plan', JSON.stringify(cachedPlanData));

    try {
      renderStructuredCards();
    } catch (renderErr) {
      console.error('[Coach] Ошибка отрисовки карточек:', renderErr);
    }

    if (loadingBox) {
      loadingBox.innerText = `☁️ Сохранение плана на лист AI_Plan...`;
    }

    const saveResult = await saveAiPlanToSheets(effectivePlan);

    if (!saveResult || !saveResult.success) {
      cachedPlanData._pendingCloudSync = true;
      localStorage.setItem('gym_ai_coach_plan', JSON.stringify(cachedPlanData));
      try { renderStructuredCards(); } catch(e) {}
      showWarningToast('План сохранён в памяти телефона, но сервер временно не смог записать его в таблицу. Нажмите «Отправить несохраненный план в таблицу» чуть позже.');
    }
  } catch (err) {
    showErrorToast(`Ошибка генерации плана: ${err.message}`);
  } finally {
    if (timerInterval) clearInterval(timerInterval);
    if (loadingBox) loadingBox.style.display = 'none';
    if (genBtn) genBtn.disabled = false;
  }
}

function convertPlanToEffective(plan) {
  const clone = JSON.parse(JSON.stringify(plan));
  ['A', 'B'].forEach(splitKey => {
    if (clone.splits && clone.splits[splitKey] && clone.splits[splitKey].exercises) {
      clone.splits[splitKey].exercises.forEach(ex => {
        const mult = getExerciseMultiplier(ex.name);
        if (ex.weight) {
          ex.weight = parseFloat((parseFloat(ex.weight) * mult).toFixed(1));
        }
      });
    }
  });
  return clone;
}

function loadCachedPlan() {
  try {
    const saved = localStorage.getItem('gym_ai_coach_plan');
    if (saved) {
      cachedPlanData = JSON.parse(saved);
      renderStructuredCards();
    } else if (state.dbData.aiPlan && state.dbData.aiPlan.splits) {
      cachedPlanData = state.dbData.aiPlan;
      localStorage.setItem('gym_ai_coach_plan', JSON.stringify(cachedPlanData));
      renderStructuredCards();
    }
  } catch (e) {
    console.warn('[Coach] Ошибка восстановления сохраненного плана:', e);
  }
}

function renderStructuredCards() {
  const container = document.getElementById('coachSplitCardsContainer');
  const rationaleBox = document.getElementById('coachRationaleDetails');
  const rationaleText = document.getElementById('coachRationaleText');
  const syncCloudBtn = document.getElementById('syncCachedPlanToCloudBtn');
  const badgeEl = document.getElementById('coachPlanCycleBadge');
  const splitTabA = document.getElementById('coachSplitTabA');
  const splitTabB = document.getElementById('coachSplitTabB');
  const splitTitleEl = document.getElementById('coachActiveSplitTitle');

  if (!container || !cachedPlanData) return;

  if (badgeEl && cachedPlanData.cycleId) {
    badgeEl.innerText = cachedPlanData.cycleId;
  }

  if (splitTabA && cachedPlanData.splits && cachedPlanData.splits.A) {
    const rawTitleA = cachedPlanData.splits.A.title || 'Тренировка А1';
    const waveTagA = (rawTitleA.match(/[АA]\d+/i) || ['А1'])[0];
    const modeSubA = rawTitleA.includes('Объем') ? 'Объем' : (rawTitleA.includes('Делоад') ? 'Делоад' : 'Сила');

    splitTabA.innerHTML = `
      <span style="font-size: 0.92rem; font-weight: 700;">День А</span>
      <span style="font-size: 0.72rem; opacity: 0.85; font-weight: 500;">${escapeHtml(waveTagA)} • ${escapeHtml(modeSubA)}</span>
    `;
  }

  if (splitTabB && cachedPlanData.splits && cachedPlanData.splits.B) {
    const rawTitleB = cachedPlanData.splits.B.title || 'Тренировка Б1';
    const waveTagB = (rawTitleB.match(/[БB]\d+/i) || ['Б1'])[0];
    const modeSubB = rawTitleB.includes('Объем') ? 'Объем' : (rawTitleB.includes('Делоад') ? 'Делоад' : 'Сила');

    splitTabB.innerHTML = `
      <span style="font-size: 0.92rem; font-weight: 700;">День Б</span>
      <span style="font-size: 0.72rem; opacity: 0.85; font-weight: 500;">${escapeHtml(waveTagB)} • ${escapeHtml(modeSubB)}</span>
    `;
  }

  const currentSplit = cachedPlanData.splits ? cachedPlanData.splits[activeSplitView] : null;

  if (splitTitleEl) {
    if (currentSplit && currentSplit.title) {
      splitTitleEl.style.display = 'block';
      splitTitleEl.innerText = currentSplit.title;
    } else {
      splitTitleEl.style.display = 'none';
    }
  }

  if (!currentSplit || !Array.isArray(currentSplit.exercises) || currentSplit.exercises.length === 0) {
    container.innerHTML = `<div style="font-size: 0.85rem; color: #94a3b8; text-align: center; padding: 12px 0;">Нет упражнений для Дня ${escapeHtml(activeSplitView)}</div>`;
    return;
  }

  container.innerHTML = '';

  currentSplit.exercises.forEach(ex => {
    if (!ex || typeof ex !== 'object') return;

    try {
      const mult = getExerciseMultiplier(ex.name);
      const displayWeight = parseFloat(((parseFloat(ex.weight) || 0) / mult).toFixed(1));
      const multBadge = mult === 2 ? ' (×2)' : '';

      const card = document.createElement('div');
      card.className = 'coach-exercise-card';
      card.innerHTML = `
        <div class="coach-card-header">
          <div>
            <span style="font-size: 0.72rem; color: var(--md-sys-color-primary); font-weight: 700;">#${parseInt(ex.order, 10) || 1} • ${escapeHtml(ex.target || 'База')}</span>
            <div class="coach-exercise-title">${escapeHtml(ex.name || 'Упражнение')}</div>
          </div>
          <span class="coach-weight-tag">${displayWeight} кг${multBadge}</span>
        </div>
        <div class="coach-card-chips">
          <span class="coach-card-chip">${parseInt(ex.sets, 10) || 3} подх.</span>
          <span class="coach-card-chip">${escapeHtml(ex.reps || '6')} повт.</span>
          <span class="coach-card-chip" style="color: var(--md-sys-color-primary);">RIR ${escapeHtml(ex.rir || '1-2')}</span>
          <span class="coach-method-badge">${escapeHtml(ex.method || 'Стандарт')}</span>
        </div>
        ${ex.notes ? `<div style="font-size: 0.75rem; color: var(--md-sys-color-on-surface-variant); line-height: 1.3;">📌 ${escapeHtml(ex.notes)}</div>` : ''}
      `;
      container.appendChild(card);
    } catch (e) {
      console.warn('[Coach] Ошибка при отрисовке карточки упражнения:', ex, e);
    }
  });

  if (rationaleBox && rationaleText) {
    let justHtml = '';
    currentSplit.exercises.forEach(ex => {
      if (ex.justification) {
        justHtml += `<div style="margin-bottom: 8px;"><b>#${ex.order} ${escapeHtml(ex.name)}:</b> ${escapeHtml(ex.justification)}</div>`;
      }
    });

    if (cachedPlanData.rationale) {
      justHtml += `<div style="margin-top:12px; padding-top:12px; border-top:1px solid var(--md-sys-color-outline-variant);"><b>Общая стратегия:</b><br>${escapeHtml(cachedPlanData.rationale)}</div>`;
    }

    if (justHtml) {
      rationaleBox.style.display = 'block';
      rationaleText.innerHTML = justHtml;
    } else {
      rationaleBox.style.display = 'none';
    }
  }

  if (syncCloudBtn) {
    syncCloudBtn.style.display = 'inline-flex';
    if (cachedPlanData._pendingCloudSync) {
      syncCloudBtn.innerHTML = `
        <span class="material-symbols-outlined" slot="icon">sync_problem</span>
        ⚠️ Отправить несохраненный план в таблицу
      `;
    } else {
      syncCloudBtn.innerHTML = `
        <span class="material-symbols-outlined" slot="icon">cloud_upload</span>
        Отправить план (День А + День Б) в таблицу
      `;
    }
  }
}
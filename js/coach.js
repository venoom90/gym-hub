import {
  state, normalizeDate, escapeHtml, computeE1RM,
  MUSCLE_THRESHOLDS, MUSCLE_ADVICE, classifyMuscleState,
  rirWeight, isIsolationExercise, isDeloadSet
} from './state.js';
import { askGasGeminiCoach, saveAiPlanToSheets } from './api.js';

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
      alert(`✅ План успешно сохранен на лист AI_Plan! (Записано строк: ${res.savedRows})`);
    } else {
      alert('Ошибка сохранения плана: ' + (res?.error || 'Неизвестная ошибка на сервере'));
    }
  } catch (err) {
    alert('Сбой при отправке плана: ' + err.message);
  } finally {
    if (syncCloudBtn) syncCloudBtn.disabled = false;
  }
}

/**
 * V5.3.0: Определяет следующую фазу цикла на основе последних тренировок.
 */
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

  // Если последняя тренировка была День Б, переходим на новую неделю
  if (nextSplit === 'А') {
    nextWeek += 1;
    if (nextWeek === 2) { nextMode = 'Объем'; nextWave = '1'; }
    else if (nextWeek === 3) { nextMode = 'Сила'; nextWave = '2'; }
    else if (nextWeek === 4) { nextMode = 'Объем'; nextWave = '2'; }
    else if (nextWeek >= 5) { nextMode = 'Делоад'; nextWave = 'Делоад'; nextWeek = 5; }
  }

  return { nextWeek, nextMode, nextWave, nextSplit, cycleId };
}

/**
 * V5.3.0: Формирует текстовый блок [ТЕКУЩАЯ СИТУАЦИЯ АТЛЕТА] для промпта Gemini.
 */
function buildAthleteSituationPromptBlock() {
  const allSets = (state.dbData.sets || []).filter(s =>
    s.category === 'Рабочий' &&
    s.effort !== 'Размин.' &&
    !isDeloadSet(s.cycleWeek, s.cycleMode)
  );
  if (allSets.length === 0) return '';

  const cycleId = state.selectedCycleId !== 'ALL'
    ? state.selectedCycleId
    : (state.dbData.currentCycleId || 'C-1');

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
      lagging.push(`- ${m}: ${weekly} сетов/нед (MEV ${th.mev}) → добавь минимум +${deficit} подхода (${advice})`);
    }
  });

  if (lagging.length === 0) return '';

  return `[ТЕКУЩАЯ СИТУАЦИЯ АТЛЕТА (по данным за ${activeWeeks} активных недель цикла ${cycleId})]:
${lagging.join('\n')}`;
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

    const validE1 = (!isNaN(serverE1) && serverE1 > 0)
      ? serverE1
      : computeE1RM(w, r);

    if (validE1 > exerciseStatsMap[ex].max1RM) {
      exerciseStatsMap[ex].max1RM = parseFloat(validE1.toFixed(1));
    }
  });

  const dayAExercises = [];
  const dayBExercises = [];

  Object.keys(exerciseStatsMap).forEach(ex => {
    const item = exerciseStatsMap[ex];
    const e1rmStr = item.max1RM > 0 ? `, 1ПМ ${item.max1RM} кг` : '';
    const line = `- ${ex}: макс. рабочий вес ${item.maxWeight} кг${e1rmStr}`;
    if (item.split === 'Б' || item.split === 'B') {
      dayBExercises.push(line);
    } else {
      dayAExercises.push(line);
    }
  });

  const exSummaryA = dayAExercises.join('\n') || 'Нет данных';
  const exSummaryB = dayBExercises.join('\n') || 'Нет данных';
  const athleteSituation = buildAthleteSituationPromptBlock();

  // V5.9.3: Передаем каталог упражнений для предотвращения галлюцинаций
  const catalog = state.dbData.catalog || [];
  const catalogList = catalog
    .filter(c => c.status !== 'Требует разметки' && c.name)
    .map(c => `- ${c.name} [Целевая: ${c.primaryMuscle || '—'}]`)
    .join('\n');

  const prompt = `Ты — ведущий эксперт силовой подготовки и DUP-периодизации (Mike Israetel, Eric Helms).
Составь тренировочный план на мезоцикл ${phase.cycleId}.

[ПРИОРИТЕТ 1: ПРЯМЫЕ УКАЗАНИЯ АТЛЕТА (АБСОЛЮТНЫЙ ЗАКОН)]
${userIntent || 'Нет специфических указаний, следуй фазе цикла и аналитике.'}
Если в этом блоке запрошены конкретные упражнения, методы, подходы или веса — они ОБЯЗАТЕЛЬНЫ к исполнению, даже если противоречат фазе или аналитике ниже.

[ПРИОРИТЕТ 2: ТЕКУЩАЯ СИТУАЦИЯ АТЛЕТА (ЛАГАЮЩИЕ МЫШЦЫ)]
${athleteSituation ? athleteSituation + '\nЭти мышцы нужно добрать до MEV. Если атлет не запретил в Приоритете 1, добавь им объем.' : 'Все мышцы в норме.'}

[ПРИОРИТЕТ 3: ЦЕЛЕВАЯ ФАЗА ЦИКЛА]
Сгенерируй план СТРОГО на Неделю ${phase.nextWeek} (Режим: ${phase.nextMode}).
- Если Объем: 12-16 повторов, RIR 2-3, вес ~75% от силового.
- Если Сила: 4-6 повторов, RIR 1-2, вес ~100% от силового.

[АРХИВ УПРАЖНЕНИЙ АТЛЕТА В ДНЕ А]:
${exSummaryA}

[АРХИВ УПРАЖНЕНИЙ АТЛЕТА В ДНЕ Б]:
${exSummaryB}

[ДОСТУПНЫЙ КАТАЛОГ УПРАЖНЕНИЙ (ВЫБИРАЙ ТОЛЬКО ИЗ НЕГО)]:
${catalogList || 'Нет размеченных упражнений в каталоге.'}

ПРАВИЛА И ПРИОРИТЕТЫ:
1. В каждом дне должно быть по 6-8 упражнений. НЕ ОСТАВЛЯЙ День Б пустым.
2. ЗАПРЕЩЕНО выдумывать упражнения. Выбирай упражнения СТРОГО из [АРХИВА] или из [ДОСТУПНОГО КАТАЛОГА] выше. Если добавляешь упражнение для закрытия лага — оно должно быть в каталоге.
3. Ты можешь менять порядок упражнений для оптимальной биомеханики (компаунды в начале, изоляция и ноги в конце).
4. Для лагающих мышц (Средняя дельта, Задняя дельта, Икры, Трицепс) на объемной неделе делай по 5 подходов, последний — RIR 0 с дроп-сетом.
5. Ноги (жим ногами, сгибания/разгибания) ставятся СТРОГО В КОНЦЕ СЕССИИ в режиме Maintenance (2–3 сета).
6. Все веса СТРОГО кратны шагу 2.5 кг.
7. Для КАЖДОГО упражнения напиши краткое обоснование (justification): почему именно это упражнение, почему столько подходов и почему такой метод.

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
          "name": "Точное название из архива или каталога",
          "target": "Грудь",
          "weight": 100,
          "sets": 4,
          "reps": "12-16",
          "rir": "+2..+3",
          "method": "Стандарт",
          "notes": "",
          "justification": "Базовое движение на грудь, выполняется первым на свежую ЦНС. 4 подхода для закрытия MEV."
        }
      ]
    },
    "B": {
      "title": "Тренировка Б${phase.nextWave} (${phase.nextMode})",
      "exercises": []
    }
  },
  "rationale": "Краткое обоснование учета пожеланий атлета, порядка упражнений и выбора фаз."
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
    const rawAnswer = await askGasGeminiCoach(prompt);
    const jsonMatch = rawAnswer.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Модель не вернула валидную JSON-структуру.');

    const parsedPlan = JSON.parse(jsonMatch[0]);
    
    // Строгая валидация
    if (!parsedPlan.splits || !parsedPlan.splits.A || !parsedPlan.splits.A.exercises || parsedPlan.splits.A.exercises.length < 6) {
      throw new Error('ИИ сгенерировал неполный День А (менее 6 упражнений). Пожалуйста, нажмите «Рассчитать» еще раз.');
    }
    if (!parsedPlan.splits.B || !parsedPlan.splits.B.exercises || parsedPlan.splits.B.exercises.length < 6) {
      throw new Error('ИИ забыл сгенерировать День Б (менее 6 упражнений). Пожалуйста, нажмите «Рассчитать» еще раз.');
    }

    // Мягкая проверка на галлюцинации (упражнения не из каталога)
    const validExerciseNames = new Set(
      (state.dbData.exercises || []).map(e => e.trim().toLowerCase())
    );
    const hallucinated = [];
    ['A', 'B'].forEach(splitKey => {
      parsedPlan.splits[splitKey].exercises.forEach(ex => {
        const name = String(ex.name || '').trim().toLowerCase();
        if (name && !validExerciseNames.has(name)) {
          hallucinated.push(ex.name);
        }
      });
    });
    if (hallucinated.length > 0) {
      console.warn('[Coach] Внимание: ИИ добавил упражнения вне каталога:', hallucinated);
    }

    // Принудительно фиксируем фазу
    parsedPlan.cycleId = phase.cycleId;
    parsedPlan.cycleWeek = phase.nextWeek;
    parsedPlan.cycleMode = phase.nextMode;

    parsedPlan.generatedAt = Date.now();
    delete parsedPlan._pendingCloudSync;

    cachedPlanData = parsedPlan;
    localStorage.setItem('gym_ai_coach_plan', JSON.stringify(cachedPlanData));

    try {
      renderStructuredCards();
    } catch (renderErr) {
      console.error('[Coach] Ошибка отрисовки карточек:', renderErr);
    }

    if (loadingBox) {
      loadingBox.innerText = `☁️ Сохранение плана на лист AI_Plan...`;
    }

    const { _pendingCloudSync, ...cleanPlanToSend } = cachedPlanData;
    const saveResult = await saveAiPlanToSheets(cleanPlanToSend);

    if (!saveResult || !saveResult.success) {
      cachedPlanData._pendingCloudSync = true;
      localStorage.setItem('gym_ai_coach_plan', JSON.stringify(cachedPlanData));
      try { renderStructuredCards(); } catch(e) {}
      alert('⚠️ План сохранен в памяти телефона, но сервер временно не смог записать его в таблицу. Нажмите «Отправить несохраненный план в таблицу» чуть позже.');
    }
  } catch (err) {
    alert(`Ошибка генерации плана: ${err.message}`);
  } finally {
    if (timerInterval) clearInterval(timerInterval);
    if (loadingBox) loadingBox.style.display = 'none';
    if (genBtn) genBtn.disabled = false;
  }
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
      const card = document.createElement('div');
      card.className = 'coach-exercise-card';
      card.innerHTML = `
        <div class="coach-card-header">
          <div>
            <span style="font-size: 0.72rem; color: var(--md-sys-color-primary); font-weight: 700;">#${parseInt(ex.order, 10) || 1} • ${escapeHtml(ex.target || 'База')}</span>
            <div class="coach-exercise-title">${escapeHtml(ex.name || 'Упражнение')}</div>
          </div>
          <span class="coach-weight-tag">${parseFloat(ex.weight) || 0} кг</span>
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

  // V5.3.0: Отрисовка обоснований по каждому упражнению + общая стратегия
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
import { state, normalizeDate, escapeHtml } from './state.js';
import { askGasGeminiCoach } from './api.js';

let activeSplitView = 'A';
let cachedPlanData = null;
let isCoachInitialized = false;

export function renderCoachModule() {
  initSosCalculator();
  initCyclePlanner();
  loadCachedPlan();
}

/**
 * -------------------------------------------------------------
 * 1. SOS-АВТОРЕГУЛЯТОР У СТАНКА (РЕАЛЬНОЕ ВРЕМЯ)
 * -------------------------------------------------------------
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
        <b style="color: var(--md-sys-color-warning); font-size: 0.95rem;">Решение авторегулятора (Отказ на ${actualReps} повт.)</b>
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
        <span style="font-size: 0.8rem; font-weight: 700; color: var(--md-sys-color-success);">ВАРИАНТ Б (Кластерная доработка на текущем весе):</span>
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
    <div class="coach-sos-result-card" style="border-color: var(--md-sys-color-success);">
      <b style="color: var(--md-sys-color-success);">План перевыполнен!</b>
      <div style="font-size: 0.85rem; color: var(--md-sys-color-on-surface); margin-top: 4px;">
        Стимул максимален. В следующем сете сохраняйте <b>${weight} кг</b>. 
        На следующей тренировке запланируйте прогрессию <b>+2.5 кг</b> (${weight + 2.5} кг).
      </div>
    </div>
  `;
}

/**
 * -------------------------------------------------------------
 * 2. СТРАТЕГИЧЕСКИЙ ПЛАНИРОВЩИК МЕЗОЦИКЛА (AI COPILOT)
 * -------------------------------------------------------------
 */
function initCyclePlanner() {
  if (isCoachInitialized) return;

  const intentInput = document.getElementById('coachBlockIntent');
  const genBtn = document.getElementById('generateCyclePlanBtn');
  const splitTabA = document.getElementById('coachSplitTabA');
  const splitTabB = document.getElementById('coachSplitTabB');
  const copyBtn = document.getElementById('copyGymUpListBtn');

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

  if (copyBtn) {
    copyBtn.onclick = () => copyPlanToClipboard();
  }

  isCoachInitialized = true;
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
    const e1rm = parseFloat(s.e1rm) || (r === 1 ? w : w * (1 + r / 30));

    if (!exerciseStatsMap[ex]) {
      exerciseStatsMap[ex] = { maxWeight: 0, max1RM: 0, split: (s.splitDay || s.split || '').toUpperCase() };
    }
    if (w > exerciseStatsMap[ex].maxWeight) exerciseStatsMap[ex].maxWeight = w;
    if (e1rm > exerciseStatsMap[ex].max1RM) exerciseStatsMap[ex].max1RM = parseFloat(e1rm.toFixed(1));
  });

  const dayAExercises = [];
  const dayBExercises = [];

  Object.keys(exerciseStatsMap).forEach(ex => {
    const item = exerciseStatsMap[ex];
    const line = `- ${ex}: макс. ${item.maxWeight} кг, 1ПМ ${item.max1RM} кг`;
    if (item.split === 'Б' || item.split === 'B') {
      dayBExercises.push(line);
    } else {
      dayAExercises.push(line);
    }
  });

  const exSummaryA = dayAExercises.join('\n') || 'Нет данных';
  const exSummaryB = dayBExercises.join('\n') || 'Нет данных';

  const currentCid = state.dbData.currentCycleId || 'C-2';

  const prompt = `Ты — ведущий эксперт силовой подготовки и DUP-периодизации (Mike Israetel, Eric Helms).
Составь тренировочный план на мезоцикл ${currentCid}.

[ЦЕЛИ И ПРЯМЫЕ УКАЗАНИЯ АТЛЕТА]:
${userIntent || 'Full-Body, верх в приоритете, ноги в конце в поддержке (Maintenance), акцент на икры, паритет трицепса.'}

[АРХИВ УПРАЖНЕНИЙ АТЛЕТА В ДНЕ А]:
${exSummaryA}

[АРХИВ УПРАЖНЕНИЙ АТЛЕТА В ДНЕ Б]:
${exSummaryB}

ПРАВИЛА И ПРИОРИТЕТЫ:
1. ПРИОРИТЕТ УКАЗАНИЙ АТЛЕТА: Если в [ЦЕЛИ И ПРЯМЫЕ УКАЗАНИЯ АТЛЕТА] запрошены кластеры, дроп-сеты или специфические методы прямо со старта цикла — ОБЯЗАТЕЛЬНО внедрить их в план! В поле "method" указать точный метод ("Кластер 4+3+2", "Дроп-сет -25%" или "Стандарт").
2. ПОРЯДОК УПРАЖНЕНИЙ:
   - Базовый компаунд верха на свежую ЦНС (День А: жим груди + тяга; День Б: вертикальная тяга + бабочка).
   - Прямая изоляция верха и рук (в Дне Б обязательно тяжелый трицепс и бицепс).
   - НОГИ (жим ногами, сгибания/разгибания) ставятся СТРОГО В КОНЦЕ СЕССИИ в режиме Maintenance (поддержка: 2–3 сета, RIR 2–3, без отказа).
   - Икры выполняются в финале (3–4 сета).
3. ВЕСА И ПОВТОРЕНИЯ:
   - Все веса СТРОГО кратны шагу 2.5 кг.
   - Опирайся на реальные рабочие веса атлета из архива, не завышая теоретическим 1ПМ.
   - RIR: для рабочих подходов +1..+2, для ног в поддержке +3..+4.

ФОРМАТ ОТВЕТА:
Верни СТРОГО валидный компактный JSON БЕЗ какого-либо внешнего текста или Markdown-тегов:
{
  "cycleId": "${currentCid}",
  "mode": "Сила / Объем",
  "splits": {
    "A": {
      "title": "Тренировка А1 (Сила + Кластеры)",
      "exercises": [
        {
          "order": 1,
          "name": "Жим в тренажере",
          "target": "Грудь",
          "weight": 132.5,
          "sets": 4,
          "reps": "4-6",
          "rir": "+1..+2",
          "method": "Кластер 4+3+2",
          "notes": "Кластерная схема в последнем сете"
        }
      ]
    },
    "B": {
      "title": "Тренировка Б1 (Тяга + Дроп-сеты)",
      "exercises": []
    }
  },
  "rationale": "Краткое обоснование учета пожеланий атлета и порядка упражнений."
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
    if (!parsedPlan.splits || !parsedPlan.splits.A) {
      throw new Error('Структура сгенерированного плана некорректна.');
    }

    cachedPlanData = parsedPlan;
    localStorage.setItem('gym_ai_coach_plan', JSON.stringify(cachedPlanData));

    renderStructuredCards();
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
    }
  } catch (e) {
    console.warn('[Coach] Ошибка восстановления сохраненного плана:', e);
  }
}

function renderStructuredCards() {
  const container = document.getElementById('coachSplitCardsContainer');
  const rationaleBox = document.getElementById('coachRationaleDetails');
  const rationaleText = document.getElementById('coachRationaleText');
  const copyBtn = document.getElementById('copyGymUpListBtn');
  const badgeEl = document.getElementById('coachPlanCycleBadge');
  const splitTabA = document.getElementById('coachSplitTabA');
  const splitTabB = document.getElementById('coachSplitTabB');
  const splitTitleEl = document.getElementById('coachActiveSplitTitle');

  if (!container || !cachedPlanData) return;

  if (badgeEl && cachedPlanData.cycleId) {
    badgeEl.innerText = cachedPlanData.cycleId;
  }

  // Компактные кнопки-чипы в две строки (без обрезания многоточием)
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

  // Развернутое название выбранного сплита над списком упражнений
  if (splitTitleEl) {
    if (currentSplit && currentSplit.title) {
      splitTitleEl.style.display = 'block';
      splitTitleEl.innerText = currentSplit.title;
    } else {
      splitTitleEl.style.display = 'none';
    }
  }

  if (!currentSplit || !currentSplit.exercises || currentSplit.exercises.length === 0) {
    container.innerHTML = `<div style="font-size: 0.85rem; color: #94a3b8; text-align: center; padding: 12px 0;">Нет упражнений для Дня ${escapeHtml(activeSplitView)}</div>`;
    return;
  }

  container.innerHTML = '';

  currentSplit.exercises.forEach(ex => {
    const card = document.createElement('div');
    card.className = 'coach-exercise-card';
    card.innerHTML = `
      <div class="coach-card-header">
        <div>
          <span style="font-size: 0.72rem; color: var(--md-sys-color-primary); font-weight: 700;">#${parseInt(ex.order, 10) || 1} • ${escapeHtml(ex.target || 'База')}</span>
          <div class="coach-exercise-title">${escapeHtml(ex.name)}</div>
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
  });

  if (rationaleBox && rationaleText && cachedPlanData.rationale) {
    rationaleBox.style.display = 'block';
    rationaleText.innerText = cachedPlanData.rationale;
  }

  if (copyBtn) copyBtn.style.display = 'inline-flex';
}

function copyPlanToClipboard() {
  if (!cachedPlanData || !cachedPlanData.splits) return;
  const split = cachedPlanData.splits[activeSplitView];
  if (!split) return;

  const lines = [`📋 ${split.title}:`];
  (split.exercises || []).forEach(ex => {
    lines.push(`${ex.order}. ${ex.name} — ${ex.weight}кг (${ex.sets}x${ex.reps}, RIR ${ex.rir}) [${ex.method}]`);
  });

  navigator.clipboard.writeText(lines.join('\n'))
    .then(() => alert(`Список упражнений Дня ${activeSplitView} скопирован в буфер обмена для GymUp!`))
    .catch(() => alert('Не удалось скопировать текст.'));
}
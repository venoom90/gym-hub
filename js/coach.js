import { state } from './state.js';
import { askGasGeminiCoach } from './api.js';

let activeSplitView = 'A';
let cachedPlanData = null;

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

  // Наполнение списка упражнений
  const exercises = state.dbData.exercises || [];
  selectEl.innerHTML = '<option value="" disabled selected>Выберите текущее упражнение...</option>';
  exercises.forEach(ex => {
    const opt = document.createElement('option');
    opt.value = ex;
    opt.textContent = ex;
    selectEl.appendChild(opt);
  });

  // Автозаполнение последнего рабочего веса при выборе упражнения
  selectEl.onchange = () => {
    const chosen = selectEl.value;
    const sets = (state.dbData.sets || []).filter(s => (s.exercise || '').trim() === chosen);
    if (sets.length > 0) {
      const lastSet = sets[sets.length - 1];
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

    // Расчет сценариев адаптации при преждевременном отказе
    calculateAutoregulationDecision(resultBox, weight, targetReps, actualReps);
  };
}

function calculateAutoregulationDecision(container, weight, targetReps, actualReps) {
  if (!container) return;

  const repDeficit = targetReps - actualReps;
  const isSevereFailure = (actualReps <= Math.floor(targetReps / 2));

  // Округление до шага 2.5 кг
  const roundToStep = (val) => Math.round(val / 2.5) * 2.5;

  // Вариант 1: Бэк-офф сет (-15% веса)
  const backoffWeight = roundToStep(weight * 0.85);

  // Вариант 2: Кластерный сет на текущем весе
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
          ? `⚠️ <b>Системное утомление ЦНС/синергистов:</b> продолжать текущий вес опасно для связок.`
          : `⚡ <b>Локальный метаболический блок:</b> используйте адаптацию нагрузки.`}
      </div>

      <div style="background: var(--md-sys-color-surface-container-highest); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 6px; margin-top: 4px;">
        <span style="font-size: 0.8rem; font-weight: 700; color: var(--md-sys-color-primary);">ВАРИАНТ А (Рекомендуемый: Сброс веса / Back-off):</span>
        <div style="font-size: 0.85rem;">
          Установите <b>${backoffWeight} кг</b> (-15%) и выполните <b>${targetReps} повторений</b> с чистой техникой и 2-секундной паузой в растяжении.
        </div>
      </div>

      <div style="background: var(--md-sys-color-surface-container-highest); border-radius: 10px; padding: 10px; display: flex; flex-direction: column; gap: 6px;">
        <span style="font-size: 0.8rem; font-weight: 700; color: var(--md-sys-color-success);">ВАРИАНТ Б (Сохранение силового веса: Кластер):</span>
        <div style="font-size: 0.85rem;">
          Оставьте <b>${weight} кг</b>, но выполните кластерную схему: 
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
        Стимул максимален. В следующем подходе сохраняйте <b>${weight} кг</b>. 
        На следующей тренировке этого режима запланируйте прогрессию <b>+2.5 кг</b> (${weight + 2.5} кг).
      </div>
    </div>
  `;
}

/**
 * -------------------------------------------------------------
 * 2. СТРАТЕГИЧЕСКИЙ ГЕНЕРАТОР ПЛАНА МЕЗОЦИКЛА (AI COPILOT)
 * -------------------------------------------------------------
 */
function initCyclePlanner() {
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
}

async function generateMesocyclePlan() {
  const loadingBox = document.getElementById('coachPlanLoadingBox');
  const intentInput = document.getElementById('coachBlockIntent');
  if (loadingBox) loadingBox.style.display = 'block';

  const userIntent = intentInput ? intentInput.value.trim() : '';

  const sets = state.dbData.sets || [];
  const exerciseStatsMap = {};

  sets.forEach(s => {
    const ex = (s.exercise || '').trim();
    if (!ex) return;
    const isWork = s.category ? s.category === 'Рабочий' : (s.method !== 'Подводка' && s.effort !== 'Размин.');
    if (!isWork) return;

    const w = parseFloat(s.weight) || 0;
    const r = parseInt(s.reps, 10) || 0;
    const e1rm = parseFloat(s.e1rm) || (w * (1 + r / 30));

    if (!exerciseStatsMap[ex]) {
      exerciseStatsMap[ex] = { maxWeight: 0, max1RM: 0, split: s.splitDay || s.split || '' };
    }
    if (w > exerciseStatsMap[ex].maxWeight) exerciseStatsMap[ex].maxWeight = w;
    if (e1rm > exerciseStatsMap[ex].max1RM) exerciseStatsMap[ex].max1RM = parseFloat(e1rm.toFixed(1));
  });

  const exSummary = Object.keys(exerciseStatsMap).map(ex => {
    const item = exerciseStatsMap[ex];
    return `- ${ex}: рекордный вес ${item.maxWeight} кг, e1RM ${item.max1RM} кг`;
  }).join('\n');

  const currentCid = state.dbData.currentCycleId || 'C-2';

  const prompt = `Ты — ведущий эксперт по силовой подготовке, биомеханике и DUP-периодизации (Daily Undulating Periodization, Mike Israetel, Eric Helms).
Составь строгую программу тренировок на мезоцикл ${currentCid}.

[ВВОДНЫЕ И ЦЕЛИ АТЛЕТА]:
${userIntent || 'Full-Body, верх в приоритете, ноги строго в середине в режиме поддержки (Maintenance), акцент на икры, паритет трицепса.'}

[АРХИВНЫЕ СИЛОВЫЕ ПОКАЗАТЕЛИ АТЛЕТА]:
${exSummary || 'Архивных упражнений нет'}

ИНВАРИАНТЫ СОСТАВЛЕНИЯ ПЛАНА (Evidence-Based):
1. СТРОГИЙ ПОРЯДОК УПРАЖНЕНИЙ:
   - Первыми идут многосуставные станки верха тела на свежую ЦНС.
   - Ноги (жимы платформ) ставятся СТРОГО В СЕРЕДИНУ сессии в режиме Maintenance (2–3 сета, RIR 2–3, без отказа), чтобы не отнимать системный драйв у верха.
   - Икры выполняются акцентно (3–4 сета с паузой в растяжке 2 сек).
   - Баланс рук: если в Дне А идет жим груди (трицепс нагружен), а в Дне Б база груди — бабочка (трицепс выключен), то в День Б ОБЯЗАТЕЛЬНО включить прямую тяжелую изоляцию трицепса.
2. МЕТОДЫ:
   - Кластеры 4+3+2 (паузы 15-20с) назначаются только на тяжелые базовые станки верха на Неделе 3.
   - Дроп-сеты (-25%) — только на Неделе 4 на изоляцию верха и икры.
   - Все веса СТРОГО кратны шагу 2.5 кг.

ФОРМАТ ОТВЕТА:
Верни СТРОГО валидный JSON БЕЗ какого-либо внешнего текста или Markdown-тегов по следующей схеме:
{
  "cycleId": "${currentCid}",
  "mode": "Сила / Объем",
  "splits": {
    "A": {
      "title": "Тренировка А1 (Горизонтальный жим + Спина)",
      "exercises": [
        {
          "order": 1,
          "name": "Название упражнения",
          "target": "Целевая мышца",
          "weight": 132.5,
          "sets": 4,
          "reps": "4-6",
          "rir": "+1..+2",
          "method": "Стандарт",
          "equipment": "высота 4",
          "notes": "Базовый фокус"
        }
      ]
    },
    "B": {
      "title": "Тренировка Б1 (Вертикальная тяга + Бабочка + Трицепс)",
      "exercises": []
    }
  },
  "rationale": "Подробное биомеханическое обоснование порядка и синергистов."
}`;

  try {
    const rawAnswer = await askGasGeminiCoach(prompt);
    
    const jsonMatch = rawAnswer.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error('Модель не вернула валидную JSON структуру.');

    cachedPlanData = JSON.parse(jsonMatch[0]);
    localStorage.setItem('gym_ai_coach_plan', JSON.stringify(cachedPlanData));

    renderStructuredCards();
  } catch (err) {
    alert(`Ошибка генерации плана: ${err.message}`);
  } finally {
    if (loadingBox) loadingBox.style.display = 'none';
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

  if (!container || !cachedPlanData) return;

  if (badgeEl && cachedPlanData.cycleId) {
    badgeEl.innerText = cachedPlanData.cycleId;
  }

  const currentSplit = cachedPlanData.splits ? cachedPlanData.splits[activeSplitView] : null;
  if (!currentSplit || !currentSplit.exercises || currentSplit.exercises.length === 0) {
    container.innerHTML = `<div style="font-size: 0.85rem; color: #94a3b8; text-align: center; padding: 12px 0;">Нет упражнений для Сплита ${activeSplitView}</div>`;
    return;
  }

  container.innerHTML = '';

  currentSplit.exercises.forEach(ex => {
    const card = document.createElement('div');
    card.className = 'coach-exercise-card';
    card.innerHTML = `
      <div class="coach-card-header">
        <div>
          <span style="font-size: 0.72rem; color: var(--md-sys-color-primary); font-weight: 700;">#${ex.order} • ${ex.target || 'База'}</span>
          <div class="coach-exercise-title">${ex.name}</div>
        </div>
        <span class="coach-weight-tag">${ex.weight} кг</span>
      </div>
      <div class="coach-card-chips">
        <span class="coach-card-chip">${ex.sets} подх.</span>
        <span class="coach-card-chip">${ex.reps} повт.</span>
        <span class="coach-card-chip" style="color: var(--md-sys-color-primary);">RIR ${ex.rir}</span>
        <span class="coach-method-badge">${ex.method || 'Стандарт'}</span>
      </div>
      ${ex.notes ? `<div style="font-size: 0.75rem; color: var(--md-sys-color-on-surface-variant); line-height: 1.3;">📌 ${ex.notes}</div>` : ''}
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
    .then(() => alert(`Список упражнений Сплита ${activeSplitView} скопирован в буфер обмена для GymUp!`))
    .catch(() => alert('Не удалось скопировать текст.'));
}
import { state, normalizeDate, formatDateDisplay, setSelectedCycle } from './state.js';
import { requestGeminiAudit } from './api.js';

let tonnageChartInstance = null;
let exerciseChartInstance = null;

// База знаний для новичка: понятные объяснения метрик
const METRIC_HELP_KNOWLEDGE_BASE = {
  'help-cycle': {
    title: 'Что такое Мезоцикл?',
    text: 'Мезоцикл — это законченный тренировочный блок (обычно 4–5 недель), в рамках которого чередуются тяжелые силовые дни, многоповторные объемные дни и разгрузочная неделя (делоад).\n\nВыбор конкретного мезоцикла позволяет увидеть, как росла ваша сила и накапливался объем за этот период, не смешивая цифры с прошлыми месяцами.'
  },
  'help-hardsets': {
    title: 'Стимулирующие подходы (Hard Sets)',
    text: 'Мышцы растут не от всех подходов подряд, а только от тех, где вы приблизились к пределу своих сил (осталось 1–3 повторения до мышечного отказа).\n\nРазминка и легкие подходы готовят суставы, но не дают сигнала к росту. Hard Sets — это честный счетчик настоящей работы без лишнего «мусорного объема».\n\n• Норма для активного роста: 10–16 качественных подходов в неделю на мышечную группу.'
  },
  'help-pushpull': {
    title: 'Баланс жимов и тяг (Push / Pull)',
    text: 'Жимовые движения развивают грудь, передние плечи и трицепс. Тяговые — широчайшие, спину, задние плечи и бицепс.\n\nЕсли только жать и мало тянуть, плечи заворачиваются вперед, нарушается осанка и возникают боли в суставах.\n\n• Идеальный баланс: 1.0 – 1.2 в пользу тяг (на 10 жимовых подходов должно приходиться 10–12 тяговых). Это сохраняет здоровье плеч.'
  },
  'help-deload': {
    title: 'Детектор переутомления (Deload)',
    text: 'Мышцы растут не во время тренировки в зале, а во время отдыха. Если силовые показатели перестали расти, а усталость копится, организм требует разгрузки.\n\nЕсли статус меняется на «Нужен Делоад», значит пора провести запланированную разгрузочную неделю (снизить вес на 15–20% и уменьшить подходы на 40%). После делоада вас ждет суперкомпенсация и новый скачок силы.'
  },
  'help-volume': {
    title: 'Шкала объемов (Volume Landmarks)',
    text: 'Показывает, сколько подходов в неделю получает каждая группа мышц:\n\n• Maintenance (2–4 сета): поддержание текущей формы (достаточно для ног в верхнедоминантном сплите).\n• MEV (6–11 сетов): минимальный объем, запускающий рост мышц.\n• MAV (12–18 сетов): золотая середина максимального роста верха тела.\n• MRV (>18 сетов): зона риска перетренированности.'
  },
  'help-tonnage': {
    title: 'Динамика тоннажа (т)',
    text: 'Тоннаж — это общий вес, поднятый за тренировку (Вес × Повторения).\n\nВ волновой периодизации тоннаж не должен расти каждую неделю монотонно: в силовые дни он умеренный, в объемные — пиковый, а на 5-й неделе делоада столбик становится заметно ниже (выделен приглушенным цветом), что говорит о правильном запланированном восстановлении.'
  },
  'help-1rm': {
    title: 'Расчетный 1ПМ (e1RM) и рекорд (PR)',
    text: '1ПМ — это теоретический максимальный вес, который вы могли бы поднять на 1 раз.\n\nПоскольку повторения в тренировках меняются (то 6 раз, то 12 раз), сравнивать рабочие веса напрямую нельзя. Расчетный 1ПМ переводит любой подход к единому знаменателю и показывает, стали ли вы объективно сильнее.\n\nЗолотой значок PR показывает ваш абсолютный личный рекорд в этом движении.'
  }
};

export function renderAnalyticsModule() {
  populateCycleSelector();
  initHelpModalTriggers();
  renderKpiAndVolumes();
  renderExerciseSelect();
  initAiAuditTrigger();
}

function initHelpModalTriggers() {
  const modal = document.getElementById('metricHelpModal');
  const closeBtn = document.getElementById('closeHelpModalBtn');
  const titleEl = document.getElementById('helpModalTitle');
  const contentEl = document.getElementById('helpModalContent');
  if (!modal || !closeBtn) return;

  closeBtn.onclick = () => {
    modal.style.display = 'none';
  };

  modal.onclick = (e) => {
    if (e.target === modal) modal.style.display = 'none';
  };

  document.querySelectorAll('.help-trigger-btn').forEach(btn => {
    btn.onclick = (e) => {
      e.stopPropagation();
      const helpId = btn.getAttribute('data-help-id');
      const info = METRIC_HELP_KNOWLEDGE_BASE[helpId];
      if (info && titleEl && contentEl) {
        titleEl.innerText = info.title;
        contentEl.innerText = info.text;
        modal.style.display = 'flex';
      }
    };
  });
}

function initAiAuditTrigger() {
  const btn = document.getElementById('runAiAuditBtn');
  if (btn) {
    btn.onclick = () => runGeminiCycleAudit();
  }
}

function populateCycleSelector() {
  const selector = document.getElementById('cycleSelector');
  if (!selector) return;

  const currentVal = state.selectedCycleId;
  selector.innerHTML = '<option value="ALL">Все циклы за все время</option>';

  const cycles = state.dbData.cycles || [];
  cycles.forEach(cid => {
    const opt = document.createElement('option');
    opt.value = cid;
    opt.textContent = `Мезоцикл ${cid}`;
    if (cid === currentVal) opt.selected = true;
    selector.appendChild(opt);
  });

  selector.onchange = () => {
    setSelectedCycle(selector.value);
    renderKpiAndVolumes();
  };
}

function getFilteredSets() {
  const sets = state.dbData.sets || [];
  if (state.selectedCycleId === 'ALL') return sets;
  return sets.filter(s => (s.cycleId || 'C-1') === state.selectedCycleId);
}

function renderKpiAndVolumes() {
  const filteredSets = getFilteredSets();
  const catalogMap = {};
  (state.dbData.catalog || []).forEach(item => {
    if (item && item.name) catalogMap[item.name.trim()] = item;
  });

  let hardSetsCount = 0;
  let totalWorkSets = 0;
  let pushSetsScore = 0;
  let pullSetsScore = 0;

  filteredSets.forEach(s => {
    const isWork = s.category ? s.category === 'Рабочий' : (s.method !== 'Подводка' && s.effort !== 'Размин.');
    if (!isWork) return;

    totalWorkSets++;

    // Определение Hard Set: RIR <= 3 или усилие Высокое/Максимальное
    const res = parseInt(s.reserve, 10);
    const isHighEffort = (s.effort === 'Высокое' || s.effort === 'Максим.' || (!isNaN(res) && res <= 3));
    if (isHighEffort) {
      hardSetsCount++;
    }

    // Классификация Push / Pull на основе анатомии
    const item = catalogMap[(s.exercise || '').trim()];
    if (item) {
      const matchTargets = [
        { muscle: item.primaryMuscle, ratio: parseFloat(item.primaryRatio) || 1.0 },
        { muscle: item.secondaryMuscle, ratio: parseFloat(item.secondaryRatio) || 0.5 }
      ].filter(t => Boolean(t.muscle));

      matchTargets.forEach(t => {
        const m = t.muscle;
        if (m === 'Грудь' || m === 'Передняя дельта' || m === 'Средняя дельта' || m === 'Трицепс') {
          pushSetsScore += t.ratio;
        } else if (m === 'Широчайшие' || m === 'Верх спины' || m === 'Задняя дельта' || m === 'Бицепс') {
          pullSetsScore += t.ratio;
        }
      });
    }
  });

  // Расчет Push/Pull коэффициента
  const roundedPush = parseFloat(pushSetsScore.toFixed(1));
  const roundedPull = parseFloat(pullSetsScore.toFixed(1));
  let pushPullRatio = roundedPush > 0 ? (roundedPull / roundedPush) : 1.0;
  pushPullRatio = parseFloat(pushPullRatio.toFixed(2));

  // Определение статуса адаптации / детектора делоада
  let adaptationStatus = 'Свеж';
  let adaptationColor = 'var(--md-sys-color-success)';
  let adaptationSub = 'Накопление стимула';

  // Проверка недели текущего цикла
  const sortedByDate = [...filteredSets].sort((a, b) => {
    const da = normalizeDate(a.date);
    const db = normalizeDate(b.date);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  });

  const latestSet = sortedByDate[0];
  const cycleWeek = latestSet ? (parseInt(latestSet.cycleWeek, 10) || 1) : 1;
  const cycleMode = latestSet ? (latestSet.cycleMode || '') : '';

  if (cycleWeek >= 5 || cycleMode === 'Делоад' || cycleMode === 'Разгрузка') {
    adaptationStatus = 'Делоад';
    adaptationColor = 'var(--md-sys-color-warning)';
    adaptationSub = 'Плановая регенерация';
  } else if (cycleWeek >= 4) {
    adaptationStatus = 'Пик';
    adaptationColor = 'var(--md-sys-color-primary)';
    adaptationSub = 'Финал волны MAV';
  } else if (totalWorkSets > 0 && hardSetsCount / totalWorkSets > 0.85) {
    adaptationStatus = 'Прогресс';
    adaptationColor = 'var(--md-sys-color-success)';
    adaptationSub = 'Стимул максимален';
  }

  // Обновление UI карточек KPI
  const kpiHardSetsEl = document.getElementById('kpiHardSets');
  const kpiHardSetsSubEl = document.getElementById('kpiHardSetsSub');
  const kpiPushPullEl = document.getElementById('kpiPushPull');
  const kpiPushPullSubEl = document.getElementById('kpiPushPullSub');
  const kpiAdaptationEl = document.getElementById('kpiAdaptationStatus');
  const kpiAdaptationSubEl = document.getElementById('kpiAdaptationSub');

  if (kpiHardSetsEl) kpiHardSetsEl.innerText = hardSetsCount;
  if (kpiHardSetsSubEl) {
    const hardRatio = totalWorkSets > 0 ? Math.round((hardSetsCount / totalWorkSets) * 100) : 0;
    kpiHardSetsSubEl.innerText = `${hardRatio}% от всех сетов`;
  }

  if (kpiPushPullEl) kpiPushPullEl.innerText = `1 : ${pushPullRatio}`;
  if (kpiPushPullSubEl) {
    if (pushPullRatio >= 1.0 && pushPullRatio <= 1.3) {
      kpiPushPullSubEl.innerText = 'Баланс в норме';
      kpiPushPullSubEl.style.color = 'var(--md-sys-color-success)';
    } else if (pushPullRatio < 1.0) {
      kpiPushPullSubEl.innerText = 'Перевес жимов ⚠️';
      kpiPushPullSubEl.style.color = 'var(--md-sys-color-warning)';
    } else {
      kpiPushPullSubEl.innerText = 'Перевес тяг';
      kpiPushPullSubEl.style.color = 'var(--md-sys-color-primary)';
    }
  }

  if (kpiAdaptationEl) {
    kpiAdaptationEl.innerText = adaptationStatus;
    kpiAdaptationEl.style.color = adaptationColor;
  }
  if (kpiAdaptationSubEl) kpiAdaptationSubEl.innerText = adaptationSub;

  // Обновление виджета баланса
  renderPushPullWidget(roundedPush, roundedPull, pushPullRatio);

  // Отрисовка шкал объема и графика тоннажа
  renderMuscleVolumes(filteredSets);
  renderTonnageGraph(filteredSets);
}

function renderPushPullWidget(push, pull, ratio) {
  const pushCountEl = document.getElementById('balancePushCount');
  const pullCountEl = document.getElementById('balancePullCount');
  const badgeEl = document.getElementById('balanceRatioBadge');
  const fillPushEl = document.getElementById('balanceFillPush');
  const fillPullEl = document.getElementById('balanceFillPull');
  const verdictEl = document.getElementById('balanceVerdictText');

  if (pushCountEl) pushCountEl.innerText = push;
  if (pullCountEl) pullCountEl.innerText = pull;
  if (badgeEl) badgeEl.innerText = `1 : ${ratio}`;

  const total = push + pull;
  if (total > 0 && fillPushEl && fillPullEl) {
    const pushPercent = Math.round((push / total) * 100);
    const pullPercent = 100 - pushPercent;
    fillPushEl.style.width = `${pushPercent}%`;
    fillPullEl.style.width = `${pullPercent}%`;
  }

  if (verdictEl) {
    if (ratio < 0.95) {
      verdictEl.innerText = 'Внимание: мало тяг, риск перегрузки передней дельты';
      verdictEl.style.color = 'var(--md-sys-color-warning)';
    } else if (ratio >= 0.95 && ratio <= 1.3) {
      verdictEl.innerText = 'Отличный баланс: суставы защищены';
      verdictEl.style.color = 'var(--md-sys-color-success)';
    } else {
      verdictEl.innerText = 'Тяговый приоритет: спина получает высокий объем';
      verdictEl.style.color = 'var(--md-sys-color-primary)';
    }
  }
}

function renderMuscleVolumes(sets) {
  const container = document.getElementById('muscleVolumeContainer');
  const warningBadge = document.getElementById('unmappedWarning');
  const volumeTitle = document.getElementById('volumeTitle');
  if (!container) return;
  container.innerHTML = '';

  const catalogMap = {};
  let hasUnmapped = false;
  (state.dbData.catalog || []).forEach(item => {
    if (item && item.name) {
      catalogMap[item.name.trim()] = item;
      if (item.status === 'Требует разметки') hasUnmapped = true;
    }
  });

  if (warningBadge) warningBadge.style.display = hasUnmapped ? 'inline' : 'none';

  const uniqueDates = [...new Set(sets.map(s => s.date).filter(Boolean))];
  const estimatedWeeks = Math.max(1, Math.round(uniqueDates.length / 2.5));

  if (volumeTitle) {
    volumeTitle.innerText = state.selectedCycleId === 'ALL'
      ? 'Средненедельный объем (сетов/нед)'
      : `Средненедельный объем (${state.selectedCycleId}, сетов/нед)`;
  }

  const rawMuscleVolumes = {};
  sets.forEach(s => {
    const isWork = s.category ? s.category === 'Рабочий' : (s.method !== 'Подводка' && s.effort !== 'Размин.');
    if (!isWork) return;

    const info = catalogMap[(s.exercise || '').trim()];
    if (!info) return;

    if (info.primaryMuscle) {
      rawMuscleVolumes[info.primaryMuscle] = (rawMuscleVolumes[info.primaryMuscle] || 0) + (parseFloat(info.primaryRatio) || 1.0);
    }
    if (info.secondaryMuscle) {
      rawMuscleVolumes[info.secondaryMuscle] = (rawMuscleVolumes[info.secondaryMuscle] || 0) + (parseFloat(info.secondaryRatio) || 0.5);
    }
    if (info.tertiaryMuscle) {
      rawMuscleVolumes[info.tertiaryMuscle] = (rawMuscleVolumes[info.tertiaryMuscle] || 0) + (parseFloat(info.tertiaryRatio) || 0.25);
    }
  });

  const weeklyMuscleVolumes = {};
  Object.keys(rawMuscleVolumes).forEach(m => {
    weeklyMuscleVolumes[m] = parseFloat((rawMuscleVolumes[m] / estimatedWeeks).toFixed(1));
  });

  const sortedMuscles = Object.keys(weeklyMuscleVolumes)
    .filter(m => weeklyMuscleVolumes[m] >= 0.5)
    .sort((a, b) => weeklyMuscleVolumes[b] - weeklyMuscleVolumes[a]);

  if (sortedMuscles.length === 0) {
    container.innerHTML = '<div style="font-size: 0.85rem; color: #94a3b8; text-align: center; padding: 12px 0;">Нет рабочих сетов в выбранном периоде</div>';
    return;
  }

  sortedMuscles.forEach(m => {
    const val = weeklyMuscleVolumes[m];
    const isLegMuscle = (m === 'Квадрицепс' || m === 'Бицепс бедра' || m === 'Икры');

    let zoneClass = 'zone-maint';
    let zoneLabel = 'Maintenance';

    if (isLegMuscle) {
      // Адаптивная шкала поддержания для ног
      if (val >= 2 && val < 5) { zoneClass = 'zone-mev'; zoneLabel = 'Maintenance'; }
      else if (val >= 5 && val <= 10) { zoneClass = 'zone-mav'; zoneLabel = 'MEV/MAV'; }
      else if (val > 10) { zoneClass = 'zone-mrv'; zoneLabel = 'Высокий объем'; }
    } else {
      // Специализированная шкала гипертрофии верха тела
      if (val >= 6 && val < 12) { zoneClass = 'zone-mev'; zoneLabel = 'MEV'; }
      else if (val >= 12 && val <= 18) { zoneClass = 'zone-mav'; zoneLabel = 'MAV'; }
      else if (val > 18) { zoneClass = 'zone-mrv'; zoneLabel = 'MRV ⚠️'; }
    }

    const maxScale = Math.max(20, val);
    const percent = Math.min(100, Math.round((val / maxScale) * 100));

    const item = document.createElement('div');
    item.className = 'volume-item';
    item.innerHTML = `
      <div class="volume-header">
        <span><b>${m}</b></span>
        <span><b>${val}</b> сетов/нед <span style="font-size: 0.7rem; color: #94a3b8;">(${zoneLabel})</span></span>
      </div>
      <div class="volume-progress-bg">
        <div class="volume-progress-bar ${zoneClass}" style="width: ${percent}%;"></div>
      </div>
    `;
    container.appendChild(item);
  });
}

function renderTonnageGraph(sets) {
  const canvas = document.getElementById('tonnageChart');
  if (!canvas || typeof Chart === 'undefined') return;

  const dateMap = {};
  sets.forEach(s => {
    const d = normalizeDate(s.date);
    const key = d ? d.getTime() : 0;
    const label = d ? formatDateDisplay(d) : 'Без даты';
    if (!dateMap[key]) {
      dateMap[key] = {
        label,
        kg: 0,
        isDeload: String(s.workout || '').toLowerCase().includes('разгруз') || String(s.workout || '').toLowerCase().includes('делоад')
      };
    }
    const vol = s.tonnage || ((parseFloat(s.weight) || 0) * (parseInt(s.reps, 10) || 0));
    dateMap[key].kg += vol / 1000;
  });

  const sortedTimestamps = Object.keys(dateMap).sort((a, b) => a - b);
  const labels = sortedTimestamps.map(t => dateMap[t].label);
  const data = sortedTimestamps.map(t => parseFloat(dateMap[t].kg.toFixed(2)));
  const bgColors = sortedTimestamps.map(t => dateMap[t].isDeload ? 'rgba(250, 204, 21, 0.45)' : 'rgba(168, 200, 255, 0.7)');
  const borderColors = sortedTimestamps.map(t => dateMap[t].isDeload ? '#facc15' : '#a8c8ff');

  const ctx = canvas.getContext('2d');
  if (tonnageChartInstance && typeof tonnageChartInstance.destroy === 'function') {
    tonnageChartInstance.destroy();
  }

  tonnageChartInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: labels,
      datasets: [{
        label: 'Тоннаж (т)',
        data: data,
        backgroundColor: bgColors,
        borderColor: borderColors,
        borderWidth: 1.5,
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: (ctx) => {
              const idx = ctx.dataIndex;
              const isDeload = dateMap[sortedTimestamps[idx]].isDeload;
              return `${ctx.raw} т ${isDeload ? '(Делоад)' : ''}`;
            }
          }
        }
      },
      scales: {
        x: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' } }
      }
    }
  });
}

function renderExerciseSelect() {
  const select = document.getElementById('exerciseSelector');
  if (!select) return;
  select.innerHTML = '';

  const exercises = state.dbData.exercises || [];
  exercises.forEach(ex => {
    const opt = document.createElement('option');
    opt.value = ex;
    opt.textContent = ex;
    select.appendChild(opt);
  });

  select.onchange = () => renderExerciseProgressChart(select.value);
  if (exercises.length > 0) {
    renderExerciseProgressChart(exercises[0]);
  }
}

function renderExerciseProgressChart(exerciseName) {
  const canvas = document.getElementById('exerciseChart');
  const prBadgeEl = document.getElementById('exercisePrBadge');
  const prValueEl = document.getElementById('exercisePrValue');
  if (!canvas || typeof Chart === 'undefined') return;

  const sets = (state.dbData.sets || []).filter(s => (s.exercise || '').trim() === exerciseName.trim());
  const sessionMap = {};
  let allTimeMax1RM = 0;

  sets.forEach(s => {
    const d = normalizeDate(s.date);
    if (!d) return;
    const key = d.getTime();
    const displayDate = formatDateDisplay(d);
    const isWork = s.category ? s.category === 'Рабочий' : (s.method !== 'Подводка' && s.effort !== 'Размин.');

    const w = parseFloat(s.weight) || 0;
    const r = parseInt(s.reps, 10) || 0;

    if (w > 0 && r > 0 && isWork) {
      const epley1RM = s.e1rm || (w * (1 + r / 30));
      if (!sessionMap[key]) sessionMap[key] = { label: displayDate, maxWeight: 0, max1RM: 0 };
      if (w > sessionMap[key].maxWeight) sessionMap[key].maxWeight = w;
      if (epley1RM > sessionMap[key].max1RM) sessionMap[key].max1RM = parseFloat(epley1RM.toFixed(1));
      if (epley1RM > allTimeMax1RM) allTimeMax1RM = epley1RM;
    }
  });

  // Обновление бейджа персонального рекорда
  if (prBadgeEl && prValueEl) {
    if (allTimeMax1RM > 0) {
      prBadgeEl.style.display = 'flex';
      prValueEl.innerText = `PR: ${allTimeMax1RM.toFixed(1)} кг`;
    } else {
      prBadgeEl.style.display = 'none';
    }
  }

  const sortedKeys = Object.keys(sessionMap).sort((a, b) => a - b);
  const labels = sortedKeys.map(k => sessionMap[k].label);
  const epleyData = sortedKeys.map(k => sessionMap[k].max1RM);
  const weightData = sortedKeys.map(k => sessionMap[k].maxWeight);

  const ctx = canvas.getContext('2d');
  if (exerciseChartInstance && typeof exerciseChartInstance.destroy === 'function') {
    exerciseChartInstance.destroy();
  }

  exerciseChartInstance = new Chart(ctx, {
    type: 'line',
    data: {
      labels: labels,
      datasets: [
        {
          label: 'Расчетный 1ПМ (кг)',
          data: epleyData,
          borderColor: '#78dc9c',
          backgroundColor: 'rgba(120, 220, 156, 0.1)',
          tension: 0.3,
          fill: true
        },
        {
          label: 'Макс. рабочий вес (кг)',
          data: weightData,
          borderColor: '#a8c8ff',
          borderDash: [5, 5],
          tension: 0.2
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#e2e2e9', font: { size: 11 } } } },
      scales: {
        x: { ticks: { color: '#94a3b8', font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: '#94a3b8' }, grid: { color: '#334155' } }
      }
    }
  });
}

export async function runGeminiCycleAudit() {
  const auditBox = document.getElementById('aiAuditResult');
  if (!auditBox) return;
  auditBox.style.display = 'block';
  auditBox.innerText = '🤖 Gemini выполняет углубленный спортивный аудит (Hard Sets, Push/Pull, 1ПМ)...';

  const sets = getFilteredSets().slice(-30).map(s =>
    `${s.date} [${s.workout}] ${s.exercise}: ${s.weight}кг x ${s.reps} (Категория: ${s.category}, Усилие: ${s.effort}, Тоннаж: ${s.tonnage}кг, 1ПМ: ${s.e1rm}кг, RIR: ${s.reserve})`
  ).join('\n');

  const prompt = `Ты — ведущий эксперт по силовой подготовке и биомеханике (специалист по гипертрофии, DUP-периодизации и Volume Landmarks Mike Israetel / Eric Helms).
Проанализируй рабочий тренировочный журнал атлета за выбранный период:
${sets}

Сделай честный, структурированный, прикладной спортивный разбор БЕЗ ВОДЫ по 4 пунктам:
1. Анализ Hard Sets (Стимулирующих подходов): достаточно ли сетов выполнено в диапазоне RIR 0–3 и нет ли мусорного объема?
2. Баланс плечевого пояса (Push / Pull Ratio): защищены ли плечевые суставы или наблюдается опасный перекос в жимы?
3. Динамика силы (e1RM): есть ли объективный прирост силы между силовыми и объемными микроциклами?
4. Решение по перегрузке и разгрузке: требуется ли делоад прямо сейчас и на сколько (+2.5 кг) повышать рабочие веса в следующем цикле?`;

  try {
    const text = await requestGeminiAudit(prompt);
    auditBox.innerText = text;
  } catch (err) {
    auditBox.innerText = `Ошибка аудита: ${err.message}`;
  }
}
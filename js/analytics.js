import { state, normalizeDate, formatDateDisplay, setSelectedCycle, escapeHtml } from './state.js';
import { requestGeminiAudit } from './api.js';

let tonnageChartInstance = null;
let exerciseChartInstance = null;
let isHelpModalInitialized = false;

const METRIC_HELP_KNOWLEDGE_BASE = {
  'help-cycle': {
    title: 'Что такое Мезоцикл?',
    text: 'Мезоцикл — это законченный тренировочный блок (обычно 4–5 недель), в рамках которого чередуются тяжелые силовые дни, многоповторные объемные дни и разгрузочная неделя (делоад).\n\nВыбор конкретного мезоцикла позволяет увидеть, как росла ваша сила и накапливался объем за этот период, не смешивая цифры с прошлыми месяцами.'
  },
  'help-hardsets': {
    title: 'Стимулирующие подходы (Hard Sets)',
    text: 'Мышцы растут от качественных подходов, где вы приблизились к пределу своих сил (осталось 1–3 повторения до мышечного отказа, RIR 1–3).\n\n• Норма для активного роста: 10–16 качественных стимулирующих подходов в неделю на мышечную группу (MAV).'
  },
  'help-pushpull': {
    title: 'Баланс жимов и тяг (Push / Pull)',
    text: 'Жимовые движения развивают грудь, дельты и трицепс. Тяговые — широчайшие, ромбовидные, трапеции, заднюю дельту и бицепс.\n\n• Идеальный баланс: 1.0 – 1.2 в пользу тяг (на 10 жимовых подходов приходится 10–12 тяговых). Это предотвращает протракцию плеч и защищает суставную губу.'
  },
  'help-deload': {
    title: 'Детектор переутомления (Deload)',
    text: 'Если вы вышли на 5-ю неделю или накапливается системное утомление, статус меняется на «Делоад».\n\nВ эту неделю объем снижается на ~40%, веса на 15–20%, подходы выполняются с запасом (RIR 4–5). После делоада наступает суперкомпенсация.'
  },
  'help-volume': {
    title: 'Шкала объемов (Volume Landmarks)',
    text: 'Расчет фактического среднего объема подходов в неделю:\n\n• Maintenance (2–4 сета/нед): поддержание массы (ноги в сплите верха).\n• MEV (6–11 сетов/нед): минимальный объем запуска гипертрофии.\n• MAV (12–18 сетов/нед): диапазон максимальной адаптации верха.\n• MRV (>18 сетов/нед): предельно переносимый объем.'
  },
  'help-tonnage': {
    title: 'Динамика тоннажа (т)',
    text: 'Тоннаж — это общий вес, поднятый за тренировку (Вес × Повторения) исключительно в рабочих сетах.\n\nВ силовые дни он умеренный, в объемные дни достигает пика, а в неделю делоада (желтый цвет) снижается для регенерации суставов.'
  },
  'help-1rm': {
    title: 'Расчетный 1ПМ (e1RM) и рекорд (PR)',
    text: '1ПМ — теоретический максимальный вес на 1 повторение по формуле Эпли.\n\nПозволяет сравнивать силу в подходах с разным числом повторений. Золотой значок PR отображает личный рекорд за всю историю.'
  }
};

export function renderAnalyticsModule() {
  populateCycleSelector();
  initHelpModalTriggers();
  renderKpiAndVolumes();
  renderExerciseSelect();
}

function initHelpModalTriggers() {
  if (isHelpModalInitialized) return;

  const modal = document.getElementById('metricHelpModal');
  const closeBtn = document.getElementById('closeHelpModalBtn');
  const titleEl = document.getElementById('helpModalTitle');
  const contentEl = document.getElementById('helpModalContent');
  if (!modal || !closeBtn) return;

  closeBtn.onclick = () => { modal.style.display = 'none'; };
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

  isHelpModalInitialized = true;
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
    const isWork = (s.category === 'Рабочий') && (s.effort !== 'Размин.');
    if (!isWork) return;

    totalWorkSets++;

    const res = parseInt(s.reserve, 10);
    const isHighEffort = (s.effort === 'Высокое' || s.effort === 'Максим.' || (!isNaN(res) && res <= 3));
    if (isHighEffort) {
      hardSetsCount++;
    }

    const item = catalogMap[(s.exercise || '').trim()];
    if (item && item.status !== 'Требует разметки') {
      const matchTargets = [
        { muscle: item.primaryMuscle, ratio: parseFloat(item.primaryRatio) || 1.0 },
        { muscle: item.secondaryMuscle, ratio: parseFloat(item.secondaryRatio) || 0.5 },
        { muscle: item.tertiaryMuscle, ratio: parseFloat(item.tertiaryRatio) || 0.25 }
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

  const roundedPush = parseFloat(pushSetsScore.toFixed(1));
  const roundedPull = parseFloat(pullSetsScore.toFixed(1));
  let pushPullRatio = roundedPush > 0 ? (roundedPull / roundedPush) : 1.0;
  pushPullRatio = parseFloat(pushPullRatio.toFixed(2));

  let adaptationStatus = 'Свеж';
  let adaptationColor = 'var(--md-sys-color-success)';
  let adaptationSub = 'Накопление стимула';

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

  const kpiHardSetsEl = document.getElementById('kpiHardSets');
  const kpiHardSetsSubEl = document.getElementById('kpiHardSetsSub');
  const kpiPushPullEl = document.getElementById('kpiPushPull');
  const kpiPushPullSubEl = document.getElementById('kpiPushPullSub');
  const kpiAdaptationEl = document.getElementById('kpiAdaptationStatus');
  const kpiAdaptationSubEl = document.getElementById('kpiAdaptationSub');

  if (kpiHardSetsEl) kpiHardSetsEl.innerText = hardSetsCount;
  if (kpiHardSetsSubEl) {
    const hardRatio = totalWorkSets > 0 ? Math.round((hardSetsCount / totalWorkSets) * 100) : 0;
    kpiHardSetsSubEl.innerText = `${hardRatio}% от рабочих сетов`;
  }

  if (kpiPushPullEl) kpiPushPullEl.innerText = `1 : ${pushPullRatio}`;
  if (kpiPushPullSubEl) {
    if (pushPullRatio >= 1.0 && pushPullRatio <= 1.2) {
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

  renderPushPullWidget(roundedPush, roundedPull, pushPullRatio);
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
    if (ratio < 1.0) {
      verdictEl.innerText = 'Внимание: перевес жимов, риск перегрузки плечевого пояса';
      verdictEl.style.color = 'var(--md-sys-color-warning)';
    } else if (ratio >= 1.0 && ratio <= 1.2) {
      verdictEl.innerText = 'Отличный баланс: оптимально для здоровья суставов';
      verdictEl.style.color = 'var(--md-sys-color-success)';
    } else {
      verdictEl.innerText = 'Тяговый приоритет: активный фокус на широчайшие и спину';
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

  const timestamps = sets.map(s => {
    const d = normalizeDate(s.date);
    return d ? d.getTime() : null;
  }).filter(Boolean);

  let calculatedWeeks = 1;
  if (timestamps.length > 0) {
    const minT = Math.min(...timestamps);
    const maxT = Math.max(...timestamps);
    const diffDays = Math.round((maxT - minT) / (1000 * 60 * 60 * 24)) + 1;
    calculatedWeeks = Math.max(1, Math.ceil(diffDays / 7));
  }

  if (volumeTitle) {
    volumeTitle.innerText = state.selectedCycleId === 'ALL'
      ? 'Средненедельный объем (сетов/нед)'
      : `Средненедельный объем (${state.selectedCycleId}, сетов/нед)`;
  }

  const rawMuscleVolumes = {};
  sets.forEach(s => {
    const isWork = (s.category === 'Рабочий') && (s.effort !== 'Размин.');
    if (!isWork) return;

    const info = catalogMap[(s.exercise || '').trim()];
    if (!info || info.status === 'Требует разметки') return;

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
    weeklyMuscleVolumes[m] = parseFloat((rawMuscleVolumes[m] / calculatedWeeks).toFixed(1));
  });

  const sortedMuscles = Object.keys(weeklyMuscleVolumes)
    .filter(m => weeklyMuscleVolumes[m] >= 0.5)
    .sort((a, b) => weeklyMuscleVolumes[b] - weeklyMuscleVolumes[a]);

  if (sortedMuscles.length === 0) {
    container.innerHTML = '<div style="font-size: 0.85rem; color: #94a3b8; text-align: center; padding: 12px 0;">Нет размеченных рабочих сетов в выбранном периоде</div>';
    return;
  }

  sortedMuscles.forEach(m => {
    const val = weeklyMuscleVolumes[m];
    const isLegMuscle = (m === 'Квадрицепс' || m === 'Бицепс бедра' || m === 'Икры');

    let zoneClass = 'zone-maint';
    let zoneLabel = 'Maintenance';

    if (isLegMuscle) {
      if (val >= 2 && val < 5) { zoneClass = 'zone-mev'; zoneLabel = 'Maintenance'; }
      else if (val >= 5 && val <= 10) { zoneClass = 'zone-mav'; zoneLabel = 'MEV/MAV'; }
      else if (val > 10) { zoneClass = 'zone-mrv'; zoneLabel = 'Высокий объем'; }
    } else {
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
        <span><b>${escapeHtml(m)}</b></span>
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
    const isWork = (s.category === 'Рабочий') && (s.effort !== 'Размин.');
    if (!isWork) return;

    const d = normalizeDate(s.date);
    const key = d ? d.getTime() : 0;
    const label = d ? formatDateDisplay(d) : 'Без даты';
    if (!dateMap[key]) {
      dateMap[key] = {
        label,
        kg: 0,
        isDeload: s.cycleMode === 'Делоад' || s.cycleMode === 'Разгрузка' || parseInt(s.cycleWeek, 10) >= 5
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
        label: 'Рабочий тоннаж (т)',
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

  const exercises = state.dbData.exercises || [];
  const currentVal = select.value;

  select.innerHTML = '';

  exercises.forEach(ex => {
    const opt = document.createElement('option');
    opt.value = ex;
    opt.textContent = ex;
    select.appendChild(opt);
  });

  if (exercises.length > 0) {
    if (currentVal && exercises.includes(currentVal)) {
      select.value = currentVal;
    } else {
      select.value = exercises[0];
    }
    renderExerciseProgressChart(select.value);
  }

  select.onchange = () => renderExerciseProgressChart(select.value);
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
    const isWork = (s.category === 'Рабочий') && (s.effort !== 'Размин.');

    const w = parseFloat(s.weight) || 0;
    const r = parseInt(s.reps, 10) || 0;

    if (w > 0 && r > 0 && isWork) {
      // Опора на каноничное расчетное поле 1ПМ
      const epley1RM = parseFloat(s.e1rm) || (r === 1 ? w : w * (1 + r / 30));
      if (!sessionMap[key]) sessionMap[key] = { label: displayDate, maxWeight: 0, max1RM: 0 };
      if (w > sessionMap[key].maxWeight) sessionMap[key].maxWeight = w;
      if (epley1RM > sessionMap[key].max1RM) sessionMap[key].max1RM = parseFloat(epley1RM.toFixed(1));
      if (epley1RM > allTimeMax1RM) allTimeMax1RM = epley1RM;
    }
  });

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
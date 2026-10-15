import { state, setSelectedCycle, normalizeDate, formatDateDisplay, getDateKey, escapeHtml } from './state.js';
import { extractPeriodization } from './parser.js';

let tonnageChartInstance = null;
let exerciseChartInstance = null;
let isHelpModalInitialized = false;

const METRIC_HELP_DICTIONARY = {
  'help-cycle': {
    title: 'Выбор мезоцикла',
    text: 'Фильтрует всю аналитику, KPI и графики по выбранному 5-недельному волновому блоку (например, C-1 или C-2).\n\nВ режиме «Все циклы» недельный объем усредняется по активным тренировочным неделям.'
  },
  'help-hardsets': {
    title: 'Hard Sets (Тяжелые рабочие подходы)',
    text: 'Количество эффективных рабочих подходов за неделю или мезоцикл (без учета разминки и подводящих сетов).\n\nИменно эти подходы с близким к отказу усилием (RIR 0–3) создают основной стимул для гипертрофии.'
  },
  'help-pushpull': {
    title: 'Баланс Push / Pull (Жим / Тяга)',
    text: 'Соотношение жимовых (грудь, передняя/средняя дельта, трицепс) и тяговых (широчайшие, верх спины, задняя дельта, бицепс) нагрузок верха тела.\n\nОптимум для здоровья плечевых суставов и осанки: 1.0 – 1.2 в пользу тяговых движений.'
  },
  'help-deload': {
    title: 'Адаптация и Deload Detector',
    text: 'Автоматический индикатор накопленного утомления ЦНС и связочного аппарата.\n\nАнализирует текущую неделю мезоцикла и средний запас сил (RIR), подсказывая, когда пора провести разгрузочную неделю (Делоад).'
  },
  'help-volume': {
    title: 'Volume Landmarks (Ориентиры объема)',
    text: 'Научная шкала недельного объема по Майку Израэтелю (с учетом вклада синергистов):\n\n• Maintenance (Поддержка): 2–5 сетов (сохранение мышц, режим для ног).\n• MEV (Мин. эффективный объем): 6–11 сетов.\n• MAV (Оптимальный объем роста): 12–18 сетов.\n• MRV (Макс. переносимый объем): >18 сетов (риск перетренированности).'
  },
  'help-tonnage': {
    title: 'Динамика рабочего тоннажа',
    text: 'Суммарный поднятый вес в рабочих подходах за тренировку (в тоннах).\n\nСиним цветом выделены силовые тренировки (4–6 повт.), зеленым — объемные (12–16 повт.), серым — разгрузочные (Делоад).'
  },
  'help-1rm': {
    title: 'Прогресс в движении (Расчетный 1ПМ)',
    text: 'Оценка вашего разового максимума по формуле Эпли: Вес × (1 + Повторы / 30).\n\nРассчитывается строго на силовых подходах до 8 повторений включительно (для кластеров и дроп-сетов — строго по первому сегменту без завышения).'
  }
};

export function renderAnalyticsModule() {
  initHelpModals();
  populateCycleSelector();
  const filteredSets = getFilteredSetsByCycle();
  renderKpiCards(filteredSets);
  renderPushPullBalance(filteredSets);
  renderMuscleVolumeLandmarks(filteredSets);
  renderTonnageChart(filteredSets);
  populateExerciseSelector(filteredSets);
}

function initHelpModals() {
  if (isHelpModalInitialized) return;
  const modal = document.getElementById('metricHelpModal');
  const closeBtn = document.getElementById('closeHelpModalBtn');
  const titleEl = document.getElementById('helpModalTitle');
  const contentEl = document.getElementById('helpModalContent');

  if (closeBtn && modal) {
    closeBtn.onclick = () => { modal.style.display = 'none'; };
    modal.onclick = (e) => {
      if (e.target === modal) modal.style.display = 'none';
    };
  }

  document.querySelectorAll('.help-trigger-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const helpId = btn.getAttribute('data-help-id');
      const item = METRIC_HELP_DICTIONARY[helpId];
      if (item && modal && titleEl && contentEl) {
        titleEl.innerText = item.title;
        contentEl.innerText = item.text;
        modal.style.display = 'flex';
      }
    });
  });

  isHelpModalInitialized = true;
}

function populateCycleSelector() {
  const select = document.getElementById('cycleSelector');
  if (!select) return;

  const sets = state.dbData.sets || [];
  const cycleSet = new Set(state.dbData.cycles || []);
  sets.forEach(s => {
    if (s.cycleId) cycleSet.add(s.cycleId);
  });

  const sortedCycles = Array.from(cycleSet).sort((a, b) => {
    const na = parseInt(String(a).replace(/\D/g, ''), 10) || 0;
    const nb = parseInt(String(b).replace(/\D/g, ''), 10) || 0;
    return nb - na;
  });

  select.innerHTML = '<option value="ALL">Все циклы за все время</option>';
  sortedCycles.forEach(cid => {
    const opt = document.createElement('option');
    opt.value = cid;
    opt.textContent = `Мезоцикл ${cid}`;
    if (state.selectedCycleId === cid) opt.selected = true;
    select.appendChild(opt);
  });

  select.onchange = () => {
    setSelectedCycle(select.value);
    const filtered = getFilteredSetsByCycle();
    renderKpiCards(filtered);
    renderPushPullBalance(filtered);
    renderMuscleVolumeLandmarks(filtered);
    renderTonnageChart(filtered);
    populateExerciseSelector(filtered);
  };
}

function getFilteredSetsByCycle() {
  const allSets = state.dbData.sets || [];
  if (!state.selectedCycleId || state.selectedCycleId === 'ALL') {
    return allSets;
  }
  return allSets.filter(s => (s.cycleId || 'C-1') === state.selectedCycleId);
}

/**
 * Точный подсчет числа активных тренировочных недель (без размытия пустыми каникулами)
 */
function calculateActiveTrainingWeeks(sets) {
  const weekBuckets = new Set();
  sets.forEach(s => {
    const d = normalizeDate(s.date);
    if (!d) return;
    // Номер недели от эпохи (понедельник как начало)
    const weekNumber = Math.floor((d.getTime() + 3 * 86400000) / (7 * 86400000));
    weekBuckets.add(weekNumber);
  });
  return Math.max(1, weekBuckets.size);
}

function renderKpiCards(sets) {
  const hardSetsEl = document.getElementById('kpiHardSets');
  const hardSetsSubEl = document.getElementById('kpiHardSetsSub');
  const pushPullEl = document.getElementById('kpiPushPull');
  const pushPullSubEl = document.getElementById('kpiPushPullSub');
  const adaptEl = document.getElementById('kpiAdaptationStatus');
  const adaptSubEl = document.getElementById('kpiAdaptationSub');

  const workSets = sets.filter(s => s.category === 'Рабочий' && s.effort !== 'Размин.');
  const activeWeeks = calculateActiveTrainingWeeks(workSets);
  const avgWeeklySets = Math.round(workSets.length / activeWeeks);

  if (hardSetsEl) hardSetsEl.innerText = workSets.length;
  if (hardSetsSubEl) hardSetsSubEl.innerText = `~${avgWeeklySets} сетов / нед`;

  const { pushTotal, pullTotal } = computePushPullTotals(workSets);
  const ratio = pushTotal > 0 ? (pullTotal / pushTotal).toFixed(2) : '1.00';
  if (pushPullEl) pushPullEl.innerText = ratio;
  if (pushPullSubEl) {
    const rNum = parseFloat(ratio);
    pushPullSubEl.innerText = (rNum >= 0.9 && rNum <= 1.35) ? 'Оптимум плеча' : 'Дисбаланс тяг/жимов';
  }

  if (adaptEl && adaptSubEl) {
    if (workSets.length === 0) {
      adaptEl.innerText = 'Свеж';
      adaptEl.style.color = 'var(--md-sys-color-success)';
      adaptSubEl.innerText = 'Готов к нагрузке';
      return;
    }

    const sorted = [...workSets].sort((a, b) => {
      const da = normalizeDate(a.date);
      const db = normalizeDate(b.date);
      return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
    });

    const latest = sorted[0];
    const p = extractPeriodization(latest.workout);
    const week = parseInt(latest.cycleWeek || p.cycleWeek, 10) || 1;
    const mode = latest.cycleMode || p.cycleMode || 'Сила';

    if (mode === 'Делоад' || week >= 5) {
      adaptEl.innerText = 'Делоад';
      adaptEl.style.color = 'var(--md-sys-color-primary)';
      adaptSubEl.innerText = 'Фаза суперкомпенсации';
    } else if (week === 4) {
      adaptEl.innerText = 'Пик (Нед 4)';
      adaptEl.style.color = 'var(--md-sys-color-warning)';
      adaptSubEl.innerText = 'Скоро разгрузка';
    } else {
      adaptEl.innerText = `Неделя ${week}`;
      adaptEl.style.color = 'var(--md-sys-color-success)';
      adaptSubEl.innerText = `Режим: ${mode}`;
    }
  }
}

function computePushPullTotals(workSets) {
  const catalogMap = {};
  (state.dbData.catalog || []).forEach(item => {
    if (item && item.name) catalogMap[item.name.trim()] = item;
  });

  const pushMuscles = new Set(['Грудь', 'Передняя дельта', 'Средняя дельта', 'Трицепс']);
  const pullMuscles = new Set(['Широчайшие', 'Верх спины', 'Задняя дельта', 'Бицепс']);

  let pushTotal = 0;
  let pullTotal = 0;

  workSets.forEach(s => {
    const exName = (s.exercise || '').trim();
    const cat = catalogMap[exName];
    if (!cat || cat.status === 'Требует разметки') return;

    const targets = [
      { m: cat.primaryMuscle, r: parseFloat(cat.primaryRatio) || 1.0 },
      { m: cat.secondaryMuscle, r: parseFloat(cat.secondaryRatio) || 0.5 },
      { m: cat.tertiaryMuscle, r: parseFloat(cat.tertiaryRatio) || 0.25 }
    ];

    targets.forEach(t => {
      if (!t.m) return;
      if (pushMuscles.has(t.m)) pushTotal += t.r;
      else if (pullMuscles.has(t.m)) pullTotal += t.r;
      else if (t.m === 'Руки') {
        const low = exName.toLowerCase();
        if (low.includes('трицепс') || low.includes('разгибан') || low.includes('француз')) {
          pushTotal += t.r;
        } else {
          pullTotal += t.r;
        }
      }
    });
  });

  return {
    pushTotal: parseFloat(pushTotal.toFixed(1)),
    pullTotal: parseFloat(pullTotal.toFixed(1))
  };
}

function renderPushPullBalance(sets) {
  const workSets = sets.filter(s => s.category === 'Рабочий' && s.effort !== 'Размин.');
  const { pushTotal, pullTotal } = computePushPullTotals(workSets);

  const pushCountEl = document.getElementById('balancePushCount');
  const pullCountEl = document.getElementById('balancePullCount');
  const badgeEl = document.getElementById('balanceRatioBadge');
  const fillPushEl = document.getElementById('balanceFillPush');
  const fillPullEl = document.getElementById('balanceFillPull');
  const verdictEl = document.getElementById('balanceVerdictText');

  if (pushCountEl) pushCountEl.innerText = pushTotal;
  if (pullCountEl) pullCountEl.innerText = pullTotal;

  const total = pushTotal + pullTotal;
  const pushPct = total > 0 ? Math.round((pushTotal / total) * 100) : 50;
  const pullPct = 100 - pushPct;

  if (fillPushEl) fillPushEl.style.width = `${pushPct}%`;
  if (fillPullEl) fillPullEl.style.width = `${pullPct}%`;

  const ratio = pushTotal > 0 ? (pullTotal / pushTotal).toFixed(2) : '1.00';
  if (badgeEl) badgeEl.innerText = `1 : ${ratio}`;

  if (verdictEl) {
    const r = parseFloat(ratio);
    if (r >= 0.95 && r <= 1.3) {
      verdictEl.innerText = '✅ Баланс оптимален для здоровья плечевых суставов';
      verdictEl.style.color = 'var(--md-sys-color-success)';
    } else if (r < 0.95) {
      verdictEl.innerText = '⚠️ Доминируют жимы: добавьте тяги для задней дельты и ромбовидных';
      verdictEl.style.color = 'var(--md-sys-color-warning)';
    } else {
      verdictEl.innerText = 'ℹ️ Доминируют тяговые движения (безопасно для плеч)';
      verdictEl.style.color = 'var(--md-sys-color-primary)';
    }
  }
}

function renderMuscleVolumeLandmarks(sets) {
  const container = document.getElementById('muscleVolumeContainer');
  const warningEl = document.getElementById('unmappedWarning');
  const titleEl = document.getElementById('volumeTitle');
  if (!container) return;

  const catalogMap = {};
  let hasUnmapped = false;
  (state.dbData.catalog || []).forEach(item => {
    if (item && item.name) {
      catalogMap[item.name.trim()] = item;
      if (item.status === 'Требует разметки') hasUnmapped = true;
    }
  });

  if (warningEl) {
    warningEl.style.display = hasUnmapped ? 'inline-block' : 'none';
  }

  const workSets = sets.filter(s => s.category === 'Рабочий' && s.effort !== 'Размин.');
  if (workSets.length === 0) {
    container.innerHTML = `<div style="font-size: 0.85rem; color: var(--md-sys-color-on-surface-variant); text-align: center; padding: 8px 0;">Нет рабочих подходов для выбранного фильтра</div>`;
    return;
  }

  const activeWeeks = calculateActiveTrainingWeeks(workSets);
  if (titleEl) {
    titleEl.innerText = `Объем по мышцам (ср. за ${activeWeeks} нед.)`;
  }

  const volumeByMuscle = {};

  workSets.forEach(s => {
    const exName = (s.exercise || '').trim();
    const cat = catalogMap[exName];
    if (!cat || cat.status === 'Требует разметки') return;

    const targets = [
      { m: cat.primaryMuscle, r: parseFloat(cat.primaryRatio) || 1.0 },
      { m: cat.secondaryMuscle, r: parseFloat(cat.secondaryRatio) || 0.5 },
      { m: cat.tertiaryMuscle, r: parseFloat(cat.tertiaryRatio) || 0.25 }
    ];

    targets.forEach(t => {
      if (!t.m) return;
      volumeByMuscle[t.m] = (volumeByMuscle[t.m] || 0) + t.r;
    });
  });

  const entries = Object.entries(volumeByMuscle)
    .map(([muscle, totalSets]) => ({
      muscle,
      weeklySets: parseFloat((totalSets / activeWeeks).toFixed(1))
    }))
    .sort((a, b) => b.weeklySets - a.weeklySets);

  container.innerHTML = '';

  entries.forEach(item => {
    const isLegMaint = (item.muscle === 'Квадрицепс' || item.muscle === 'Бицепс бедра' || item.muscle === 'Ягодичные');
    let zoneLabel = 'Maintenance';
    let barClass = 'zone-maint';

    if (isLegMaint) {
      if (item.weeklySets >= 2 && item.weeklySets <= 5) {
        zoneLabel = 'Maintenance (Цель)';
        barClass = 'zone-mev';
      } else if (item.weeklySets > 5) {
        zoneLabel = 'Рост (MEV/MAV)';
        barClass = 'zone-mav';
      }
    } else {
      if (item.weeklySets >= 6 && item.weeklySets < 12) {
        zoneLabel = 'MEV (Мин. рост)';
        barClass = 'zone-mev';
      } else if (item.weeklySets >= 12 && item.weeklySets <= 18) {
        zoneLabel = 'MAV (Оптимум)';
        barClass = 'zone-mav';
      } else if (item.weeklySets > 18) {
        zoneLabel = 'MRV (Перегрузка ⚠️)';
        barClass = 'zone-mrv';
      }
    }

    const fillPercent = Math.min(100, Math.round((item.weeklySets / 20) * 100));

    const row = document.createElement('div');
    row.className = 'volume-item';
    row.innerHTML = `
      <div class="volume-header">
        <span><b>${escapeHtml(item.muscle)}</b></span>
        <span style="color: var(--md-sys-color-on-surface-variant);">${item.weeklySets} сетов/нед • <b>${escapeHtml(zoneLabel)}</b></span>
      </div>
      <div class="volume-progress-bg">
        <div class="volume-progress-bar ${barClass}" style="width: ${fillPercent}%;"></div>
      </div>
    `;
    container.appendChild(row);
  });
}

function renderTonnageChart(sets) {
  const canvas = document.getElementById('tonnageChart');
  if (!canvas || typeof Chart === 'undefined') return;

  if (tonnageChartInstance) {
    tonnageChartInstance.destroy();
    tonnageChartInstance = null;
  }

  const workSets = sets.filter(s => s.category === 'Рабочий' && s.effort !== 'Размин.');
  const byDate = {};

  workSets.forEach(s => {
    const key = getDateKey(s.date);
    if (!key) return;
    if (!byDate[key]) {
      const p = extractPeriodization(s.workout);
      byDate[key] = {
        dateKey: key,
        displayDate: formatDateDisplay(s.date).slice(0, 5),
        tonnageKg: 0,
        mode: s.cycleMode || p.cycleMode || 'Сила',
        split: s.splitDay || p.splitDay || 'А'
      };
    }
    byDate[key].tonnageKg += (parseFloat(s.tonnage) || 0);
  });

  const sortedSessions = Object.values(byDate).sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const labels = sortedSessions.map(item => `${item.displayDate} (${item.split})`);
  const dataTons = sortedSessions.map(item => parseFloat((item.tonnageKg / 1000).toFixed(2)));
  const bgColors = sortedSessions.map(item => {
    if (item.mode === 'Делоад' || item.mode === 'Разгрузка') return '#64748b';
    if (item.mode === 'Объем') return '#78dc9c';
    return '#a8c8ff';
  });

  tonnageChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels,
      datasets: [{
        label: 'Рабочий тоннаж (т)',
        data: dataTons,
        backgroundColor: bgColors,
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { ticks: { color: '#c4c6d0', font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: '#c4c6d0' }, grid: { color: 'rgba(255,255,255,0.06)' } }
      }
    }
  });
}

function populateExerciseSelector(sets) {
  const select = document.getElementById('exerciseSelector');
  if (!select) return;

  const exSet = new Set();
  sets.forEach(s => {
    if (s.exercise && s.category === 'Рабочий' && s.effort !== 'Размин.') {
      exSet.add(s.exercise.trim());
    }
  });

  const exList = Array.from(exSet).sort();
  const prevValue = select.value;
  select.innerHTML = '';

  if (exList.length === 0) {
    const opt = document.createElement('option');
    opt.textContent = 'Нет данных по упражнениям';
    select.appendChild(opt);
    return;
  }

  exList.forEach((ex, i) => {
    const opt = document.createElement('option');
    opt.value = ex;
    opt.textContent = ex;
    if (ex === prevValue || (!prevValue && i === 0)) opt.selected = true;
    select.appendChild(opt);
  });

  select.onchange = () => {
    renderExercise1RMChart(sets, select.value);
  };

  renderExercise1RMChart(sets, select.value || exList[0]);
}

/**
 * График прогресса 1ПМ: учитывает СТРОГО валидные силовые подходы (e1rm > 0 и reps <= 8)
 */
function renderExercise1RMChart(sets, exerciseName) {
  const canvas = document.getElementById('exerciseChart');
  const prBadge = document.getElementById('exercisePrBadge');
  const prValue = document.getElementById('exercisePrValue');
  if (!canvas || typeof Chart === 'undefined') return;

  if (exerciseChartInstance) {
    exerciseChartInstance.destroy();
    exerciseChartInstance = null;
  }

  const workSets = sets.filter(
    s => (s.exercise || '').trim() === exerciseName && s.category === 'Рабочий' && s.effort !== 'Размин.'
  );

  const byDateMax = {};
  let allTimePr = 0;

  workSets.forEach(s => {
    const key = getDateKey(s.date);
    if (!key) return;

    const w = parseFloat(s.weight) || 0;
    const r = parseInt(s.reps, 10) || 0;
    const serverE1 = parseFloat(s.e1rm);

    // Исключаем завышение от многоповторных подходов (> 8 повт.) и нулевых серверных значений
    let validE1RM = 0;
    if (!isNaN(serverE1) && serverE1 > 0) {
      validE1RM = serverE1;
    } else if (serverE1 === undefined && r > 0 && r <= 8 && w > 0) {
      validE1RM = r === 1 ? w : parseFloat((w * (1 + r / 30)).toFixed(1));
    }

    if (validE1RM <= 0) return;

    if (validE1RM > allTimePr) allTimePr = validE1RM;

    if (!byDateMax[key] || validE1RM > byDateMax[key].e1rm) {
      byDateMax[key] = {
        dateKey: key,
        displayDate: formatDateDisplay(s.date).slice(0, 5),
        e1rm: validE1RM,
        weight: w,
        reps: r
      };
    }
  });

  if (prBadge && prValue) {
    if (allTimePr > 0) {
      prBadge.style.display = 'flex';
      prValue.innerText = `PR: ${allTimePr.toFixed(1)} кг`;
    } else {
      prBadge.style.display = 'none';
    }
  }

  const points = Object.values(byDateMax).sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  exerciseChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: points.map(p => p.displayDate),
      datasets: [{
        label: 'Расчетный 1ПМ (кг)',
        data: points.map(p => p.e1rm),
        borderColor: '#a8c8ff',
        backgroundColor: 'rgba(168, 200, 255, 0.15)',
        tension: 0.25,
        fill: true,
        pointRadius: 4,
        pointBackgroundColor: '#a8c8ff'
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false }
      },
      scales: {
        x: { ticks: { color: '#c4c6d0', font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: '#c4c6d0' }, grid: { color: 'rgba(255,255,255,0.06)' } }
      }
    }
  });
}
import {
  state, setSelectedCycle, normalizeDate, formatDateDisplay, getDateKey, escapeHtml, computeE1RM,
  MUSCLE_THRESHOLDS, MUSCLE_ADVICE, classifyMuscleState, rirWeight, isIsolationExercise,
  isDeloadSet, getPreviousCycleId, MAINTENANCE_LOWER_BOUND, MAINTENANCE_UPPER_BOUND, getExerciseMultiplier
} from './state.js';
import { extractPeriodization } from './parser.js';
import { registerModal, openModal, closeModal } from './modal_manager.js';

/**
 * V5.9.12 (Android UX P2 #21):
 * - renderMuscleVolumeLandmarks при selectedCycleId === 'ALL' вычисляет
 *   activeWeeks через calcAnalyzerActiveWeeks (не жёсткие 2). Устраняет
 *   занижение объёма, когда за 14 дней было 3+ тренировки.
 */

let tonnageChartInstance = null;
let exerciseChartInstance = null;
let rirChartInstance = null;
let repRangeChartInstance = null;
let isHelpModalInitialized = false;

const METRIC_HELP_DICTIONARY = {
  'help-cycle': {
    title: 'Выбор мезоцикла',
    text: 'Фильтрует всю аналитику, KPI и графики по выбранному 5-недельному волновому блоку (например, C-1 или C-2).\n\nВ режиме «Все циклы» недельный объем усредняется по скользящему окну 14 дней.'
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
  'help-density': {
    title: 'Плотность и Средний вес',
    text: 'Плотность показывает, сколько килограммов вы поднимаете в минуту тренировки (кг/мин).\n\nСредний вес сета показывает общий уровень вашей силы без учета количества подходов. Если тоннаж растет, а средний вес падает — вы просто набиваете объем легкими весами.'
  },
  'help-volume': {
    title: 'Нагрузка на мышцы (Muscle Load Analyzer)',
    text: 'Недельный RIR-взвешенный объём по каждой мышце в сравнении с научными порогами Israetel:\n\n• MEV — минимальный эффективный объём для роста.\n• MAV — оптимальный объём гипертрофии.\n• MRV — максимальный переносимый объём.\n\nВес каждого подхода зависит от RIR: 0-1 → 1.0, 2 → 0.85, 3 → 0.5-0.6, 4+ → 0.25-0.3.\n\nДелоад-недели исключаются из подсчёта.'
  },
  'help-tonnage': {
    title: 'Динамика рабочего тоннажа',
    text: 'Суммарный поднятый вес в рабочих подходах за тренировку (в тоннах).\n\nСиним цветом — силовые тренировки (4–6 повт.), зеленым — объемные (12–16 повт.), серым — разгрузочные (Делоад).'
  },
  'help-1rm': {
    title: 'Прогресс в движении (Расчетный 1ПМ)',
    text: 'Оценка вашего разового максимума по формуле Эпли: Вес × (1 + Повторы / 30).\n\nРассчитывается строго на подходах до 8 повторений включительно. Свыше 8 — формула даёт >10% погрешности, такие сеты исключаются (для кластеров и дроп-сетов берётся первый сегмент).'
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
  renderRepRangeSpread(filteredSets);
  renderDropOff(filteredSets);
  renderFatigueControl(filteredSets);
  populateExerciseSelector(filteredSets);
}

function initHelpModals() {
  if (isHelpModalInitialized) return;
  const modal = document.getElementById('metricHelpModal');
  const closeBtn = document.getElementById('closeHelpModalBtn');
  const titleEl = document.getElementById('helpModalTitle');
  const contentEl = document.getElementById('helpModalContent');

  if (!modal) return;

  registerModal('metricHelpModal', {
    el: modal,
    displayStyle: 'flex'
  });

  if (closeBtn) closeBtn.onclick = () => closeModal('metricHelpModal');
  modal.onclick = (e) => {
    if (e.target === modal) closeModal('metricHelpModal');
  };

  document.querySelectorAll('.help-trigger-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const helpId = btn.getAttribute('data-help-id');
      const item = METRIC_HELP_DICTIONARY[helpId];
      if (item && titleEl && contentEl) {
        titleEl.innerText = item.title;
        contentEl.innerText = item.text;
        openModal('metricHelpModal');
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
    renderRepRangeSpread(filtered);
    renderDropOff(filtered);
    renderFatigueControl(filtered);
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

function calculateActiveTrainingWeeks(sets) {
  const weekBuckets = new Set();
  sets.forEach(s => {
    const d = normalizeDate(s.date);
    if (!d) return;
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
  const densityEl = document.getElementById('kpiDensity');
  const avgLoadEl = document.getElementById('kpiAvgLoad');

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
      adaptEl.style.color = 'var(--app-color-success)';
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
      adaptEl.style.color = 'var(--app-color-warning)';
      adaptSubEl.innerText = 'Скоро разгрузка';
    } else {
      adaptEl.innerText = `Неделя ${week}`;
      adaptEl.style.color = 'var(--app-color-success)';
      adaptSubEl.innerText = `Режим: ${mode}`;
    }
  }

  const workouts = state.dbData.workouts || [];
  let totalTonnage = 0;
  let totalDuration = 0;

  const validWorkouts = workouts.filter(w => {
    if (state.selectedCycleId === 'ALL') return true;
    return (w.cycleId || 'C-1') === state.selectedCycleId;
  });

  validWorkouts.forEach(w => {
    totalTonnage += (parseFloat(w.workTonnage) || 0);
    totalDuration += (parseFloat(w.durationMin) || 0);
  });

  const avgDensity = totalDuration > 0 ? Math.round(totalTonnage / totalDuration) : 0;
  const avgLoad = workSets.length > 0 ? Math.round(totalTonnage / workSets.length) : 0;

  if (densityEl) densityEl.innerText = `${avgDensity} кг/мин`;
  if (avgLoadEl) avgLoadEl.innerText = `Ср. сет: ${avgLoad} кг`;
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
      verdictEl.style.color = 'var(--app-color-success)';
    } else if (r < 0.95) {
      verdictEl.innerText = '⚠️ Доминируют жимы: добавьте тяги для задней дельты и ромбовидных';
      verdictEl.style.color = 'var(--app-color-warning)';
    } else {
      verdictEl.innerText = 'ℹ️ Доминируют тяговые движения (безопасно для плеч)';
      verdictEl.style.color = 'var(--md-sys-color-primary)';
    }
  }
}

function resolveDetailedMuscleRegion(rawMuscle, exerciseName) {
  const m = String(rawMuscle || '').trim();
  const ex = String(exerciseName || '').toLowerCase();

  if (m === 'Грудь') return 'Грудь';
  if (m === 'Широчайшие') return 'Широчайшие';
  if (m === 'Верх спины') return 'Верх спины';
  if (m === 'Передняя дельта') return 'Передняя дельта';
  if (m === 'Задняя дельта') return 'Задняя дельта';
  if (m === 'Средняя дельта') {
    if (ex.includes('задн') || ex.includes('обратн')) return 'Задняя дельта';
    if (ex.includes('передн') || ex.includes('армейск') || ex.includes('жим')) return 'Передняя дельта';
    return 'Средняя дельта';
  }
  if (m === 'Бицепс') return 'Бицепс';
  if (m === 'Трицепс') return 'Трицепс';
  if (m === 'Руки') {
    if (ex.includes('трицепс') || ex.includes('разгибан') || ex.includes('француз') || ex.includes('брусь')) return 'Трицепс';
    return 'Бицепс';
  }
  if (m === 'Квадрицепс') return 'Квадрицепс';
  if (m === 'Бицепс бедра') return 'Бицепс бедра';
  if (m === 'Ягодичные') return 'Ягодичные';
  if (m === 'Икры') return 'Икры';
  return m;
}

function calcAnalyzerActiveWeeks(sets) {
  const buckets = new Set();
  sets.forEach(s => {
    const d = normalizeDate(s.date);
    if (!d) return;
    const wk = Math.floor((d.getTime() + 3 * 86400000) / (7 * 86400000));
    buckets.add(wk);
  });
  return Math.max(1, buckets.size);
}

function calcWeeklyVolumeByMuscle(sets, activeWeeks) {
  const catalogMap = {};
  (state.dbData.catalog || []).forEach(item => {
    if (item && item.name) catalogMap[item.name.trim()] = item;
  });

  const volumeByMuscle = {};

  sets.forEach(s => {
    const cat = catalogMap[(s.exercise || '').trim()];
    if (!cat || cat.status === 'Требует разметки') return;

    const rirCoef = rirWeight(s.reserve, isIsolationExercise(s.exercise));
    if (rirCoef <= 0) return;

    const targets = [
      { m: cat.primaryMuscle, r: parseFloat(cat.primaryRatio) || 1.0 },
      { m: cat.secondaryMuscle, r: parseFloat(cat.secondaryRatio) || 0.5 },
      { m: cat.tertiaryMuscle, r: parseFloat(cat.tertiaryRatio) || 0.25 }
    ];

    targets.forEach(t => {
      if (!t.m) return;
      const region = resolveDetailedMuscleRegion(t.m, s.exercise);
      volumeByMuscle[region] = (volumeByMuscle[region] || 0) + (t.r * rirCoef);
    });
  });

  const weekly = {};
  Object.keys(volumeByMuscle).forEach(m => {
    weekly[m] = parseFloat((volumeByMuscle[m] / activeWeeks).toFixed(1));
  });
  return weekly;
}

function renderMuscleVolumeLandmarks(sets) {
  const container = document.getElementById('muscleVolumeContainer');
  const warningEl = document.getElementById('unmappedWarning');
  const titleEl = document.getElementById('volumeTitle');
  const subtitleEl = document.getElementById('volumeSubtitle');
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

  const workSets = sets.filter(s =>
    s.category === 'Рабочий' &&
    s.effort !== 'Размин.' &&
    !isDeloadSet(s.cycleWeek, s.cycleMode)
  );

  if (titleEl) titleEl.innerText = 'Нагрузка на мышцы';

  if (workSets.length === 0) {
    container.innerHTML = `<div style="font: var(--md-sys-typescale-body-medium); color: var(--md-sys-color-on-surface-variant); text-align: center; padding: 12px 0;">Нет рабочих подходов (без учёта делоада) для выбранного фильтра</div>`;
    if (subtitleEl) subtitleEl.style.display = 'none';
    return;
  }

  let analyzerSets = workSets;
  let activeWeeks = 1;
  let windowLabel = '';

  if (state.selectedCycleId === 'ALL') {
    const now = new Date();
    now.setHours(12, 0, 0, 0);
    const cutoff = now.getTime() - 14 * 86400000;
    analyzerSets = workSets.filter(s => {
      const d = normalizeDate(s.date);
      return d && d.getTime() >= cutoff;
    });

    if (analyzerSets.length === 0) {
      container.innerHTML = `<div style="font: var(--md-sys-typescale-body-medium); color: var(--md-sys-color-on-surface-variant); text-align: center; padding: 12px 0;">За последние 14 дней нет рабочих подходов</div>`;
      if (subtitleEl) subtitleEl.style.display = 'none';
      return;
    }
    // V5.9.12: реальное число активных недель, а не жёсткие 2.
    activeWeeks = Math.max(1, calcAnalyzerActiveWeeks(analyzerSets));
    windowLabel = `Скользящее окно: 14 дней`;
  } else {
    activeWeeks = calcAnalyzerActiveWeeks(workSets);
    windowLabel = `Мезоцикл ${state.selectedCycleId} • активных недель: ${activeWeeks}`;
  }

  const weekly = calcWeeklyVolumeByMuscle(analyzerSets, activeWeeks);

  let prevWeekly = null;
  if (state.selectedCycleId !== 'ALL') {
    const prevCycleId = getPreviousCycleId(state.selectedCycleId);
    if (prevCycleId) {
      const prevWorkSets = (state.dbData.sets || []).filter(s =>
        (s.cycleId || 'C-1') === prevCycleId &&
        s.category === 'Рабочий' &&
        s.effort !== 'Размин.' &&
        !isDeloadSet(s.cycleWeek, s.cycleMode)
      );
      if (prevWorkSets.length > 0) {
        const prevActiveWeeks = calcAnalyzerActiveWeeks(prevWorkSets);
        prevWeekly = calcWeeklyVolumeByMuscle(prevWorkSets, prevActiveWeeks);
      }
    }
  }

  const lagging = [];
  const optimal = [];
  const maintenance = [];
  const overload = [];

  Object.keys(MUSCLE_THRESHOLDS).forEach(muscle => {
    const thresholds = MUSCLE_THRESHOLDS[muscle];
    const weeklyVol = weekly[muscle] || 0;
    const cls = classifyMuscleState(weeklyVol, thresholds);

    if (cls.status === 'lagging') {
      const deficit = Math.max(1, Math.ceil(thresholds.mev - weeklyVol));
      let delta = null;
      if (prevWeekly && prevWeekly[muscle] !== undefined) {
        delta = parseFloat((weeklyVol - prevWeekly[muscle]).toFixed(1));
      }
      lagging.push({
        muscle,
        volume: weeklyVol,
        target: thresholds.mev,
        deficit,
        advice: MUSCLE_ADVICE[muscle] || 'изоляция',
        delta
      });
    } else if (cls.status === 'optimal') {
      optimal.push({ muscle, volume: weeklyVol });
    } else if (cls.status.indexOf('maintenance') === 0) {
      maintenance.push({ muscle, volume: weeklyVol, label: cls.label });
    } else if (cls.status === 'overload') {
      overload.push({ muscle, volume: weeklyVol, mrv: thresholds.mrv });
    }
  });

  lagging.sort((a, b) => b.deficit - a.deficit);
  optimal.sort((a, b) => b.volume - a.volume);
  maintenance.sort((a, b) => b.volume - a.volume);

  if (subtitleEl) {
    subtitleEl.style.display = 'block';
    subtitleEl.innerText = `${windowLabel} • RIR-взвешивание: ON`;
  }

  container.innerHTML = '';

  if (lagging.length > 0) {
    const section = document.createElement('div');
    section.className = 'volume-section';

    const header = document.createElement('div');
    header.className = 'volume-section-header';
    header.innerHTML = `
      <span>🔴 ЛАГАЮТ (ниже MEV)</span>
      <span class="volume-section-count">${lagging.length} шт</span>
    `;
    section.appendChild(header);

    lagging.forEach(item => {
      const card = document.createElement('div');
      card.className = 'muscle-lag-card';
      const pct = Math.min(100, Math.round((item.volume / item.target) * 100));

      let deltaHtml = '';
      if (item.delta !== null) {
        const cls = item.delta >= 0 ? 'delta-positive' : 'delta-negative';
        const sign = item.delta >= 0 ? '+' : '';
        deltaHtml = `<span class="lag-delta ${cls}">Δ к пред. циклу: ${sign}${item.delta} сет/нед</span>`;
      }

      card.innerHTML = `
        <div class="lag-header">
          <span class="lag-name">• ${escapeHtml(item.muscle)}</span>
          <span class="lag-num">${item.volume} / ${item.target}</span>
        </div>
        <div class="lag-bar"><div class="lag-bar-fill" style="width: ${pct}%;"></div></div>
        <div class="lag-advice">→ +${item.deficit} подхода: ${escapeHtml(item.advice)}</div>
        ${deltaHtml}
      `;
      section.appendChild(card);
    });

    container.appendChild(section);
  }

  if (optimal.length > 0) {
    const section = document.createElement('div');
    section.className = 'volume-section';

    const header = document.createElement('div');
    header.className = 'volume-section-header';
    header.innerHTML = `
      <span>🟢 ОПТИМАЛЬНО (MEV–MRV)</span>
      <span class="volume-section-count">${optimal.length} шт</span>
    `;
    section.appendChild(header);

    const chips = document.createElement('div');
    chips.className = 'optimal-chips';
    optimal.forEach(item => {
      const chip = document.createElement('span');
      chip.className = 'optimal-chip';
      chip.innerText = `${item.muscle} ${item.volume}`;
      chips.appendChild(chip);
    });
    section.appendChild(chips);
    container.appendChild(section);
  }

  if (maintenance.length > 0) {
    const section = document.createElement('div');
    section.className = 'volume-section';

    const header = document.createElement('div');
    header.className = 'volume-section-header';
    header.innerHTML = `
      <span>🔵 MAINTENANCE (осознанно)</span>
      <span class="volume-section-count">${maintenance.length} шт</span>
    `;
    section.appendChild(header);

    const list = document.createElement('div');
    list.className = 'maint-list';
    maintenance.forEach(item => {
      const row = document.createElement('div');
      row.className = 'maint-row';
      const statusIcon = item.label.indexOf('Цель') !== -1
        ? '✅'
        : (item.label.indexOf('ниже') !== -1 ? '⚠️' : '↑');
      row.innerHTML = `
        <span class="maint-name">${escapeHtml(item.muscle)}</span>
        <span class="maint-value">${item.volume} / цель ${MAINTENANCE_LOWER_BOUND}-${MAINTENANCE_UPPER_BOUND} ${statusIcon}</span>
      `;
      list.appendChild(row);
    });
    section.appendChild(list);
    container.appendChild(section);
  }

  if (overload.length > 0) {
    const section = document.createElement('div');
    section.className = 'volume-section';

    const header = document.createElement('div');
    header.className = 'volume-section-header';
    header.style.color = 'var(--app-color-warning)';
    header.innerHTML = `
      <span>⚠️ ПЕРЕГРУЗ (выше MRV)</span>
      <span class="volume-section-count">${overload.length} шт</span>
    `;
    section.appendChild(header);

    const list = document.createElement('div');
    list.className = 'overload-list';
    overload.forEach(item => {
      const row = document.createElement('div');
      row.className = 'overload-row';
      row.innerHTML = `
        <span class="overload-name">${escapeHtml(item.muscle)}</span>
        <span class="overload-value">${item.volume} / MRV ${item.mrv} ⚠️</span>
      `;
      list.appendChild(row);
    });
    section.appendChild(list);
    container.appendChild(section);
  }
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
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#c4c6d0', font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: '#c4c6d0' }, grid: { color: 'rgba(255,255,255,0.06)' } }
      }
    }
  });
}

function renderRepRangeSpread(sets) {
  const canvas = document.getElementById('repRangeChart');
  const verdictEl = document.getElementById('repRangeVerdict');
  if (!canvas || typeof Chart === 'undefined') return;

  if (repRangeChartInstance) {
    repRangeChartInstance.destroy();
    repRangeChartInstance = null;
  }

  const workSets = sets.filter(s => s.category === 'Рабочий' && s.effort !== 'Размин.');

  let strength = 0, hyper = 0, pump = 0;

  workSets.forEach(s => {
    const reps = parseInt(s.reps, 10) || 0;
    if (reps <= 8) strength++;
    else if (reps <= 15) hyper++;
    else pump++;
  });

  const total = strength + hyper + pump;

  if (total === 0) {
    if (verdictEl) verdictEl.innerText = '';
    return;
  }

  const strengthPct = Math.round((strength / total) * 100);
  const hyperPct = Math.round((hyper / total) * 100);
  const pumpPct = 100 - strengthPct - hyperPct;

  if (verdictEl) {
    if (strengthPct < 15 && pumpPct < 15) {
      verdictEl.innerText = '⚠️ Вы застряли в гипертрофии (9-15). Добавьте силовые сеты (1-8) для роста 1ПМ.';
      verdictEl.style.color = 'var(--app-color-warning)';
    } else if (strengthPct < 15) {
      verdictEl.innerText = '⚠️ Мало силовых сетов (1-8 повт). Риск потери силы.';
      verdictEl.style.color = 'var(--app-color-warning)';
    } else if (hyperPct < 50) {
      verdictEl.innerText = '💡 Много крайностей. Для гипертрофии нужно больше сетов в 9-15.';
      verdictEl.style.color = 'var(--md-sys-color-primary)';
    } else {
      verdictEl.innerText = '✅ Идеальный DUP-баланс (Сила + Гипертрофия).';
      verdictEl.style.color = 'var(--app-color-success)';
    }
  }

  repRangeChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: ['Зоны повторений'],
      datasets: [
        { label: 'Сила (1-8)', data: [strength], backgroundColor: '#ff6b6b', borderRadius: { topLeft: 6, bottomLeft: 6 } },
        { label: 'Гипертрофия (9-15)', data: [hyper], backgroundColor: '#78dc9c' },
        { label: 'Выносливость (16+)', data: [pump], backgroundColor: '#a8c8ff', borderRadius: { topRight: 6, bottomRight: 6 } }
      ]
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: '#c4c6d0', boxWidth: 12, font: {size: 10} } },
        tooltip: {
          callbacks: {
            label: (ctx) => `${ctx.dataset.label}: ${ctx.raw} сетов (${Math.round((ctx.raw/total)*100)}%)`
          }
        }
      },
      scales: {
        x: { stacked: true, display: false, max: total },
        y: { stacked: true, display: false }
      }
    }
  });
}

function renderDropOff(sets) {
  const container = document.getElementById('dropOffContainer');
  if (!container) return;

  const workSets = sets.filter(s => s.category === 'Рабочий' && s.effort !== 'Размин.');
  if (workSets.length === 0) {
    container.innerHTML = `<div style="font: var(--md-sys-typescale-body-small); color: var(--md-sys-color-on-surface-variant); text-align: center; padding: 8px 0;">Нет данных</div>`;
    return;
  }

  const sortedByDate = [...workSets].sort((a, b) => {
    const da = normalizeDate(a.date);
    const db = normalizeDate(b.date);
    return (db ? db.getTime() : 0) - (da ? da.getTime() : 0);
  });

  const latestDate = sortedByDate[0] ? sortedByDate[0].date : null;
  if (!latestDate) return;

  const latestSets = workSets.filter(s => s.date === latestDate);

  const byExercise = {};
  latestSets.forEach(s => {
    const ex = (s.exercise || '').trim();
    if (!ex) return;

    const method = String(s.method || '').toLowerCase();
    if (method.includes('дроп') || method.includes('кластер')) return;

    if (!byExercise[ex]) byExercise[ex] = [];
    byExercise[ex].push(s);
  });

  const drops = [];
  Object.keys(byExercise).forEach(ex => {
    const exSets = byExercise[ex].sort((a,b) => parseInt(a.setNum) - parseInt(b.setNum));
    if (exSets.length < 2) return;

    const first = exSets[0];
    const last = exSets[exSets.length - 1];

    const firstTonnage = (parseFloat(first.weight) || 0) * (parseInt(first.reps, 10) || 0);
    const lastTonnage = (parseFloat(last.weight) || 0) * (parseInt(last.reps, 10) || 0);

    if (firstTonnage > 0 && lastTonnage > 0 && firstTonnage > lastTonnage) {
      const pct = Math.round(((firstTonnage - lastTonnage) / firstTonnage) * 100);
      if (pct >= 10) {
        drops.push({ ex, pct });
      }
    }
  });

  drops.sort((a, b) => b.pct - a.pct);

  if (drops.length === 0) {
    container.innerHTML = `<div class="foster-indicator good">🟢 Отличная выносливость. Падения веса нет или оно < 10%</div>`;
    return;
  }

  container.innerHTML = drops.slice(0, 3).map(d => {
    let colorClass = 'foster-indicator good';
    if (d.pct > 30) colorClass = 'foster-indicator bad';
    else if (d.pct > 20) colorClass = 'foster-indicator warn';

    return `
      <div class="${colorClass}" style="margin-bottom: 6px; padding: 10px;">
        <div style="display: flex; justify-content: space-between; width: 100%;">
          <span style="font-weight: 700;">${escapeHtml(d.ex)}</span>
          <span>Падение: -${d.pct}%</span>
        </div>
        <div style="font-size: 0.75rem; opacity: 0.85; font-weight: 400; margin-top: 4px;">
          ${d.pct > 30 ? 'Слишком много подходов или мало отдыха.' : 'Нормальное утомление.'}
        </div>
      </div>
    `;
  }).join('');
}

function renderFatigueControl(sets) {
  const fosterContainer = document.getElementById('fosterStatusContainer');
  const rirCanvas = document.getElementById('rirChart');

  if (!fosterContainer || !rirCanvas) return;

  const workouts = state.dbData.workouts || [];
  const dailyLoads = [];

  const today = new Date();
  today.setHours(12, 0, 0, 0);

  for (let i = 0; i < 7; i++) {
    const d = new Date(today);
    d.setDate(d.getDate() - i);
    const key = getDateKey(d);

    const dayWorkouts = workouts.filter(w => getDateKey(w.date) === key);
    let dayLoad = 0;
    dayWorkouts.forEach(w => {
      let tl = parseFloat(w.trainingLoad);
      if (isNaN(tl) || tl <= 0) {
        tl = (parseFloat(w.sRPE) || 8) * (parseFloat(w.durationMin) || 45);
      }
      dayLoad += tl;
    });
    dailyLoads.push(dayLoad);
  }

  const totalWorkouts = dailyLoads.filter(l => l > 0).length;

  let fosterHtml = '';
  if (totalWorkouts === 0) {
    fosterHtml = `<div class="foster-indicator good">🟢 Нет данных о тренировках за 7 дней</div>`;
  } else {
    const sum = dailyLoads.reduce((a, b) => a + b, 0);
    const mean = sum / 7;
    const variance = dailyLoads.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / 7;
    const stdDev = Math.sqrt(variance);

    let monotony = stdDev > 0 ? (mean / stdDev) : 0;
    if (!isFinite(monotony) || isNaN(monotony)) monotony = 0;
    const strain = sum * monotony;

    let statusClass = 'good';
    let statusText = '🟢 Оптимум нагрузки';

    if (monotony > 2.0 || strain > 4000) {
      statusClass = 'bad';
      statusText = '🔴 Риск перетрена: высокая монотонность или напряжение';
    } else if (strain > 3000) {
      statusClass = 'warn';
      statusText = '🟡 Пограничная нагрузка: следите за сном и пульсом';
    }

    fosterHtml = `
      <div class="foster-indicator ${statusClass}" style="flex-direction: column; align-items: flex-start; gap: 4px;">
        <div style="display: flex; align-items: center; gap: 6px;">${statusText}</div>
        <div style="font-size: 0.75rem; opacity: 0.85; font-weight: 400;">
          Monotony: <b>${monotony.toFixed(2)}</b> (норма &lt;2.0) · Strain: <b>${Math.round(strain)}</b> (норма &lt;4000)
        </div>
      </div>
    `;
  }
  fosterContainer.innerHTML = fosterHtml;

  if (rirChartInstance) {
    rirChartInstance.destroy();
    rirChartInstance = null;
  }

  const workSets = sets.filter(s =>
    s.category === 'Рабочий' &&
    s.effort !== 'Размин.' &&
    s.reserve &&
    String(s.reserve).trim() !== ''
  );

  const weekRir = {};
  workSets.forEach(s => {
    let week = parseInt(s.cycleWeek, 10);
    if (isNaN(week) || week <= 0) {
      const p = extractPeriodization(s.workout);
      week = parseInt(p.cycleWeek, 10) || 1;
    }

    const clean = parseFloat(String(s.reserve).replace('+', ''));
    if (isNaN(clean)) return;

    if (!weekRir[week]) weekRir[week] = { sum: 0, count: 0 };
    weekRir[week].sum += clean;
    weekRir[week].count++;
  });

  const weeksSorted = Object.keys(weekRir).map(Number).sort((a, b) => a - b);
  const rirLabels = weeksSorted.map(w => w >= 5 ? 'Делоад' : `Нед ${w}`);
  const rirData = weeksSorted.map(w => {
    return parseFloat((weekRir[w].sum / weekRir[w].count).toFixed(1));
  });

  const rirColors = rirData.map(val => {
    if (val < 1.2) return '#ff6b6b';
    if (val < 2.8) return '#78dc9c';
    return '#a8c8ff';
  });

  rirChartInstance = new Chart(rirCanvas.getContext('2d'), {
    type: 'bar',
    data: {
      labels: rirLabels,
      datasets: [{
        label: 'Средний RIR',
        data: rirData,
        backgroundColor: rirColors,
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
            label: (ctx) => `RIR: ${ctx.raw} (${ctx.raw < 1.2 ? 'Отказ' : (ctx.raw < 2.8 ? 'Оптимум' : 'Запас')})`
          }
        }
      },
      scales: {
        x: { ticks: { color: '#c4c6d0', font: { size: 10 } }, grid: { display: false } },
        y: {
          min: 0,
          max: 4,
          ticks: { color: '#c4c6d0', stepSize: 1 },
          grid: { color: 'rgba(255,255,255,0.06)' }
        }
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

function renderExercise1RMChart(sets, exerciseName) {
  const canvas = document.getElementById('exerciseChart');
  const prBadge = document.getElementById('exercisePrBadge');
  const prValue = document.getElementById('exercisePrValue');
  const repMaxContainer = document.getElementById('repMaxContainer');

  if (!canvas || typeof Chart === 'undefined') return;

  if (exerciseChartInstance) {
    exerciseChartInstance.destroy();
    exerciseChartInstance = null;
  }

  const mult = getExerciseMultiplier(exerciseName);

  const workSets = sets.filter(
    s => (s.exercise || '').trim() === exerciseName && s.category === 'Рабочий' && s.effort !== 'Размин.'
  );

  const byDateMax = {};
  let allTimePr = 0;

  let max5 = 0, max8 = 0, max12 = 0;

  workSets.forEach(s => {
    const key = getDateKey(s.date);
    if (!key) return;

    const w = parseFloat(s.weight) || 0;
    const r = parseInt(s.reps, 10) || 0;
    const serverE1 = parseFloat(s.e1rm);

    const displayW = w / mult;

    if (r >= 4 && r <= 6 && displayW > max5) max5 = displayW;
    if (r >= 7 && r <= 9 && displayW > max8) max8 = displayW;
    if (r >= 10 && r <= 14 && displayW > max12) max12 = displayW;

    const validE1RM = (!isNaN(serverE1) && serverE1 > 0)
      ? serverE1
      : computeE1RM(w, r);

    if (validE1RM <= 0) return;

    const displayE1RM = parseFloat((validE1RM / mult).toFixed(1));

    if (displayE1RM > allTimePr) allTimePr = displayE1RM;

    if (!byDateMax[key] || displayE1RM > byDateMax[key].e1rm) {
      byDateMax[key] = {
        dateKey: key,
        displayDate: formatDateDisplay(s.date).slice(0, 5),
        e1rm: displayE1RM,
        weight: displayW,
        reps: r
      };
    }
  });

  if (repMaxContainer) {
    if (max5 > 0 || max8 > 0 || max12 > 0) {
      repMaxContainer.style.display = 'grid';
      document.getElementById('repMax5').innerText = max5 > 0 ? `${max5.toFixed(1).replace('.0', '')} кг` : '-';
      document.getElementById('repMax8').innerText = max8 > 0 ? `${max8.toFixed(1).replace('.0', '')} кг` : '-';
      document.getElementById('repMax12').innerText = max12 > 0 ? `${max12.toFixed(1).replace('.0', '')} кг` : '-';
    } else {
      repMaxContainer.style.display = 'none';
    }
  }

  if (prBadge && prValue) {
    if (allTimePr > 0) {
      prBadge.style.display = 'flex';
      prValue.innerText = `PR: ${allTimePr.toFixed(1)} кг`;
    } else {
      prBadge.style.display = 'none';
    }
  }

  const points = Object.values(byDateMax).sort((a, b) => a.dateKey.localeCompare(b.dateKey));

  let trendData = [];
  if (points.length >= 2) {
    const yData = points.map(p => p.e1rm);
    let sumX = 0, sumY = 0, sumXY = 0, sumXX = 0;
    const n = yData.length;
    for (let i = 0; i < n; i++) {
      sumX += i;
      sumY += yData[i];
      sumXY += i * yData[i];
      sumXX += i * i;
    }
    const denominator = (n * sumXX - sumX * sumX);
    if (denominator !== 0) {
      const slope = (n * sumXY - sumX * sumY) / denominator;
      const intercept = (sumY - slope * sumX) / n;
      trendData = yData.map((_, i) => slope * i + intercept);
    }
  }

  const datasets = [{
    label: 'Расчетный 1ПМ (кг)',
    data: points.map(p => p.e1rm),
    borderColor: '#a8c8ff',
    backgroundColor: 'rgba(168, 200, 255, 0.15)',
    tension: 0.25,
    fill: true,
    pointRadius: 4,
    pointBackgroundColor: '#a8c8ff'
  }];

  if (trendData.length > 0) {
    datasets.push({
      label: 'Тренд',
      data: trendData,
      borderColor: '#facc15',
      borderDash: [5, 5],
      borderWidth: 1.5,
      pointRadius: 0,
      fill: false,
      tension: 0
    });
  }

  exerciseChartInstance = new Chart(canvas.getContext('2d'), {
    type: 'line',
    data: {
      labels: points.map(p => p.displayDate),
      datasets: datasets
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#c4c6d0', font: { size: 10 } }, grid: { display: false } },
        y: { ticks: { color: '#c4c6d0' }, grid: { color: 'rgba(255,255,255,0.06)' } }
      }
    }
  });
}
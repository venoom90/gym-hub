import { state, normalizeDate, formatDateDisplay, setSelectedCycle } from './state.js';
import { requestGeminiAudit } from './api.js';

let tonnageChartInstance = null;
let exerciseChartInstance = null;

export function renderAnalyticsModule() {
  populateCycleSelector();
  renderKpiAndVolumes();
  renderExerciseSelect();
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
  let totalKg = 0;
  let workSets = 0;
  let highEffort = 0;

  filteredSets.forEach(s => {
    const isWork = s.category ? s.category === 'Рабочий' : (s.method !== 'Подводка' && s.effort !== 'Размин.');
    const vol = s.tonnage || ((parseFloat(s.weight) || 0) * (parseInt(s.reps, 10) || 0));
    totalKg += vol;
    if (isWork) {
      workSets++;
      if (s.effort === 'Высокое' || s.effort === 'Максим.') highEffort++;
    }
  });

  const kpiTonnage = document.getElementById('kpiTotalTonnage');
  const kpiSets = document.getElementById('kpiWorkSets');
  const kpiEffort = document.getElementById('kpiAvgEffort');

  if (kpiTonnage) kpiTonnage.innerText = (totalKg / 1000).toFixed(1) + ' т';
  if (kpiSets) kpiSets.innerText = workSets;
  if (kpiEffort) kpiEffort.innerText = workSets > 0 ? Math.round((highEffort / workSets) * 100) + '%' : '0%';

  renderMuscleVolumes(filteredSets);
  renderTonnageGraph(filteredSets);
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
    let zoneClass = 'zone-maint';
    let zoneLabel = 'Maintenance';
    if (val >= 6 && val < 12) { zoneClass = 'zone-mev'; zoneLabel = 'MEV'; }
    else if (val >= 12 && val <= 18) { zoneClass = 'zone-mav'; zoneLabel = 'MAV'; }
    else if (val > 18) { zoneClass = 'zone-mrv'; zoneLabel = 'MRV ⚠️'; }

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
    if (!dateMap[key]) dateMap[key] = { label, kg: 0 };
    const vol = s.tonnage || ((parseFloat(s.weight) || 0) * (parseInt(s.reps, 10) || 0));
    dateMap[key].kg += vol / 1000;
  });

  const sortedTimestamps = Object.keys(dateMap).sort((a, b) => a - b);
  const labels = sortedTimestamps.map(t => dateMap[t].label);
  const data = sortedTimestamps.map(t => parseFloat(dateMap[t].kg.toFixed(2)));

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
        backgroundColor: 'rgba(168, 200, 255, 0.7)',
        borderColor: '#a8c8ff',
        borderRadius: 6
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
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
  if (!canvas || typeof Chart === 'undefined') return;

  const sets = (state.dbData.sets || []).filter(s => (s.exercise || '').trim() === exerciseName.trim());
  const sessionMap = {};

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
    }
  });

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
  auditBox.innerText = '🤖 Gemini анализирует адаптацию и объем мезоцикла...';

  const sets = getFilteredSets().slice(-25).map(s => 
    `${s.date} [${s.workout}] ${s.exercise}: ${s.weight}кг x ${s.reps} (${s.category}, Тоннаж: ${s.tonnage}кг, 1ПМ: ${s.e1rm}кг, Запас: ${s.reserve})`
  ).join('\n');

  const prompt = `Ты — профессиональный спортивный ученый и тренер по силовой подготовке (специалист по Daily/Weekly Undulating Periodization и Volume Landmarks).
Проанализируй тренировки атлета:
${sets}

Дай краткий экспертный аудит:
1. Оценка прогрессивной перегрузки между Силой и Объемом.
2. Анализ накопленного утомления по RIR и весам.
3. Готовность к разгрузке (Deload).
4. Рекомендации на следующий цикл.
Пиши лаконично, структурированно, без воды.`;

  try {
    const text = await requestGeminiAudit(prompt);
    auditBox.innerText = text;
  } catch (err) {
    auditBox.innerText = `Ошибка аудита: ${err.message}`;
  }
}
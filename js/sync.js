import { state, setParsedWorkout, getDateKey, normalizeDate } from './state.js';
import { parseGymUpReport } from './parser.js';
import { syncSetsToSheets, fetchAnalyticsData } from './api.js';

export function initSyncModule(onSyncSuccess) {
  const fileInput = document.getElementById('fileInput');
  const dropZone = document.getElementById('dropZone');
  const syncBtn = document.getElementById('syncAllBtn');

  if (dropZone && fileInput) {
    dropZone.addEventListener('click', () => fileInput.click());

    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length) {
        readAndHandleFile(e.target.files[0]);
      }
      e.target.value = '';
    });

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('active');
    });

    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('active'));

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('active');
      if (e.dataTransfer.files.length) {
        readAndHandleFile(e.dataTransfer.files[0]);
      }
    });
  }

  if (syncBtn) {
    syncBtn.addEventListener('click', async () => {
      await executeSync(onSyncSuccess);
    });
  }
}

function readAndHandleFile(file) {
  const reader = new FileReader();
  reader.onload = (e) => {
    handleIncomingReportText(e.target.result);
  };
  reader.onerror = (err) => {
    alert('Ошибка чтения файла: ' + err);
  };
  reader.readAsText(file);
}

export function handleIncomingReportText(text) {
  const parsed = parseGymUpReport(text);
  setParsedWorkout(parsed);
  renderParsedWorkoutView();
}

function renderParsedWorkoutView() {
  const summaryCard = document.getElementById('summaryCard');
  const container = document.getElementById('parsedContent');
  const workout = state.parsedWorkout;

  if (!workout.sets || workout.sets.length === 0) {
    alert('В отчете не найдено выполненных рабочих сетов!');
    return;
  }

  if (summaryCard) {
    summaryCard.style.display = 'flex';
    document.getElementById('workoutSummaryTitle').innerText = workout.title || 'Тренировка GymUp';
    document.getElementById('workoutSummaryDate').innerText = `${workout.date} в ${workout.startTime} (${workout.sets.length} подходов)`;
  }

  if (!container) return;
  container.innerHTML = '';

  const groups = {};
  workout.sets.forEach(set => {
    if (!groups[set.exercise]) groups[set.exercise] = [];
    groups[set.exercise].push(set);
  });

  for (const [exercise, sets] of Object.entries(groups)) {
    const card = document.createElement('div');
    card.className = 'exercise-card';
    card.innerHTML = `<div class="exercise-header">${exercise}</div>`;

    sets.forEach(set => {
      const row = document.createElement('div');
      row.className = 'set-row';
      row.id = `set-row-${set.id}`;

      const categoryColor = set.category === 'Рабочий' 
        ? 'var(--md-sys-color-primary)' 
        : 'var(--md-sys-color-on-surface-variant)';

      row.innerHTML = `
        <div class="set-details">
          <div><b>#${set.setNum}</b> — ${set.weight} кг × ${set.reps} (${set.effort || 'Без оценки'})</div>
          <div class="set-chips">
            <span class="badge-chip" style="color: ${categoryColor}; font-weight: 600;">${set.category}</span>
            <span class="badge-chip">Тоннаж: ${set.tonnage} кг</span>
            ${set.e1rm > 0 ? `<span class="badge-chip" style="color: var(--md-sys-color-success);">1ПМ: ~${set.e1rm} кг</span>` : ''}
            ${set.reserve ? `<span class="badge-chip">Запас: ${set.reserve}</span>` : ''}
            ${set.method ? `<span class="badge-chip">${set.method}</span>` : ''}
            ${set.equipment ? `<span class="badge-chip">${set.equipment}</span>` : ''}
            ${set.positioning ? `<span class="badge-chip">${set.positioning}</span>` : ''}
            <span class="badge-chip" style="color: var(--md-sys-color-primary);">День ${set.splitDay}${set.waveIndex !== 'Делоад' ? set.waveIndex : ''} / ${set.cycleMode}</span>
          </div>
        </div>
        <div class="status-indicator" id="status-box-${set.id}">
          <span class="material-symbols-outlined status-icon status-pending">hourglass_empty</span>
        </div>
      `;
      card.appendChild(row);
    });
    container.appendChild(card);
  }
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function matchesTargetDate(itemDate, targetDateStr) {
  if (!itemDate || !targetDateStr) return false;
  const key1 = getDateKey(itemDate);
  const key2 = getDateKey(targetDateStr);
  if (key1 && key2 && key1 === key2) return true;

  const d1 = normalizeDate(itemDate);
  const d2 = normalizeDate(targetDateStr);
  if (d1 && d2) {
    return d1.getFullYear() === d2.getFullYear() &&
           d1.getMonth() === d2.getMonth() &&
           d1.getDate() === d2.getDate();
  }
  return String(itemDate).trim().startsWith(String(targetDateStr).trim());
}

async function executeSync(onSyncSuccess) {
  const syncBtn = document.getElementById('syncAllBtn');
  const workout = state.parsedWorkout;
  if (!workout.sets || workout.sets.length === 0) {
    alert('Нет данных для синхронизации!');
    return;
  }

  syncBtn.disabled = true;

  // Индикация старта отправки
  workout.sets.forEach(s => {
    const box = document.getElementById(`status-box-${s.id}`);
    if (box) {
      box.innerHTML = `<span class="material-symbols-outlined status-icon status-pending" style="animation: spin 1s infinite linear;">sync</span>`;
    }
  });

  try {
    const payload = {
      action: 'sync_sets',
      overwrite: true,
      date: workout.date,
      startTime: workout.startTime,
      sets: workout.sets,
      allExercises: workout.allExercises
    };

    // 1. Отправка POST в Google Apps Script
    await syncSetsToSheets(payload);

    // 2. Двухэтапная верификация с паузой и retry для исключения Race Condition в LockService
    let isVerified = false;
    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      // Пауза перед опросом сервера: 2с на первой попытке, затем 2.5с
      await delay(attempt === 1 ? 2000 : 2500);

      const fetchResult = await fetchAnalyticsData();
      if (fetchResult && fetchResult.success) {
        const verifiedSets = (state.dbData.sets || []).filter(s => matchesTargetDate(s.date, workout.date));
        if (verifiedSets.length > 0) {
          isVerified = true;
          break;
        }
      }
    }

    if (!isVerified) {
      throw new Error('Данные отправлены, но сервер Google Таблиц еще не зафиксировал строки. Повторите проверку через пару секунд.');
    }

    // 3. Успешный статус выставляется строго после верификации
    workout.sets.forEach(s => {
      s.syncStatus = 'synced';
      const box = document.getElementById(`status-box-${s.id}`);
      if (box) box.innerHTML = `<span class="material-symbols-outlined status-icon status-synced">check_circle</span>`;
    });

    if (state.dbData && (state.dbData.sets || []).length > 0) {
      localStorage.setItem('gym_cached_db_data', JSON.stringify(state.dbData));
    }

    if (typeof onSyncSuccess === 'function') onSyncSuccess();
  } catch (err) {
    workout.sets.forEach(s => {
      s.syncStatus = 'error';
      const box = document.getElementById(`status-box-${s.id}`);
      if (box) box.innerHTML = `<span class="material-symbols-outlined status-icon status-error" title="${err.message}">error</span>`;
    });
    alert('Ошибка при синхронизации: ' + err.message);
  } finally {
    syncBtn.disabled = false;
  }
}
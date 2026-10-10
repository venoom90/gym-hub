import { state, setParsedWorkout, getDateKey, normalizeDate } from './state.js';
import { parseGymUpReport } from './parser.js';
import { syncSetsToSheets, fetchAnalyticsData } from './api.js';

let syncCallback = null;

export function initSyncModule(onSyncSuccess) {
  syncCallback = onSyncSuccess;
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
    syncBtn.onclick = async () => {
      await executeSync(syncCallback);
    };
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
  const syncBtn = document.getElementById('syncAllBtn');
  const workout = state.parsedWorkout;

  if (!workout.sets || workout.sets.length === 0) {
    alert('В отчете не найдено выполненных рабочих сетов!');
    return;
  }

  if (summaryCard) {
    summaryCard.style.display = 'flex';
    const titleEl = document.getElementById('workoutSummaryTitle');
    const dateEl = document.getElementById('workoutSummaryDate');
    if (titleEl) titleEl.innerText = workout.title || 'Тренировка GymUp';
    if (dateEl) dateEl.innerText = `${workout.date} в ${workout.startTime} (${workout.sets.length} подходов)`;
  }

  // Принудительное восстановление внешнего вида и кликабельности кнопки синхронизации
  if (syncBtn) {
    syncBtn.disabled = false;
    syncBtn.style.pointerEvents = 'auto';
    syncBtn.style.cursor = 'pointer';
    syncBtn.style.display = 'inline-flex';
    syncBtn.style.alignItems = 'center';
    syncBtn.style.justifyContent = 'center';
    syncBtn.style.padding = '8px 16px';
    syncBtn.style.borderRadius = '20px';
    syncBtn.style.background = 'var(--md-sys-color-primary, #a8c7fa)';
    syncBtn.style.color = 'var(--md-sys-color-on-primary, #04315a)';
    syncBtn.style.fontWeight = '600';
    syncBtn.innerText = 'Синхронизировать';
    syncBtn.onclick = async () => {
      await executeSync(syncCallback);
    };
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

async function executeSync(onSyncSuccess) {
  const syncBtn = document.getElementById('syncAllBtn');
  const workout = state.parsedWorkout;
  if (!workout.sets || workout.sets.length === 0) {
    alert('Нет данных для синхронизации!');
    return;
  }

  if (syncBtn) {
    syncBtn.disabled = true;
    syncBtn.innerText = 'Запись...';
  }

  // Индикация начала отправки на всех сетах
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

    // 1. Отправка в Apps Script через подтвержденный рабочий канал
    const syncRes = await syncSetsToSheets(payload);

    if (!syncRes || !syncRes.success) {
      throw new Error((syncRes && syncRes.error) || 'Ошибка записи на стороне сервера');
    }

    // 2. Зеленые галочки успеха на карточках сетов
    workout.sets.forEach(s => {
      s.syncStatus = 'synced';
      const box = document.getElementById(`status-box-${s.id}`);
      if (box) {
        box.innerHTML = `<span class="material-symbols-outlined status-icon status-synced">check_circle</span>`;
      }
    });

    // 3. Фоновое обновление локальной аналитики
    try {
      await delay(1000);
      await fetchAnalyticsData();
      if (state.dbData && (state.dbData.sets || []).length > 0) {
        localStorage.setItem('gym_cached_db_data', JSON.stringify(state.dbData));
      }
    } catch (fetchErr) {
      console.warn('Локальный кэш обновится при следующем открытии:', fetchErr);
    }

    if (typeof onSyncSuccess === 'function') onSyncSuccess();
    alert(`✅ Синхронизировано успешно! Сохранено подходов: ${syncRes.count || workout.sets.length}`);
  } catch (err) {
    workout.sets.forEach(s => {
      s.syncStatus = 'error';
      const box = document.getElementById(`status-box-${s.id}`);
      if (box) {
        box.innerHTML = `<span class="material-symbols-outlined status-icon status-error" title="${err.message}">error</span>`;
      }
    });
    alert('Ошибка при синхронизации: ' + err.message);
  } finally {
    if (syncBtn) {
      syncBtn.disabled = false;
      syncBtn.innerText = 'Синхронизировать';
    }
  }
}
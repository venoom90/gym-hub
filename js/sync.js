import { state, setParsedWorkout, setInitialData, getDateKey, escapeHtml } from './state.js';
import { parseGymUpReport } from './parser.js';
import { syncSetsToSheets, fetchAnalyticsData, fetchServerDebugLogs } from './api.js';

let terminalLogsBuffer = [];
let isSyncModuleInitialized = false;

/**
 * Первичная инициализация слушателей событий вкладки синхронизации
 */
export function initSyncModule(onSyncSuccess) {
  if (isSyncModuleInitialized) return;

  const fileInput = document.getElementById('fileInput');
  const dropZone = document.getElementById('dropZone');
  const syncBtn = document.getElementById('syncAllBtn');
  const copyLogBtn = document.getElementById('copySyncLogBtn');
  const fetchServerLogsBtn = document.getElementById('fetchServerLogsBtn');
  const clearLogBtn = document.getElementById('clearSyncLogBtn');

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

  if (copyLogBtn) {
    copyLogBtn.addEventListener('click', () => {
      const text = terminalLogsBuffer.join('\n');
      navigator.clipboard.writeText(text).then(() => {
        alert('Лог синхронизации скопирован в буфер обмена!');
      }).catch(() => {
        alert('Не удалось скопировать лог.');
      });
    });
  }

  if (fetchServerLogsBtn) {
    fetchServerLogsBtn.addEventListener('click', async () => {
      await loadServerLogsToTerminal();
    });
  }

  if (clearLogBtn) {
    clearLogBtn.addEventListener('click', () => {
      terminalLogsBuffer = [];
      const box = document.getElementById('syncTerminalLogs');
      if (box) box.innerText = 'Терминал очищен.';
    });
  }

  isSyncModuleInitialized = true;
}

/**
 * Отрисовка превью разобранного отчета
 */
export function renderSyncModule() {
  if (state.parsedWorkout && state.parsedWorkout.sets && state.parsedWorkout.sets.length > 0) {
    renderParsedWorkoutView();
  }
}

function logToTerminal(stage, message, level = 'info') {
  const time = new Date().toLocaleTimeString('ru-RU', { hour12: false }) + '.' + String(new Date().getMilliseconds()).padStart(3, '0');
  const icon = level === 'error' ? '❌' : (level === 'success' ? '✅' : 'ℹ️');
  const line = `[${time}] ${icon} [${stage}] ${message}`;
  
  terminalLogsBuffer.push(line);
  if (terminalLogsBuffer.length > 100) terminalLogsBuffer.shift();

  const box = document.getElementById('syncTerminalLogs');
  if (box) {
    box.innerText = terminalLogsBuffer.join('\n');
    box.scrollTop = box.scrollHeight;
  }
}

async function loadServerLogsToTerminal() {
  logToTerminal('SERVER_FETCH', 'Запрос логов с листа Debug_Log...', 'info');
  try {
    const logs = await fetchServerDebugLogs();
    if (!logs || logs.length === 0) {
      logToTerminal('SERVER_EMPTY', 'На сервере пока нет записей логов.', 'info');
      return;
    }
    logToTerminal('SERVER_LOGS', `Получено ${logs.length} серверных событий:`, 'info');
    logs.forEach(item => {
      const extra = item.details ? ` (${item.details})` : '';
      logToTerminal('REMOTE', `${item.time} | ${item.stage} | ${item.message}${extra}`, 'info');
    });
  } catch (err) {
    logToTerminal('SERVER_ERROR', err.message, 'error');
  }
}

function readAndHandleFile(file) {
  logToTerminal('FILE_READ', `Чтение файла: ${file.name} (${file.size} байт)`, 'info');
  const reader = new FileReader();
  reader.onload = (e) => {
    handleIncomingReportText(e.target.result);
  };
  reader.onerror = (err) => {
    logToTerminal('FILE_ERROR', 'Ошибка чтения файла: ' + err, 'error');
    alert('Ошибка чтения файла: ' + err);
  };
  reader.readAsText(file);
}

export function handleIncomingReportText(text) {
  logToTerminal('PARSE_START', `Парсинг отчета (${text.length} символов)...`, 'info');
  const parsed = parseGymUpReport(text);
  setParsedWorkout(parsed);
  logToTerminal('PARSE_END', `Распознано: ${parsed.sets ? parsed.sets.length : 0} сетов, дата: "${parsed.date}", время: "${parsed.startTime}", упражнений: ${parsed.allExercises ? parsed.allExercises.length : 0}`, 'info');
  renderParsedWorkoutView();
}

function renderParsedWorkoutView() {
  const summaryCard = document.getElementById('summaryCard');
  const container = document.getElementById('parsedContent');
  const workout = state.parsedWorkout;

  if (!workout.sets || workout.sets.length === 0) {
    logToTerminal('VALIDATION', 'Отчет пуст или не содержит выполненных сетов!', 'error');
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
  workout.sets.forEach((set, index) => {
    set._uiIndex = index;
    if (!groups[set.exercise]) groups[set.exercise] = [];
    groups[set.exercise].push(set);
  });

  for (const [exercise, sets] of Object.entries(groups)) {
    const card = document.createElement('div');
    card.className = 'exercise-card';
    card.innerHTML = `<div class="exercise-header">${escapeHtml(exercise)}</div>`;

    sets.forEach(set => {
      const row = document.createElement('div');
      row.className = 'set-row';

      const categoryColor = set.category === 'Рабочий' 
        ? 'var(--md-sys-color-primary)' 
        : 'var(--md-sys-color-on-surface-variant)';

      let statusIconHtml = `<span class="material-symbols-outlined" style="font-size: 20px; color: var(--md-sys-color-outline-variant);">hourglass_empty</span>`;
      if (set.syncStatus === 'synced') {
        statusIconHtml = `<span class="material-symbols-outlined" style="font-size: 20px; color: var(--md-sys-color-success);">check_circle</span>`;
      } else if (set.syncStatus === 'error') {
        statusIconHtml = `<span class="material-symbols-outlined" style="font-size: 20px; color: var(--md-sys-color-error);">error</span>`;
      } else if (set.syncStatus === 'syncing') {
        statusIconHtml = `<span class="material-symbols-outlined" style="font-size: 20px; color: var(--md-sys-color-primary); animation: spin 1s infinite linear;">sync</span>`;
      }

      row.innerHTML = `
        <div class="set-details">
          <div><b>#${parseInt(set.setNum, 10) || 1}</b> — ${parseFloat(set.weight) || 0} кг × ${parseInt(set.reps, 10) || 0} (${escapeHtml(set.effort || 'Без оценки')})</div>
          <div class="set-chips" style="display: flex; flex-wrap: wrap; gap: 6px; font-size: 0.75rem; margin-top: 4px;">
            <span style="color: ${categoryColor}; font-weight: 600;">${escapeHtml(set.category)}</span>
            <span>Тоннаж: ${set.tonnage} кг</span>
            ${set.e1rm > 0 ? `<span style="color: var(--md-sys-color-success);">1ПМ: ~${set.e1rm} кг</span>` : ''}
            ${set.reserve ? `<span>Запас: ${escapeHtml(set.reserve)}</span>` : ''}
            ${set.method ? `<span>${escapeHtml(set.method)}</span>` : ''}
            ${set.equipment ? `<span>${escapeHtml(set.equipment)}</span>` : ''}
            ${set.positioning ? `<span>${escapeHtml(set.positioning)}</span>` : ''}
            <span style="color: var(--md-sys-color-primary);">День ${escapeHtml(set.splitDay)}${set.waveIndex !== 'Делоад' ? escapeHtml(set.waveIndex) : ''} / ${escapeHtml(set.cycleMode)}</span>
          </div>
        </div>
        <div class="status-indicator" id="set-status-box-${set._uiIndex}">
          ${statusIconHtml}
        </div>
      `;
      card.appendChild(row);
    });
    container.appendChild(card);
  }
}

async function executeSync(onSyncSuccess) {
  const syncBtn = document.getElementById('syncAllBtn');
  const workout = state.parsedWorkout;

  if (!workout.sets || workout.sets.length === 0) {
    logToTerminal('SYNC_ABORT', 'Нет данных для синхронизации', 'error');
    alert('Нет данных для синхронизации!');
    return;
  }

  if (!workout.date) {
    logToTerminal('SYNC_ABORT', 'Дата тренировки не определена. Синхронизация отменена во избежание порчи данных.', 'error');
    alert('Не удалось определить дату тренировки. Проверьте формат отчета.');
    return;
  }

  syncBtn.disabled = true;
  logToTerminal('SYNC_START', `Запуск синхронизации: ${workout.sets.length} сетов за ${workout.date}`, 'info');

  workout.sets.forEach((s, idx) => {
    s.syncStatus = 'syncing';
    const box = document.getElementById(`set-status-box-${idx}`);
    if (box) {
      box.innerHTML = `<span class="material-symbols-outlined" style="font-size: 20px; color: var(--md-sys-color-primary); animation: spin 1s infinite linear;">sync</span>`;
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

    // 1. Физическая запись на сервер с получением JSON-ответа
    const t0 = performance.now();
    logToTerminal('STEP_1_POST', `Отправка POST в Google Apps Script...`, 'info');
    const syncRes = await syncSetsToSheets(payload);
    const postDuration = Math.round(performance.now() - t0);
    logToTerminal('STEP_1_OK', `Записано ${syncRes.insertedCount || workout.sets.length} строк за ${postDuration} мс.`, 'success');

    // 2. Обратная проверка целостности (Reverse Verification)
    logToTerminal('STEP_2_VERIFY', `Запрос актуальных данных для верификации записи...`, 'info');
    const fetchResult = await fetchAnalyticsData();
    if (!fetchResult.success) {
      throw new Error(`Ошибка вычитки обновлений с сервера: ${fetchResult.error}`);
    }

    setInitialData(fetchResult.data);

    const targetKey = getDateKey(workout.date);
    const verifiedSets = (state.dbData.sets || []).filter(s => getDateKey(s.date) === targetKey);

    if (verifiedSets.length === 0) {
      logToTerminal('VERIFY_FAIL', `Ключ "${targetKey}" не найден в базе сервера после записи!`, 'error');
      throw new Error('Сервер подтвердил получение, но при обратной проверке данные не найдены.');
    }

    logToTerminal('VERIFY_SUCCESS', `Успешно верифицировано ${verifiedSets.length} подходов в базе данных!`, 'success');

    // 3. Выставление статуса успешной синхронизации
    workout.sets.forEach((s, idx) => {
      s.syncStatus = 'synced';
      const box = document.getElementById(`set-status-box-${idx}`);
      if (box) {
        box.innerHTML = `<span class="material-symbols-outlined" style="font-size: 20px; color: var(--md-sys-color-success);">check_circle</span>`;
      }
    });

    if (typeof onSyncSuccess === 'function') onSyncSuccess();
  } catch (err) {
    logToTerminal('SYNC_ERROR', `Сбой синхронизации: ${err.message}`, 'error');
    workout.sets.forEach((s, idx) => {
      s.syncStatus = 'error';
      const box = document.getElementById(`set-status-box-${idx}`);
      if (box) {
        box.innerHTML = `<span class="material-symbols-outlined" style="font-size: 20px; color: var(--md-sys-color-error);" title="${escapeHtml(err.message)}">error</span>`;
      }
    });
    alert('Ошибка при синхронизации: ' + err.message);
  } finally {
    syncBtn.disabled = false;
  }
}
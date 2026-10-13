import { state, setParsedWorkout, getDateKey } from './state.js';
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
 * Функция отрисовки/обновления для вызова из навигатора app.js
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
  logToTerminal('PARSE_START', `Парсинг текста отчета (${text.length} символов)...`, 'info');
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

async function executeSync(onSyncSuccess) {
  const syncBtn = document.getElementById('syncAllBtn');
  const workout = state.parsedWorkout;
  if (!workout.sets || workout.sets.length === 0) {
    logToTerminal('SYNC_ABORT', 'Нет данных для синхронизации', 'error');
    alert('Нет данных для синхронизации!');
    return;
  }

  syncBtn.disabled = true;
  logToTerminal('SYNC_START', `Запуск синхронизации: ${workout.sets.length} сетов за ${workout.date}`, 'info');

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
    const t0 = performance.now();
    logToTerminal('STEP_1_POST', `Отправка POST no-cors в Apps Script...`, 'info');
    await syncSetsToSheets(payload);
    const postDuration = Math.round(performance.now() - t0);
    logToTerminal('STEP_1_OK', `POST-пакет передан за ${postDuration} мс. Пауза 1000 мс перед вычиткой...`, 'success');

    // 2. Техническая пауза для завершения скрипта на сервере Google
    await new Promise(r => setTimeout(r, 1000));

    // 3. Обратная проверка (Reverse Verification)
    logToTerminal('STEP_2_VERIFY', `Запрос GET get_all_data для подтверждения физической записи...`, 'info');
    const fetchResult = await fetchAnalyticsData();
    if (!fetchResult.success) {
      throw new Error(`Не удалось связаться с сервером для подтверждения: ${fetchResult.error}`);
    }

    const targetKey = getDateKey(workout.date);
    const serverSets = (state.dbData.sets || []);
    logToTerminal('STEP_2_DATA', `Сервер вернул базу: ${serverSets.length} сетов. Поиск ключа "${targetKey}"...`, 'info');

    const verifiedSets = serverSets.filter(s => getDateKey(s.date) === targetKey);

    if (verifiedSets.length === 0) {
      logToTerminal('VERIFY_FAIL', `Ключ "${targetKey}" не найден среди записей сервера! Возможно, сработала блокировка таблицы или не завершилась запись.`, 'error');
      throw new Error('Сервер не вернул сохраненные подходы. Возможно, сработала блокировка таблицы.');
    }

    logToTerminal('VERIFY_SUCCESS', `Успешно верифицировано ${verifiedSets.length} подходов в базе!`, 'success');

    // 4. Выставление статуса успеха
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
    logToTerminal('SYNC_ERROR', `Сбой синхронизации: ${err.message}`, 'error');
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
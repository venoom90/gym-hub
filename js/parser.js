/**
 * Парсер отчетов GymUp и периодизации тренировочной программы
 * Поддержка нативного формата GymUp (•), составных повторений (кластеры), дроп-сетов, дробных весов и заметок
 */

export function normalizeExerciseName(rawName) {
  if (!rawName) return '';
  return String(rawName)
    .replace(/^\d+\.\s*/, '') // Убираем порядковый номер в начале (например, "1. Жим в тренажере")
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractPeriodization(workoutTitle) {
  const t = String(workoutTitle || '').toLowerCase();

  // 1. Определение сплита (А или Б)
  let splitDay = 'А';
  if (t.includes('б') || t.includes('b')) {
    splitDay = 'Б';
  }

  // 2. Режим тренировки (с поддержкой русских терминов разгрузки)
  let cycleMode = 'Сила';
  if (t.includes('делоад') || t.includes('deload') || t.includes('разгруз')) {
    cycleMode = 'Делоад';
  } else if (t.includes('объем') || t.includes('volume') || t.includes('об.')) {
    cycleMode = 'Объем';
  }

  // 3. Номер волны
  let waveIndex = '1';
  const waveMatch = t.match(/[абab](\d+)/i) || t.match(/волна\s*(\d+)/i);
  if (waveMatch) {
    waveIndex = waveMatch[1];
  } else if (t.includes('2')) {
    waveIndex = '2';
  }

  // 4. Неделя цикла (1..5)
  let cycleWeek = 1;
  if (cycleMode === 'Делоад') {
    cycleWeek = 5;
    waveIndex = 'Делоад';
  } else if (waveIndex === '1' && cycleMode === 'Сила') {
    cycleWeek = 1;
  } else if (waveIndex === '1' && cycleMode === 'Объем') {
    cycleWeek = 2;
  } else if (waveIndex === '2' && cycleMode === 'Сила') {
    cycleWeek = 3;
  } else if (waveIndex === '2' && cycleMode === 'Объем') {
    cycleWeek = 4;
  }

  return { splitDay, cycleMode, waveIndex, cycleWeek };
}

export function parseGymUpReport(text) {
  const rawLines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let title = 'Тренировка';
  let date = '';
  let startTime = '';
  const sets = [];
  const allExercises = [];

  let currentExercise = '';
  let setCounter = 1;

  // 1. Извлечение даты, времени и названия из шапки отчета
  let startIndex = 0;
  if (rawLines.length > 0) {
    const firstLine = rawLines[0];

    // Формат 1: GymUp с датой в первой строке: "28.09.2026, 21:58"
    const dateMatch = firstLine.match(/^(\d{2}\.\d{2}\.\d{4})(?:,\s*(\d{1,2}:\d{2}))?/);
    if (dateMatch) {
      date = dateMatch[1];
      startTime = dateMatch[2] || '';
      startIndex = 1;
      if (rawLines[1] && !rawLines[1].includes('•') && !rawLines[1].match(/^\d+\./)) {
        title = rawLines[1];
        startIndex = 2;
      }
    } else if (firstLine.includes('—')) {
      // Формат 2: Классический: "Тренировка — 28.09.2026 21:58"
      const parts = firstLine.split('—').map(p => p.trim());
      title = parts[0] || 'Тренировка';
      const dtParts = (parts[1] || '').split(' ');
      date = dtParts[0] || '';
      startTime = dtParts[1] || '';
      startIndex = 1;
    }
  }

  for (let i = startIndex; i < rawLines.length; i++) {
    const line = rawLines[i];

    // 2. Игнорирование служебного мусора GymUp
    if (
      line.startsWith('http') ||
      line.match(/^\d{1,2}:\d{2}\/\d{1,2}:\d{2}/) || // Тайминги отдыха вида 01:20/03:00/04:00
      line.match(/^\d+\.?\d*\s*т\s*•/i) ||          // Сводка тоннажа упражнения "8.56 т • 6 / 88"
      line.match(/^\d+\s*\/\s*\d+$/) ||              // "0 / 0" для пропущенных упражнений
      line.toLowerCase().includes('тренировка завершена') ||
      line.match(/^\d{2}:\d{2}:\d{2}\s*•/)           // Общее время тренировки "01:20:13 • 30.61 т"
    ) {
      continue;
    }

    // 3. Распознавание строки с названием упражнения
    // Обычно начинается с "1. ", "2. " либо просто текст без веса/повторов
    const isExerciseHeader = line.match(/^\d+\.\s+([^\d•].+)$/) || 
      (!line.match(/^\d+\./) && !line.includes('кг') && !line.match(/[xхXХ]/) && !line.includes('•') && line.length > 2);

    if (isExerciseHeader && !line.includes('Размин.') && !line.includes('Высокое') && !line.includes('Максим.')) {
      currentExercise = normalizeExerciseName(line);
      if (!allExercises.includes(currentExercise)) {
        allExercises.push(currentExercise);
      }
      setCounter = 1;
      continue;
    }

    // 4. Парсинг строки подхода
    // Поддержка:
    // "1. 40кг • 20x • Размин. • +5"
    // "3. 120кг • 15x • Высокое • +3 высота 4"
    // "4. 100/80кг • 6+6x • Высокое"
    // "100 кг x 10 (Высокое, +2)"
    const setRegex = /^(?:\d+\.\s*)?([\d\.,\/]+)\s*(?:кг)?\s*[•\s]*\s*([0-9\+]+)\s*[xхXХ](.*)$/i;
    const match = line.match(setRegex);

    if (match && currentExercise) {
      const rawWeightStr = match[1].replace(',', '.');
      const isDropByWeight = rawWeightStr.includes('/');
      // Базовый стартовый вес
      const weight = parseFloat(rawWeightStr.split('/')[0]) || 0;
      const repsRaw = match[2];

      // Суммирование составных повторений кластера
      let reps = 0;
      const isClusterByReps = repsRaw.includes('+');
      if (isClusterByReps) {
        reps = repsRaw.split('+').reduce((acc, val) => acc + (parseInt(val, 10) || 0), 0);
      } else {
        reps = parseInt(repsRaw, 10) || 0;
      }

      const metaRaw = match[3] || '';
      // Токенизация: разделение по буллетам "•" или запятым в скобках
      const metaTokens = metaRaw
        .replace(/[()]/g, '')
        .split(/[•,]/)
        .map(t => t.trim())
        .filter(Boolean);

      let effort = 'Среднее';
      let reserve = '';
      let method = '';
      let equipment = '';
      let positioning = '';
      const notesArr = [];

      // Анализ токенов мета-данных
      metaTokens.forEach(token => {
        const lower = token.toLowerCase();

        if (token.startsWith('+') && !isNaN(parseInt(token.replace('+', ''), 10))) {
          reserve = token;
        } else if (['максим.', 'максим', 'высокое', 'среднее', 'низкое', 'размин.', 'размин'].includes(lower)) {
          if (lower.startsWith('размин')) effort = 'Размин.';
          else if (lower.startsWith('максим')) effort = 'Максим.';
          else if (lower.startsWith('высок')) effort = 'Высокое';
          else if (lower.startsWith('средн')) effort = 'Среднее';
          else if (lower.startsWith('низк')) effort = 'Низкое';
        } else if (lower.includes('кластер') || lower.includes('cluster')) {
          method = token; // например, "кластер 1/3" или "кластер 1"
        } else if (lower.includes('дроп') || lower.includes('drop')) {
          method = token; // например, "дроп-сет 1/2"
        } else if (lower.includes('высота') || lower.includes('наклон') || lower.includes('постановка')) {
          equipment = token;
        } else if (lower.includes('сидя') || lower.includes('стоя') || lower.includes('лежа') || lower.includes('лёжа')) {
          positioning = token;
        } else {
          notesArr.push(token);
        }
      });

      // Автоматическое выставление метода для инлайн-записей
      if (!method) {
        if (isDropByWeight) method = 'Дроп-сет';
        else if (isClusterByReps) method = 'Кластер';
        else if (notesArr.some(n => n.toLowerCase().includes('кластер'))) method = 'Кластер';
        else if (notesArr.some(n => n.toLowerCase().includes('дроп'))) method = 'Дроп-сет';
      }

      if (notesArr.length > 0 && !equipment) {
        equipment = notesArr.join('; ');
      }

      const period = extractPeriodization(title);
      const isWarmupEffort = effort === 'Размин.' || method.toLowerCase().includes('размин') || method.toLowerCase().includes('подвод');
      const category = isWarmupEffort ? 'Разминка' : 'Рабочий';

      const tonnage = parseFloat((weight * reps).toFixed(1));
      const e1rm = category === 'Рабочий' && reps > 0
        ? parseFloat((weight * (1 + reps / 30)).toFixed(1))
        : 0.0;

      sets.push({
        id: `set_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`,
        date: date,
        startTime: startTime,
        title: title,
        exercise: currentExercise,
        setNum: setCounter++,
        weight: weight,
        reps: reps,
        effort: effort,
        reserve: reserve,
        method: method,
        equipment: equipment,
        positioning: positioning,
        splitDay: period.splitDay,
        cycleMode: period.cycleMode,
        waveIndex: period.waveIndex,
        cycleWeek: period.cycleWeek,
        category: category,
        tonnage: tonnage,
        e1rm: e1rm,
        syncStatus: 'pending'
      });
    }
  }

  return { title, date, startTime, sets, allExercises };
}
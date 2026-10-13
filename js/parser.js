/**
 * Парсер отчетов GymUp и DUP-периодизации
 * Поддержка нативного формата GymUp (•), составных повторений (кластеры), дроп-сетов, дробных весов и заметок
 */

export function normalizeExerciseName(rawName) {
  if (!rawName) return '';
  return String(rawName)
    .replace(/^\d+\.\s*/, '') // Снятие порядкового номера (например, "1. Жим в тренажере")
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Детерминированное извлечение метаданных DUP-периодизации с изоляцией токенов
 */
export function extractPeriodization(workoutTitle) {
  const t = String(workoutTitle || '').toLowerCase();

  // 1. Определение сплита: строгая изоляция буквы 'Б' (не реагирует на слово «Объем»)
  let splitDay = 'А';
  if (/(?<![а-яёa-z])[бb](?![а-яёa-z])/i.test(t)) {
    splitDay = 'Б';
  }

  // 2. Режим тренировки
  let cycleMode = 'Сила';
  if (t.includes('делоад') || t.includes('deload') || t.includes('разгруз')) {
    cycleMode = 'Делоад';
  } else if (t.includes('объем') || t.includes('volume') || t.includes('об.')) {
    cycleMode = 'Объем';
  }

  // 3. Номер волны: вырезаем токен цикла (C-2, Ц-1) во избежание ложной волны
  const tClean = t.replace(/[cсц]-\d+/gi, ' ').replace(/[-_]/g, ' ');
  let waveIndex = '1';
  const waveMatch = tClean.match(/волна\s*(\d+)/i) || tClean.match(/(?<![а-яёa-z])[абab](\d+)/i);
  if (waveMatch) {
    waveIndex = waveMatch[1];
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
  let exerciseSetCounter = 1;
  let totalSetsParsedCount = 0;

  // 1. Извлечение даты, времени и названия из шапки отчета
  let startIndex = 0;
  if (rawLines.length > 0) {
    const firstLine = rawLines[0];

    // Формат GymUp с датой в первой строке: "28.09.2026, 21:58"
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
      // Формат классический: "Тренировка — 28.09.2026 21:58"
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

    // 2. Игнорирование служебных строк GymUp
    if (
      line.startsWith('http') ||
      line.match(/^\d{1,2}:\d{2}\/\d{1,2}:\d{2}/) || // Тайминги отдыха 01:20/03:00
      line.match(/^\d+\.?\d*\s*т\s*•/i) ||          // Сводка тоннажа "8.56 т • 6 / 88"
      line.match(/^\d+\s*\/\s*\d+$/) ||              // "0 / 0"
      line.toLowerCase().includes('тренировка завершена') ||
      line.match(/^\d{2}:\d{2}:\d{2}\s*•/)           // Время сессии "01:20:13 • 30.61 т"
    ) {
      continue;
    }

    // 3. Распознавание строки с названием упражнения
    const isWeightLine = line.match(/\d+\s*(?:кг)?\s*[•\s]+\s*\d+\s*[xхXХ]/i);
    const isNumberedHeader = line.match(/^\d+\.\s+([^\d•].+)$/);
    const isExerciseHeader = isNumberedHeader || (!line.match(/^\d+\./) && !line.includes('кг') && !isWeightLine && !line.includes('•') && line.length > 2);

    if (isExerciseHeader && !line.includes('Размин.') && !line.includes('Высокое') && !line.includes('Максим.')) {
      currentExercise = normalizeExerciseName(line);
      if (!allExercises.includes(currentExercise)) {
        allExercises.push(currentExercise);
      }
      exerciseSetCounter = 1;
      continue;
    }

    // 4. Парсинг строки подхода
    const setRegex = /^(?:\d+\.\s*)?([\d\.,\/]+)\s*(?:кг)?\s*[•\s]*\s*([0-9\+]+)\s*[xхXХ](.*)$/i;
    const match = line.match(setRegex);

    if (match && currentExercise) {
      const rawWeightStr = match[1].replace(',', '.');
      const isDropByWeight = rawWeightStr.includes('/');
      const weight = parseFloat(rawWeightStr.split('/')[0]) || 0;
      const repsRaw = match[2];

      // Суммирование повторений для тоннажа и изоляция первого сегмента для 1ПМ
      let reps = 0;
      let firstSegmentReps = 0;
      const isClusterByReps = repsRaw.includes('+');
      
      if (isClusterByReps) {
        const segments = repsRaw.split('+').map(val => parseInt(val, 10) || 0);
        firstSegmentReps = segments[0] || 0;
        reps = segments.reduce((acc, val) => acc + val, 0);
      } else {
        reps = parseInt(repsRaw, 10) || 0;
        firstSegmentReps = reps;
      }

      const metaRaw = match[3] || '';
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

      metaTokens.forEach(token => {
        const lower = token.toLowerCase();

        // Запас RIR
        const rirMatch = token.match(/^\+(\d+)(?:\s+(.*))?$/);
        if (rirMatch) {
          reserve = `+${rirMatch[1]}`;
          if (rirMatch[2] && rirMatch[2].trim()) {
            notesArr.push(rirMatch[2].trim());
          }
          return;
        }

        // Оценка усилия
        if (['максим.', 'максим', 'высокое', 'среднее', 'низкое', 'размин.', 'размин'].includes(lower)) {
          if (lower.startsWith('размин')) effort = 'Размин.';
          else if (lower.startsWith('максим')) effort = 'Максим.';
          else if (lower.startsWith('высок')) effort = 'Высокое';
          else if (lower.startsWith('средн')) effort = 'Среднее';
          else if (lower.startsWith('низк')) effort = 'Низкое';
          return;
        }

        // Специальные методы
        if (lower.includes('кластер') || lower.includes('cluster')) {
          method = token;
          return;
        }
        if (lower.includes('дроп') || lower.includes('drop')) {
          method = token;
          return;
        }

        // Оборудование
        if (lower.includes('высота') || lower.includes('наклон') || lower.includes('постановка')) {
          equipment = token;
          return;
        }

        // Положение
        if (lower.includes('сидя') || lower.includes('стоя') || lower.includes('лежа') || lower.includes('лёжа')) {
          positioning = token;
          return;
        }

        notesArr.push(token);
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
      } else if (notesArr.length > 0 && equipment) {
        equipment = `${equipment}; ${notesArr.join('; ')}`;
      }

      const period = extractPeriodization(title);
      const isWarmupEffort = effort === 'Размин.' || method.toLowerCase().includes('размин') || method.toLowerCase().includes('подвод');
      const category = isWarmupEffort ? 'Разминка' : 'Рабочий';

      const tonnage = parseFloat((weight * reps).toFixed(1));

      // Биомеханически корректный расчет 1ПМ по формуле Эпли:
      // Для кластеров расчет ведется СТРОГО по первому непрерывному сегменту повторений
      let e1rm = 0.0;
      if (category === 'Рабочий' && firstSegmentReps > 0 && weight > 0) {
        e1rm = firstSegmentReps === 1 ? weight : parseFloat((weight * (1 + firstSegmentReps / 30)).toFixed(1));
      }

      totalSetsParsedCount++;
      const currentSetNum = exerciseSetCounter++;
      // Уникальный ID, защищенный от дублирования при повторе упражнения в сессии
      const setId = `${date}_${startTime}_${currentExercise}_set${currentSetNum}_idx${totalSetsParsedCount}`;

      sets.push({
        id: setId,
        date: date,
        startTime: startTime,
        title: title,
        exercise: currentExercise,
        setNum: currentSetNum,
        weight: weight,
        reps: reps,
        firstSegmentReps: firstSegmentReps,
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
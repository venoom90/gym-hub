/**
 * Парсер отчетов GymUp и периодизации тренировочной программы
 * Поддержка составных повторений (дроп-сеты/кластеры), нормализация строк и русских терминов
 */

export function normalizeExerciseName(rawName) {
  if (!rawName) return '';
  return String(rawName)
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
  } else if (t.includes('объем') || t.includes('volume')) {
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
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);

  let title = 'Тренировка';
  let date = '';
  let startTime = '';
  const sets = [];
  const allExercises = [];

  let currentExercise = '';
  let setCounter = 1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Парсинг заголовка и даты
    if (i === 0 && line.includes('—')) {
      const parts = line.split('—').map(p => p.trim());
      title = parts[0] || 'Тренировка';
      const dtParts = (parts[1] || '').split(' ');
      date = dtParts[0] || '';
      startTime = dtParts[1] || '';
      continue;
    }

    // Определение строки с наименованием упражнения
    if (!line.startsWith('#') && !line.match(/^\d+[\s\t]+x[\s\t]+\d+/i) && !line.includes('кг x') && !line.includes('кг х')) {
      if (line.length > 2 && !line.toLowerCase().includes('тренировка завершена')) {
        currentExercise = normalizeExerciseName(line);
        if (!allExercises.includes(currentExercise)) {
          allExercises.push(currentExercise);
        }
        setCounter = 1;
        continue;
      }
    }

    // Парсинг строки подхода с поддержкой составных повторений: 100 кг x 6+4 или 80 кг x 12 (Среднее, +2)
    const setMatch = line.match(/^(\d+[\.,]?\d*)\s*(?:кг)?\s*[xх]\s*([\d\+]+)(.*)$/i);
    if (setMatch && currentExercise) {
      const weight = parseFloat(setMatch[1].replace(',', '.'));
      const repsRaw = setMatch[2];

      // Суммирование составных повторений (кластеры, дроп-сеты)
      let reps = 0;
      if (repsRaw.includes('+')) {
        reps = repsRaw.split('+').reduce((acc, val) => acc + (parseInt(val, 10) || 0), 0);
      } else {
        reps = parseInt(repsRaw, 10) || 0;
      }

      const metaPart = setMatch[3] || '';

      let effort = 'Среднее';
      let reserve = '';
      let method = '';
      let equipment = '';
      let positioning = '';

      if (metaPart.includes('(')) {
        const metaClean = metaPart.replace(/[()]/g, '').trim();
        const tags = metaClean.split(',').map(t => t.trim());

        tags.forEach(tag => {
          if (tag.startsWith('+')) {
            reserve = tag;
          } else if (['Максим.', 'Высокое', 'Среднее', 'Низкое', 'Размин.'].includes(tag)) {
            effort = tag;
          } else if (tag.includes('высота') || tag.includes('наклон')) {
            equipment = tag;
          } else if (tag.toLowerCase().includes('сидя') || tag.toLowerCase().includes('стоя')) {
            positioning = tag;
          } else {
            method = tag;
          }
        });
      }

      const period = extractPeriodization(title);
      const category = (effort === 'Размин.' || method.toLowerCase().includes('размин') || method.toLowerCase().includes('подвод'))
        ? 'Разминка'
        : 'Рабочий';

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

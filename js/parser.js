/**
 * Парсер отчетов GymUp и периодизации тренировочной программы
 * Поддерживает оба формата отчетов: с тире ("Название — ДД.ММ.ГГГГ ЧЧ:ММ") 
 * и новый двухстрочный формат GymUp ("ДД.ММ.ГГГГ, ЧЧ:ММ" + строка названия + "•").
 */

export function normalizeExerciseName(rawName) {
  if (!rawName) return '';
  return String(rawName)
    .replace(/^\d+\.\s*/, '') // убираем нумерацию упражнения "1. Сведение рук..." -> "Сведение рук..."
    .replace(/\u00A0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function extractPeriodization(workoutTitle) {
  const t = String(workoutTitle || '').toLowerCase();

  let splitDay = 'А';
  if (t.includes('б') || t.includes('b')) {
    splitDay = 'Б';
  }

  let cycleMode = 'Сила';
  if (t.includes('делоад') || t.includes('deload') || t.includes('разгруз')) {
    cycleMode = 'Делоад';
  } else if (t.includes('объем') || t.includes('volume') || t.includes('об.')) {
    cycleMode = 'Объем';
  }

  let waveIndex = '1';
  const waveMatch = t.match(/[абab](\d+)/i) || t.match(/волна\s*(\d+)/i);
  if (waveMatch) {
    waveIndex = waveMatch[1];
  } else if (t.includes('2')) {
    waveIndex = '2';
  }

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

    // 1. Формат шапки 1: "08.10.2026, 22:19"
    const dtMatch = line.match(/^(\d{1,2}\.\d{1,2}\.\d{4}),?\s*(\d{1,2}:\d{2})/);
    if (dtMatch && !date) {
      date = dtMatch[1];
      startTime = dtMatch[2];
      if (lines[i + 1] && !lines[i + 1].includes('•') && !lines[i + 1].includes('http')) {
        title = lines[i + 1].trim();
        i++; // пропускаем строку названия
      }
      continue;
    }

    // 2. Формат шапки 2: "Тренировка А — 05.10.2026 22:19"
    if (i === 0 && line.includes('—')) {
      const parts = line.split('—').map(p => p.trim());
      title = parts[0] || 'Тренировка';
      const dtParts = (parts[1] || '').split(' ');
      date = dtParts[0] || '';
      startTime = dtParts[1] || '';
      continue;
    }

    // Пропуск служебных строк (таймеры, суммарный тоннаж, ссылки)
    if (line.includes('•') && (line.includes(' т ') || line.includes(' / ') || line.endsWith('%'))) {
      continue;
    }
    if (line.match(/^\d{2}:\d{2}\/\d{2}:\d{2}/) || line === '0 / 0' || line.startsWith('http')) {
      continue;
    }

    // Определение строки с названием упражнения (например, "1. Сведение рук в тренажере (Бабочка)")
    const isExerciseHeader = !line.match(/^\d+\.\s*[\d\.,\/]+\s*кг/i) && 
                             !line.match(/^[\d\.,\/]+\s*кг/i) &&
                             !line.includes('x •') &&
                             !line.includes('х •');

    if (isExerciseHeader && line.length > 2) {
      currentExercise = normalizeExerciseName(line);
      if (!allExercises.includes(currentExercise)) {
        allExercises.push(currentExercise);
      }
      setCounter = 1;
      continue;
    }

    // Парсинг строки подхода
    // Поддерживает форматы:
    // "1. 35кг • 15x • Размин."
    // "2. 67.5кг • 8x • Низкое • +7"
    // "100 кг x 10 (Высокое, +2)"
    let cleanLine = line.replace(/^\d+\.\s*/, ''); // убираем номер подхода в начале строки
    
    // Вариант А: GymUp с маркерами '•'
    if (cleanLine.includes('•') && cleanLine.includes('кг')) {
      const parts = cleanLine.split('•').map(p => p.trim());
      const weightMatch = parts[0].match(/([\d\.,\/]+)\s*кг/i);
      const repsMatch = parts[1] ? parts[1].match(/([\d\+]+)\s*[xх]/i) : null;

      if (weightMatch && repsMatch && currentExercise) {
        const rawWeightStr = weightMatch[1].replace(',', '.');
        const weight = parseFloat(rawWeightStr.split('/')[0]) || 0;
        
        let reps = 0;
        const repsRaw = repsMatch[1];
        if (repsRaw.includes('+')) {
          reps = repsRaw.split('+').reduce((acc, v) => acc + (parseInt(v, 10) || 0), 0);
        } else {
          reps = parseInt(repsRaw, 10) || 0;
        }

        let effort = 'Среднее';
        let reserve = '';
        let method = '';
        let equipment = '';
        let positioning = '';

        for (let pIdx = 2; pIdx < parts.length; pIdx++) {
          const tag = parts[pIdx];
          if (tag.startsWith('+')) {
            reserve = tag;
          } else if (['Максим.', 'Высокое', 'Среднее', 'Низкое', 'Размин.'].includes(tag)) {
            effort = tag;
          } else if (tag.toLowerCase().includes('высота') || tag.toLowerCase().includes('наклон')) {
            equipment = tag;
          } else if (tag.toLowerCase().includes('сидя') || tag.toLowerCase().includes('стоя')) {
            positioning = tag;
          } else {
            method = tag;
          }
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
      continue;
    }

    // Вариант Б: Стандартный текстовый лог "100 кг x 10 (Высокое, +2)"
    const setMatch = cleanLine.match(/^([\d\.,\/]+)\s*(?:кг)?\s*[xх]\s*([\d\+]+)(.*)$/i);
    if (setMatch && currentExercise) {
      const rawWeightStr = setMatch[1].replace(',', '.');
      const weight = parseFloat(rawWeightStr.split('/')[0]) || 0;
      
      let reps = 0;
      const repsRaw = setMatch[2];
      if (repsRaw.includes('+')) {
        reps = repsRaw.split('+').reduce((acc, v) => acc + (parseInt(v, 10) || 0), 0);
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
          } else if (tag.toLowerCase().includes('высота') || tag.toLowerCase().includes('наклон')) {
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
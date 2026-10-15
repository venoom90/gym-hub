import { state, parseRuFloat, formatDateDisplay } from './state.js';

const EQUIP_KEYWORDS = ['Тренажер', 'Штанга', 'Гантели', 'Блок', 'Смит', 'Свободный вес', 'Свой вес', 'Гриф', 'Рукоять', 'Канат', 'Лента', 'Диск'];

export function extractPeriodization(workoutTitle) {
  const t = String(workoutTitle || '').toLowerCase();

  let splitDay = 'А';
  if (/(?<![а-яёa-z])[бb](?![а-яёa-z])/i.test(t)) {
    splitDay = 'Б';
  }

  let cycleMode = 'Сила';
  if (t.includes('делоад') || t.includes('deload') || t.includes('разгруз')) {
    cycleMode = 'Делоад';
  } else if (t.includes('объем') || t.includes('объём') || t.includes('volume') || t.includes('об.')) {
    cycleMode = 'Объем';
  }

  const tClean = t.replace(/[cсц]-\d+/gi, ' ').replace(/[-_]/g, ' ');
  let waveIndex = '1';
  const waveMatch = tClean.match(/волна\s*(\d+)/i) || tClean.match(/(?<![а-яёa-z])[абab](\d+)/i);
  if (waveMatch) {
    waveIndex = waveMatch[1];
  }

  let cycleWeek = 1;
  let repRange = '4-6';

  if (cycleMode === 'Делоад') {
    cycleWeek = 5;
    waveIndex = 'Делоад';
    repRange = '8-10';
  } else if (waveIndex === '1' && cycleMode === 'Сила') {
    cycleWeek = 1;
    repRange = '4-6';
  } else if (waveIndex === '1' && cycleMode === 'Объем') {
    cycleWeek = 2;
    repRange = '12-16';
  } else if (waveIndex === '2' && cycleMode === 'Сила') {
    cycleWeek = 3;
    repRange = '4-6';
  } else if (waveIndex === '2' && cycleMode === 'Объем') {
    cycleWeek = 4;
    repRange = '12-16';
  }

  let cycleId = state.dbData.currentCycleId || 'C-1';
  const cMatch = String(workoutTitle || '').match(/[CcСсЦц]-(\d+)/i);
  if (cMatch) {
    cycleId = `C-${cMatch[1]}`;
  }

  return {
    splitDay,
    cycleMode,
    waveIndex,
    cycleWeek,
    repRange,
    cycleId
  };
}

export function parseGymUpReport(text) {
  const lines = String(text || '')
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  let workoutTitle = 'Тренировка';
  let workoutDate = '';
  let startTime = '';

  if (lines.length > 0) {
    workoutTitle = lines[0];
  }

  if (lines.length > 1) {
    const dtMatch = lines[1].match(/(\d{2}\.\d{2}\.\d{4})\s*в\s*(\d{2}:\d{2})/) || lines[1].match(/(\d{2}\.\d{2}\.\d{4})(?:.*?(\d{2}:\d{2}))?/);
    if (dtMatch) {
      workoutDate = formatDateDisplay(dtMatch[1]);
      startTime = dtMatch[2] || '12:00';
    }
  }

  const period = extractPeriodization(workoutTitle);
  const parsedSets = [];
  const allExercises = [];

  let currentExercise = '';
  let currentEquip = '';
  let currentPositioning = '';
  let setCounter = 1;
  let globalIdx = 0;

  for (let i = 2; i < lines.length; i++) {
    const line = lines[i];

    // 1. Метаданные упражнения и заметок с разделителем '•'
    if (line.includes('•')) {
      const parts = line.split('•').map(s => s.trim()).filter(Boolean);
      const eqFound = [];
      const posFound = [];

      parts.forEach(p => {
        if (EQUIP_KEYWORDS.some(k => p.toLowerCase().includes(k.toLowerCase()))) {
          eqFound.push(p);
        } else {
          posFound.push(p);
        }
      });

      if (eqFound.length) currentEquip = eqFound.join(', ');
      if (posFound.length) currentPositioning = posFound.join(', ');
      continue;
    }

    // 2. Название упражнения (строка без цифр в начале, без 'кг' и '•')
    if (
      !/^\d/.test(line) &&
      !line.includes('кг') &&
      !line.includes('•') &&
      line.length > 2 &&
      !['Размин.', 'Высокое', 'Максим.', 'Среднее', 'Легкое'].some(w => line.includes(w))
    ) {
      currentExercise = line.replace(/^\d+[.)]\s*/, '').trim();
      if (currentExercise && !allExercises.includes(currentExercise)) {
        allExercises.push(currentExercise);
      }
      currentEquip = '';
      currentPositioning = '';
      setCounter = 1;
      continue;
    }

    // 3. Строка подхода в оригинальном формате GymUp (например: "130 кг 6x Высокое +1", "100/75 6x", "130 кг 4+3+2x")
    const setRegex = /^([\d.,\/]+)\s*(?:кг)?\s+([\d+\/]+)\s*[xх×]\s*(.*)$/i;
    const match = line.match(setRegex);

    if (match && currentExercise) {
      const weightRaw = match[1];
      const repsRaw = match[2];
      const restOfLine = (match[3] || '').trim();

      // Разбор весов (исправление строки 136: сохраняем и основной вес, и вес сброса на дроп-сете)
      const weightParts = weightRaw.split('/').map(w => parseRuFloat(w)).filter(w => w > 0);
      const cleanWeight = weightParts[0] || 0;

      let totalReps = 0;
      let firstSegmentReps = 0;
      let dropWeight = 0;
      let dropReps = 0;
      let method = 'Стандарт';

      if (repsRaw.includes('+')) {
        const segments = repsRaw.split('+').map(n => parseInt(n, 10) || 0).filter(n => n > 0);
        firstSegmentReps = segments[0] || 0;
        totalReps = segments.reduce((a, b) => a + b, 0);
        method = `Кластер (${repsRaw})`;
      } else if (repsRaw.includes('/') || weightRaw.includes('/')) {
        const segments = repsRaw.split('/').map(n => parseInt(n, 10) || 0).filter(n => n > 0);
        firstSegmentReps = segments[0] || 0;

        if (weightParts.length > 1 && segments.length === 1) {
          // Формат GymUp "100/75 6x": основной подход 100х6 + дожим 75х6
          totalReps = firstSegmentReps;
          dropWeight = weightParts[1];
          dropReps = firstSegmentReps;
        } else {
          totalReps = firstSegmentReps;
          dropWeight = weightParts[1] !== undefined ? weightParts[1] : parseFloat((cleanWeight * 0.75).toFixed(1));
          dropReps = segments[1] !== undefined ? segments[1] : firstSegmentReps;
        }
        method = 'Дроп-сет';
      } else {
        totalReps = parseInt(repsRaw, 10) || 0;
        firstSegmentReps = totalReps;
      }

      let effort = 'Не указано';
      let reserve = '';

      const effortMatch = restOfLine.match(/(Размин\.|Легкое|Среднее|Высокое|Максим\.)/i);
      if (effortMatch) {
        effort = effortMatch[1];
      }

      const reserveMatch = restOfLine.match(/(\+\d+(?:[.,]\d+)?)/);
      if (reserveMatch) {
        reserve = reserveMatch[1].replace(',', '.');
      }

      if (/отдых[\s-]*пауза/i.test(restOfLine)) method = 'Отдых-пауза';
      else if (/дроп/i.test(restOfLine)) method = 'Дроп-сет';
      else if (/кластер/i.test(restOfLine) && !method.startsWith('Кластер')) method = 'Кластер';

      const isWarmup = (effort === 'Размин.' || method.toLowerCase().includes('размин'));
      const category = isWarmup ? 'Разминка' : 'Рабочий';

      const baseTonnage = cleanWeight * totalReps;
      const bonusDropTonnage = (dropWeight > 0 && dropReps > 0) ? (dropWeight * dropReps) : 0;
      const tonnage = parseFloat((baseTonnage + bonusDropTonnage).toFixed(1));

      // Исправление по аудиту: расчет 1ПМ строго при firstSegmentReps <= 8
      let e1rm = 0.0;
      if (category === 'Рабочий' && firstSegmentReps > 0 && firstSegmentReps <= 8 && cleanWeight > 0) {
        e1rm = firstSegmentReps === 1
          ? cleanWeight
          : parseFloat((cleanWeight * (1 + firstSegmentReps / 30)).toFixed(1));
      }

      globalIdx++;
      const uniqueId = `${workoutDate}_${startTime}_${currentExercise}_set${setCounter}_idx${globalIdx}`;

      parsedSets.push({
        id: uniqueId,
        date: workoutDate,
        startTime: startTime,
        title: workoutTitle,
        exercise: currentExercise,
        setNum: setCounter++,
        weight: cleanWeight,
        reps: totalReps,
        firstSegmentReps: firstSegmentReps,
        dropWeight: dropWeight,
        dropReps: dropReps,
        effort: effort,
        reserve: isWarmup ? '' : reserve,
        method: method,
        equipment: currentEquip,
        positioning: currentPositioning,
        splitDay: period.splitDay,
        cycleMode: period.cycleMode,
        waveIndex: period.waveIndex,
        cycleWeek: period.cycleWeek,
        repRange: period.repRange,
        cycleId: period.cycleId,
        category: category,
        tonnage: tonnage,
        e1rm: e1rm,
        syncStatus: 'pending'
      });
    }
  }

  return {
    title: workoutTitle,
    date: workoutDate,
    startTime: startTime,
    sets: parsedSets,
    allExercises: allExercises
  };
}
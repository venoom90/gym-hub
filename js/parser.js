export function extractPeriodization(title) {
  let clean = String(title || '').trim();
  clean = clean.replace(/^тренировка\s*/i, '').trim();

  let splitDay = 'А';
  let cycleMode = 'Сила';
  let waveIndex = '1';
  let cycleWeek = 1;
  let targetRepsRange = '4-6';

  const codeMatch = clean.match(/([АБAB])\s*([12])?/i);
  if (codeMatch) {
    let day = codeMatch[1].toUpperCase();
    if (day === 'A') day = 'А';
    if (day === 'B') day = 'Б';
    splitDay = day;
    waveIndex = codeMatch[2] || '1';
  }

  const lower = clean.toLowerCase();
  if (lower.includes('делоад') || lower.includes('разгруз') || lower.includes('восст')) {
    cycleMode = 'Делоад';
    waveIndex = 'Делоад';
    cycleWeek = 5;
    targetRepsRange = '8-10';
  } else if (lower.includes('объем') || lower.includes('об')) {
    cycleMode = 'Объем';
    targetRepsRange = '12-16';
    cycleWeek = (waveIndex === '2') ? 4 : 2;
  } else {
    cycleMode = 'Сила';
    targetRepsRange = '4-6';
    cycleWeek = (waveIndex === '2') ? 3 : 1;
  }

  return { splitDay, cycleMode, waveIndex, cycleWeek, targetRepsRange };
}

export function determineSetCategory(effort, method) {
  const m = String(method || '').toLowerCase();
  const e = String(effort || '').toLowerCase();
  if (m.includes('подвод')) return 'Подводка';
  if (e.includes('размин') || m.includes('размин')) return 'Разминка';
  return 'Рабочий';
}

export function calculateEpley1RM(weight, reps, category) {
  if (category !== 'Рабочий' || !weight || weight <= 0 || !reps || reps <= 0) return 0;
  if (reps === 1) return weight;
  return parseFloat((weight * (1 + reps / 30)).toFixed(1));
}

export function parseGymUpReport(text) {
  const lines = text.split(/\r?\n/);
  const result = {
    title: '',
    date: '',
    startTime: '',
    sets: [],
    allExercises: []
  };

  let currentExercise = '';
  let setId = 0;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    if (/^\d{2}\.\d{2}\.\d{4}/.test(trimmed)) {
      const parts = trimmed.split(',');
      result.date = parts[0].trim();
      result.startTime = parts[1] ? parts[1].trim() : '';
      if (i + 1 < lines.length) {
        result.title = lines[i + 1].trim();
        i++;
      }
      continue;
    }

    if (/^\d{2}:\d{2}\/\d{2}:\d{2}\/\d{2}:\d{2}/.test(trimmed) || trimmed === '0 / 0') {
      continue;
    }

    if (trimmed.includes('•') && (trimmed.includes(' т ') || trimmed.includes('%') || /^\d{2}:\d{2}:\d{2}/.test(trimmed))) {
      continue;
    }

    const setRegex = /^\s*(\d+)\.\s+(\d+(?:\.\d+)?)\s*кг\s*•\s*(\d+)\s*x(?:\s*•\s*([^•]+))?(?:\s*•\s*(.*))?$/i;
    const setMatch = trimmed.match(setRegex);

    if (setMatch && currentExercise) {
      const setNum = setMatch[1];
      const weight = setMatch[2];
      const reps = setMatch[3];
      let effort = (setMatch[4] || '').trim();
      let rawComment = (setMatch[5] || '').trim();

      let reserve = '', method = '', equipment = '', positioning = '';

      if (/^[+-]\d+$/.test(effort)) {
        reserve = effort;
        effort = 'Без оценки';
      }

      if (rawComment) {
        const resMatch = rawComment.match(/([+-]\d+)/);
        if (resMatch) {
          reserve = resMatch[1];
          rawComment = rawComment.replace(resMatch[0], '').trim();
        }

        const lower = rawComment.toLowerCase();
        if (lower.includes('кластер')) {
          const cm = rawComment.match(/(кластер\s*\d*[^.А-Яа-я]*)/i);
          method = cm ? cm[0].trim() : 'Кластер';
          rawComment = rawComment.replace(/кластер\s*\d*/ig, '').trim();
        } else if (lower.includes('дроп')) {
          method = 'Дропсет';
          rawComment = rawComment.replace(/дропсет|дроп/ig, '').trim();
        } else if (lower.includes('подвод')) {
          method = 'Подводка';
          rawComment = rawComment.replace(/подводящий|подводка|подвод/ig, '').trim();
        } else if (lower.includes('замин')) {
          method = 'Заминка';
          rawComment = rawComment.replace(/заминочный|заминка|замин/ig, '').trim();
        }

        if (rawComment.toLowerCase().includes('высот')) {
          const hm = rawComment.match(/(высота\s*\d+|\d+\s*высота)/i);
          equipment = hm ? hm[0].trim() : '';
          if (hm) rawComment = rawComment.replace(hm[0], '').trim();
        }
        positioning = rawComment.replace(/^[.,\s]+|[.,\s]+$/g, '').trim();
      }

      const period = extractPeriodization(result.title);
      const weightNum = parseFloat(weight) || 0;
      const repsNum = parseInt(reps, 10) || 0;
      const category = determineSetCategory(effort, method);
      const tonnage = Math.round(weightNum * repsNum);
      const e1rm = calculateEpley1RM(weightNum, repsNum, category);

      result.sets.push({
        id: ++setId,
        date: result.date,
        startTime: result.startTime,
        title: result.title,
        exercise: currentExercise,
        setNum: setNum,
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
        targetRepsRange: period.targetRepsRange,
        category: category,
        tonnage: tonnage,
        e1rm: e1rm,
        syncStatus: 'pending'
      });
      continue;
    }

    const exMatch = trimmed.match(/^\d+\.\s+([^•]+)$/);
    if (exMatch && !trimmed.includes('кг')) {
      currentExercise = exMatch[1].trim();
      if (!result.allExercises.includes(currentExercise)) {
        result.allExercises.push(currentExercise);
      }
    }
  }

  return result;
}
/**
 * =========================================================================
 * GYM ANALYTICS HUB — VOICE COACH MODULE (V1.0.8)
 * =========================================================================
 * Голосовое сопровождение LiveWorkout через Web Speech API.
 *
 * Архитектурные инварианты (роли 1, 7):
 * - НИКОГДА не используется speechSynthesis.pause() — на Android Chrome
 *   pause() эквивалентен cancel() и завершает utterance. Только cancel().
 * - ПЕРЕД каждым speak() вызывается cancel() — иначе очередь забивается.
 * - Utterance всегда короткие (< 200 символов, < 10 сек звучания).
 * - lang = 'ru-RU' выставляется явно — на Android Chrome дефолтный язык
 *   может быть английским.
 * - При недоступности speechSynthesis — тихий console.warn, UI не падает.
 * - Никакой вибрации. Никакой предзаписи аудио.
 *
 * Каналы:
 *   A. speakAfterSet()      — после записи подхода: отдых + (маркер перехода
 *                             «разминка → рабочий») + вес + повторы + запас.
 *   B. speakRestTime()      — остаток отдыха на пороге 60/30/10.
 *   C. speakRestFinished()  — естественное завершение отдыха.
 *   C2. speakExerciseFinished() — последний подход упражнения записан.
 *   D. speakNextExercise()  — смена упражнения (с названием упражнения).
 *   E. cancelVoice()        — ручной пропуск / финиш / выключение галки.
 *
 * История:
 *   V1.0.0 — базовый модуль.
 *   V1.0.1 — канал A: убран exerciseName из фразы, добавлено
 *            «следующий вес подхода X»; RIR заменён на «запас N» /
 *            «до отказа».
 *   V1.0.2 — вес произносится словами (попытка убрать паузу на точке).
 *   V1.0.3 — вес с дробной частью: «X килограмм Y грамм» (например,
 *            82.5 → «82 килограмма 500 грамм»).
 *   V1.0.4 — пунктуация: точки между крупными блоками фразы, запятая
 *            внутри блока «повторы + запас». Маркер перехода
 *            «Следующий подход рабочий» — между блоком отдыха и блоком
 *            веса, только при переходе с разминочного сета на рабочий.
 *   V1.0.5 — экспериментальный navigator.audioSession.type = 'transient'
 *            (для ducking музыки). В зале на Android Chrome проверено:
 *            ducking не срабатывает — музыка просто накладывается. Код
 *            откачен в V1.0.6.
 *   V1.0.6 — убран audioSession (не работает). «финальный мио-репс» →
 *            «финальный мио сет» (TTS читает «мио-репс» с паузой/криво
 *            из-за дефиса).
 *   V1.0.7 — скорость речи по умолчанию поднята с 1.0 до 1.15. Цель —
 *            улучшить разборчивость на фоне музыки (короче фраза →
 *            меньше наложения). Громкость utterance.volume = 1.0 — это
 *            максимум, программно громче нельзя (ограничение спецификации
 *            SpeechSynthesis: volume ∈ [0, 1]).
 *   V1.0.8 — добавлена speakExerciseFinished() — короткое «Упражнение
 *            завершено». speakSafe получил опцию skipDebounce для
 *            мгновенного воспроизведения (чтобы фраза успела прозвучать
 *            до того, как пользователь нажмёт «Завершено» и speakNextExercise
 *            перебьёт её).
 * =========================================================================
 */

const STORAGE_KEY_VOICE_PREFS = 'gym_voice_coach_prefs_v1';

const DEFAULT_VOICE_PREFS = {
  enabled: false,
  thresholds: [60, 30, 10] // секунды; 0 = порог отключён
};

let _prefs = null;
let _debounceTimer = null;
let _lastSpokenText = '';
let _lastSpokenAtMs = 0;
let _isSupported = null;

/* ---------- PREFS ---------- */

function loadPrefs() {
  if (_prefs) return _prefs;
  try {
    const raw = localStorage.getItem(STORAGE_KEY_VOICE_PREFS);
    if (raw) {
      const parsed = JSON.parse(raw);
      _prefs = {
        enabled: Boolean(parsed.enabled),
        thresholds: Array.isArray(parsed.thresholds) && parsed.thresholds.length === 3
          ? parsed.thresholds.map(n => Math.max(0, parseInt(n, 10) || 0))
          : [...DEFAULT_VOICE_PREFS.thresholds]
      };
    } else {
      _prefs = { ...DEFAULT_VOICE_PREFS, thresholds: [...DEFAULT_VOICE_PREFS.thresholds] };
    }
  } catch (e) {
    _prefs = { ...DEFAULT_VOICE_PREFS, thresholds: [...DEFAULT_VOICE_PREFS.thresholds] };
  }
  return _prefs;
}

function savePrefs(prefs) {
  _prefs = prefs;
  try {
    localStorage.setItem(STORAGE_KEY_VOICE_PREFS, JSON.stringify(prefs));
  } catch (e) {
    console.warn('[VoiceCoach] Не удалось сохранить настройки:', e);
  }
}

export function isVoiceEnabled() {
  return loadPrefs().enabled;
}

export function setVoiceEnabled(enabled) {
  const prefs = loadPrefs();
  prefs.enabled = Boolean(enabled);
  savePrefs(prefs);
  if (!enabled) cancelVoice();
}

export function getVoiceThresholds() {
  return [...loadPrefs().thresholds];
}

export function setVoiceThresholds(thresholds) {
  const prefs = loadPrefs();
  prefs.thresholds = thresholds.map(n => Math.max(0, parseInt(n, 10) || 0));
  savePrefs(prefs);
}

/* ---------- SUPPORT / VOICE READINESS ---------- */

function isSpeechSupported() {
  if (_isSupported !== null) return _isSupported;
  _isSupported = typeof window !== 'undefined'
    && 'speechSynthesis' in window
    && typeof window.SpeechSynthesisUtterance === 'function';
  return _isSupported;
}

function pickRussianVoice() {
  try {
    const voices = window.speechSynthesis.getVoices();
    if (!Array.isArray(voices) || voices.length === 0) return null;
    return voices.find(v => v.lang === 'ru-RU')
      || voices.find(v => v.lang && v.lang.startsWith('ru'))
      || null;
  } catch (e) {
    return null;
  }
}

/* ---------- CORE SPEAK ---------- */

function speakSafe(text, opts = {}) {
  if (!isSpeechSupported()) return;
  if (!isVoiceEnabled()) return;

  const clean = String(text || '').trim();
  if (!clean) return;
  if (clean.length > 200) {
    console.warn('[VoiceCoach] Текст слишком длинный, обрезан до 200 символов.');
  }
  const finalText = clean.length > 200 ? clean.slice(0, 197) + '…' : clean;

  const now = Date.now();
  if (finalText === _lastSpokenText && (now - _lastSpokenAtMs) < 800) {
    return; // защита от дублирования в пределах 800 мс
  }
  _lastSpokenText = finalText;
  _lastSpokenAtMs = now;

  const doSpeak = () => {
    try {
      window.speechSynthesis.cancel();
      const utterance = new window.SpeechSynthesisUtterance(finalText);
      utterance.lang = 'ru-RU';
      const voice = pickRussianVoice();
      if (voice) utterance.voice = voice;
      utterance.rate = opts.rate || 1.15;
      utterance.pitch = 1.0;
      utterance.volume = 1.0;
      utterance.onerror = (event) => {
        if (event && event.error && event.error !== 'interrupted' && event.error !== 'canceled') {
          console.warn('[VoiceCoach] SpeechSynthesis error:', event.error);
        }
      };
      window.speechSynthesis.speak(utterance);
    } catch (e) {
      console.warn('[VoiceCoach] speakSafe failed:', e);
    }
  };

  if (_debounceTimer) clearTimeout(_debounceTimer);
  if (opts.skipDebounce) {
    doSpeak();
  } else {
    _debounceTimer = setTimeout(doSpeak, 300);
  }
}

export function cancelVoice() {
  if (_debounceTimer) { clearTimeout(_debounceTimer); _debounceTimer = null; }
  if (!isSpeechSupported()) return;
  try { window.speechSynthesis.cancel(); } catch (e) {}
}

/* ---------- FORMATTERS ---------- */

function pluralRu(n, one, few, many) {
  const abs = Math.abs(n) % 100;
  const last = abs % 10;
  if (abs > 10 && abs < 20) return many;
  if (last > 1 && last < 5) return few;
  if (last === 1) return one;
  return many;
}

export function formatSecondsRu(totalSeconds) {
  const sec = Math.max(0, Math.round(Number(totalSeconds) || 0));
  if (sec < 60) {
    return `${sec} ${pluralRu(sec, 'секунда', 'секунды', 'секунд')}`;
  }
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  const minText = `${m} ${pluralRu(m, 'минута', 'минуты', 'минут')}`;
  if (s === 0) return minText;
  return `${minText} ${s} ${pluralRu(s, 'секунда', 'секунды', 'секунд')}`;
}

/**
 * V1.0.3: вес произносится с разделением на килограммы и граммы.
 * - 80    → «80 килограммов»
 * - 80.5  → «80 килограммов 500 грамм»
 * - 82.5  → «82 килограмма 500 грамм»
 * - 81.25 → «81 килограмм 250 грамм»
 * Цифры без точки TTS читает чисто, паузы нет.
 */
function formatWeightRu(weight) {
  const w = Number(weight);
  if (!w || w <= 0) return '';

  const intPart = Math.floor(w);
  const fracGrams = Math.round((w - intPart) * 1000);

  const kgText = `${intPart} ${pluralRu(intPart, 'килограмм', 'килограмма', 'килограммов')}`;

  if (fracGrams === 0) return kgText;

  return `${kgText} ${fracGrams} ${pluralRu(fracGrams, 'грамм', 'грамма', 'грамм')}`;
}

function formatRepsRu(reps) {
  const r = Math.max(0, parseInt(reps, 10) || 0);
  if (r <= 0) return '';
  return `${r} ${pluralRu(r, 'повторение', 'повторения', 'повторений')}`;
}

function formatRirRu(rir) {
  const raw = String(rir || '').replace('+', '').trim();
  if (!raw) return '';
  if (raw === '0') return 'до отказа';
  if (raw === '3') return 'запас 3 и больше';
  return `запас ${raw}`;
}

function formatMethodTailRu(draftSet, ex) {
  if (!draftSet || !draftSet.useSpecialMethod) return '';
  if (ex && ex.isCluster) return 'финальный кластер';
  if (ex && ex.isDrop) return 'финальный дроп-сет';
  if (ex && ex.isMyo) return 'финальный мио сет';
  return '';
}

/**
 * Собирает хвостовой блок «повторы, запас, метод» через запятую.
 * Возвращает '' если нечего добавить.
 */
function buildTailBlockRu(draftSet, ex) {
  if (!draftSet) return '';
  const tailParts = [];
  const repsText = formatRepsRu(draftSet.reps);
  if (repsText) tailParts.push(repsText);
  if (draftSet.category !== 'Разминка') {
    const rirText = formatRirRu(draftSet.rir);
    if (rirText) tailParts.push(rirText);
  }
  const methodTail = formatMethodTailRu(draftSet, ex);
  if (methodTail) tailParts.push(methodTail);
  return tailParts.join(', ');
}

/* ---------- PUBLIC API: ФРАЗЫ ---------- */

/**
 * Канал A: после записи подхода.
 * Одна фраза — отдых + [маркер перехода] + вес + повторы, запас.
 * Пунктуация: точки между крупными блоками, запятая внутри хвоста.
 *
 * Примеры:
 *  - Warmup → Warmup:
 *      "Отдых 1 минута. Вес 60 килограммов. 8 повторений."
 *  - Warmup → Work (переход):
 *      "Отдых 2 минуты 30 секунд. Следующий подход рабочий. Вес 80 килограммов. 8 повторений, запас 2."
 *  - Work → Work:
 *      "Отдых 2 минуты 30 секунд. Вес 80 килограммов. 8 повторений, запас 2."
 *
 * @param {number} restSeconds      — длительность отдыха
 * @param {string} exerciseName     — оставлен для совместимости, не используется
 * @param {object} draftSet         — { weight, reps, rir, category, useSpecialMethod }
 * @param {object} ex               — упражнение (isCluster / isDrop / isMyo)
 * @param {string} recordedCategory — категория ТОЛЬКО ЧТО записанного сета
 *                                    ('Разминка' | 'Рабочий'). Нужна для
 *                                    определения перехода разминка → рабочий.
 *                                    Если undefined — считается, что перехода нет.
 */
export function speakAfterSet(restSeconds, exerciseName, draftSet, ex, recordedCategory) {
  if (!isVoiceEnabled()) return;
  const blocks = [];

  // Блок 1: отдых
  const restText = formatSecondsRu(restSeconds);
  if (restText) blocks.push(`Отдых ${restText}`);

  // Блок 2 (опционально): маркер перехода «разминка → рабочий».
  // Слово «Разминка закончена» не нужно — из фразы «следующий подход рабочий»
  // и так понятно, что предыдущий был разминочный.
  const isTransition = recordedCategory === 'Разминка'
    && draftSet && draftSet.category === 'Рабочий';
  if (isTransition) blocks.push('Следующий подход рабочий');

  // Блок 3: вес отдельным блоком
  if (draftSet) {
    const weightText = formatWeightRu(draftSet.weight);
    if (weightText) blocks.push(`Вес ${weightText}`);

    // Блок 4: повторы + запас + метод
    const tailBlock = buildTailBlockRu(draftSet, ex);
    if (tailBlock) blocks.push(tailBlock);
  }

  if (blocks.length === 0) return;
  speakSafe(blocks.join('. ') + '.');
}

/**
 * Канал B: остаток отдыха на пороге (60/30/10).
 * 60 → "Осталось 60 секунд"; 30/10 → "30 секунд" / "10 секунд".
 */
export function speakRestTime(secondsLeft) {
  if (!isVoiceEnabled()) return;
  const sec = Math.max(0, Math.round(Number(secondsLeft) || 0));
  if (sec <= 0) return;
  let text;
  if (sec === 60) text = 'Осталось 60 секунд';
  else text = formatSecondsRu(sec);
  speakSafe(text);
}

/**
 * Канал C: естественное завершение отдыха.
 * При ручном пропуске НЕ вызывается — вызывающий код делает cancelVoice().
 */
export function speakRestFinished() {
  if (!isVoiceEnabled()) return;
  speakSafe('Отдых закончен');
}

/**
 * Канал C2: упражнение завершено (последний запланированный подход).
 * Воспроизводится сразу (skipDebounce), чтобы фраза успела прозвучать
 * до того, как пользователь нажмёт «Завершено» и speakNextExercise
 * объявит следующее упражнение.
 */
export function speakExerciseFinished() {
  if (!isVoiceEnabled()) return;
  speakSafe('Упражнение завершено', { skipDebounce: true });
}

/**
 * Канал D: смена упражнения (кнопка → или автоматический переход).
 * Без слова "Отдых", но С названием упражнения — атлету нужен контекст
 * при смене упражнения.
 *
 * Пример: "Приседания. 100 килограммов. 6 повторений, запас 1."
 */
export function speakNextExercise(exerciseName, draftSet, ex) {
  if (!isVoiceEnabled()) return;
  const blocks = [];

  const exName = String(exerciseName || '').trim();
  if (exName) blocks.push(exName);

  if (draftSet) {
    const weightText = formatWeightRu(draftSet.weight);
    if (weightText) blocks.push(weightText);

    const tailBlock = buildTailBlockRu(draftSet, ex);
    if (tailBlock) blocks.push(tailBlock);
  }

  if (blocks.length === 0) return;
  speakSafe(blocks.join('. ') + '.');
}
/**
 * =========================================================================
 * GYM ANALYTICS HUB — VOICE COACH MODULE (V1.0.0)
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
 * Каналы (см. план V1.0):
 *   A. speakAfterSet()      — после записи подхода: отдых + параметры след.
 *   B. speakRestTime()      — остаток отдыха на пороге 60/30/10.
 *   C. speakRestFinished()  — естественное завершение отдыха.
 *   D. speakNextExercise()  — смена упражнения (без слова "Отдых").
 *   E. cancelVoice()        — ручной пропуск / финиш / выключение галки.
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

/**
 * Возвращает русский голос, если доступен. На Android Chrome getVoices()
 * может быть пустым до события voiceschanged — поэтому вызываем getVoices()
 * лениво, в момент speak(). Если русского голоса нет — вернём null,
 * utterance.lang='ru-RU' всё равно попросит движок говорить по-русски.
 */
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

/**
 * Единственная точка выхода в speechSynthesis.
 * Инварианты:
 *  1. cancel() перед speak() — очищает очередь.
 *  2. lang='ru-RU' — обязательно для Android Chrome.
 *  3. onerror — тихо, без падения.
 *  4. Дебаунс 300 мс — защита от частых вызовов.
 */
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

  if (_debounceTimer) clearTimeout(_debounceTimer);
  _debounceTimer = setTimeout(() => {
    try {
      window.speechSynthesis.cancel();
      const utterance = new window.SpeechSynthesisUtterance(finalText);
      utterance.lang = 'ru-RU';
      const voice = pickRussianVoice();
      if (voice) utterance.voice = voice;
      utterance.rate = opts.rate || 1.0;
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
  }, 300);
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

function formatWeightRu(weight) {
  const w = Number(weight);
  if (!w || w <= 0) return '';
  return `${w} ${pluralRu(Math.round(w), 'килограмм', 'килограмма', 'килограммов')}`;
}

function formatRepsRu(reps) {
  const r = Math.max(0, parseInt(reps, 10) || 0);
  if (r <= 0) return '';
  return `${r} ${pluralRu(r, 'повторение', 'повторения', 'повторений')}`;
}

function formatRirRu(rir) {
  const raw = String(rir || '').replace('+', '').trim();
  if (!raw) return '';
  return `RIR ${raw}`;
}

function formatMethodTailRu(draftSet, ex) {
  if (!draftSet || !draftSet.useSpecialMethod) return '';
  if (ex && ex.isCluster) return 'финальный кластер';
  if (ex && ex.isDrop) return 'финальный дроп-сет';
  if (ex && ex.isMyo) return 'финальный мио-репс';
  return '';
}

/* ---------- PUBLIC API: ФРАЗЫ ---------- */

/**
 * Канал A: после записи подхода.
 * Одна фраза объединяет отдых + параметры следующего подхода.
 * Пример: "Отдых 2 минуты 30 секунд, Жим лёжа, 80 килограммов, 8 повторений, RIR 2"
 */
export function speakAfterSet(restSeconds, exerciseName, draftSet, ex) {
  if (!isVoiceEnabled()) return;
  const parts = [];
  const restText = formatSecondsRu(restSeconds);
  if (restText) parts.push(`Отдых ${restText}`);

  const exName = String(exerciseName || '').trim();
  if (exName) parts.push(exName);

  if (draftSet) {
    const w = formatWeightRu(draftSet.weight);
    if (w) parts.push(w);
    const r = formatRepsRu(draftSet.reps);
    if (r) parts.push(r);
    if (draftSet.category !== 'Разминка') {
      const rir = formatRirRu(draftSet.rir);
      if (rir) parts.push(rir);
    }
    const methodTail = formatMethodTailRu(draftSet, ex);
    if (methodTail) parts.push(methodTail);
  }

  speakSafe(parts.join(', '));
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
 * Канал D: смена упражнения (кнопка → или автоматический переход).
 * Без слова "Отдых".
 */
export function speakNextExercise(exerciseName, draftSet, ex) {
  if (!isVoiceEnabled()) return;
  const parts = [];
  const exName = String(exerciseName || '').trim();
  if (exName) parts.push(exName);
  if (draftSet) {
    const w = formatWeightRu(draftSet.weight);
    if (w) parts.push(w);
    const r = formatRepsRu(draftSet.reps);
    if (r) parts.push(r);
    if (draftSet.category !== 'Разминка') {
      const rir = formatRirRu(draftSet.rir);
      if (rir) parts.push(rir);
    }
    const methodTail = formatMethodTailRu(draftSet, ex);
    if (methodTail) parts.push(methodTail);
  }
  speakSafe(parts.join(', '));
}
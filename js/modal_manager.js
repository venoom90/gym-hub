/**
 * =========================================================================
 * GYM ANALYTICS HUB — MODAL MANAGER (V51 Android Inert Support)
 * =========================================================================
 * V51 (Android UX P2 #15):
 * - Добавлен setPageInert(inert) — устанавливает el.inert на <header.top-bar>,
 *   <main>, <nav#bottomNav>, пока открыт хотя бы один модал. Это блокирует
 *   Tab/TalkBack от попадания фокуса на скрытый за оверлеем контент.
 * - Счётчик через stack.length: inert=true только при открытии первого модала,
 *   inert=false только при закрытии последнего. Вложенные модалы работают корректно.
 * - try/catch на присвоении inert — старые браузеры не падают.
 * - V50-фиксы (Bug 6 baseline close-all, Bug 7 transient, Bug 8 suppress=1)
 *   сохранены.
 * =========================================================================
 */

const stack = [];
const registry = {};
let initialized = false;
let closingInProgress = false;
let suppressPopstateCount = 0;

function init() {
  if (initialized) return;
  initialized = true;
  history.replaceState({ __gymBaseline: true }, '', location.href);
  window.addEventListener('popstate', handlePopstate);
}

/**
 * V51: inert на глобальные слои страницы, пока открыт модал.
 * Безопасно: try/catch на случай отсутствия поддержки (Firefox < 112).
 */
function setPageInert(inert) {
  const selectors = ['body > header.top-bar', 'body > main', 'body > nav#bottomNav'];
  selectors.forEach(sel => {
    const el = document.querySelector(sel);
    if (el) {
      try { el.inert = Boolean(inert); } catch (e) { /* noop */ }
    }
  });
}

function isOurPopstateState(state) {
  if (!state || typeof state !== 'object') return false;
  return Boolean(state.gymModal) || Boolean(state.__gymBaseline);
}

function closeStackTop() {
  const topId = stack.pop();
  if (!topId) return;
  const config = registry[topId];
  if (!config) return;
  if (config.el) {
    config.el.style.display = 'none';
  }
  if (typeof config.onClose === 'function') {
    try {
      config.onClose();
    } catch (err) {
      console.error('[ModalManager] onClose error for', topId, err);
    }
  }
  // V51: снимаем inert только когда закрыт ПОСЛЕДНИЙ модал.
  if (stack.length === 0) {
    setPageInert(false);
  }
}

function openModalWithoutHistory(id) {
  const config = registry[id];
  if (!config || !config.el) return;
  if (stack.includes(id)) return;
  stack.push(id);
  config.el.style.display = config.displayStyle || 'flex';
  // V51: включаем inert при открытии первого модала.
  if (stack.length === 1) {
    setPageInert(true);
  }
  if (typeof config.onOpen === 'function') {
    try {
      config.onOpen();
    } catch (err) {
      console.error('[ModalManager] onOpen error for', id, err);
    }
  }
}

function handlePopstate(event) {
  if (suppressPopstateCount > 0) {
    suppressPopstateCount--;
    closingInProgress = false;
    return;
  }

  if (!isOurPopstateState(event.state)) {
    closingInProgress = false;
    return;
  }

  closingInProgress = false;

  const topId = stack.length > 0 ? stack[stack.length - 1] : null;
  const eventModalId = event.state.gymModal;

  if (event.state.__gymBaseline) {
    while (stack.length > 0) closeStackTop();
    return;
  }

  if (eventModalId) {
    if (eventModalId === topId) return;
    if (stack.includes(eventModalId)) {
      while (stack.length > 0 && stack[stack.length - 1] !== eventModalId) {
        closeStackTop();
      }
      return;
    }
    if (registry[eventModalId] && registry[eventModalId].el && !registry[eventModalId].transient) {
      openModalWithoutHistory(eventModalId);
    }
    return;
  }
}

export function registerModal(id, config) {
  init();
  if (!id || !config || !config.el) {
    console.warn('[ModalManager] Invalid registration:', id);
    return;
  }
  registry[id] = config;
}

export function openModal(id, extraData) {
  init();
  const config = registry[id];
  if (!config || !config.el) {
    console.warn('[ModalManager] Modal not registered:', id);
    return;
  }

  if (stack.includes(id)) {
    console.warn('[ModalManager] Modal already open:', id);
    return;
  }

  history.pushState({ gymModal: id }, '');
  stack.push(id);

  config.el.style.display = config.displayStyle || 'flex';

  // V51: inert при открытии первого модала.
  if (stack.length === 1) {
    setPageInert(true);
  }

  if (typeof config.onOpen === 'function') {
    try {
      config.onOpen(extraData);
    } catch (err) {
      console.error('[ModalManager] onOpen error for', id, err);
    }
  }
}

export function closeModal(id) {
  init();
  if (closingInProgress) return;
  if (stack.length === 0) return;

  const topId = stack[stack.length - 1];
  if (topId !== id) {
    console.warn('[ModalManager] closeModal called for non-top:', id, '— top is:', topId);
    return;
  }

  closingInProgress = true;
  history.back();

  setTimeout(() => { closingInProgress = false; }, 500);
}

export function isModalOpen(id) {
  return stack.includes(id);
}

export function getTopModalId() {
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

export function resetAllModals() {
  const depth = stack.length;
  stack.length = 0;
  closingInProgress = false;

  Object.keys(registry).forEach(id => {
    const config = registry[id];
    if (config && config.el) {
      config.el.style.display = 'none';
    }
  });

  // V51: принудительно снимаем inert.
  setPageInert(false);

  if (depth > 0) {
    suppressPopstateCount = 1;
    history.go(-depth);
    setTimeout(() => { suppressPopstateCount = 0; }, 400);
  }
}
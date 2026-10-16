/**
 * =========================================================================
 * GYM ANALYTICS HUB — MODAL MANAGER (V5.4.0)
 * =========================================================================
 * Централизованное управление модалами через History API.
 * Решает баг PWA: Android hardware back закрывает модал, а не приложение.
 *
 * КОНТРАКТ:
 *   registerModal(id, config)   — регистрация модала.
 *   openModal(id, extra)        — открыть + pushState.
 *   closeModal(id)              — программное закрытие (через history.back).
 *   isModalOpen(id)             — проверка состояния.
 *   resetAllModals()            — форсированная очистка (logout/save success).
 *
 * config = {
 *   el: HTMLElement,            — DOM-элемент модала (обязательно).
 *   displayStyle: 'flex',       — как показывать (default: 'flex').
 *   onOpen: (extra) => {},      — колбэк при открытии.
 *   onClose: () => {},          — колбэк при закрытии.
 * }
 *
 * ИНВАРИАНТ: программный closeModal — ТОЛЬКО для top-of-stack.
 *   Для множественного закрытия — resetAllModals().
 *
 * МЕХАНИКА:
 *   openModal  → history.pushState({gymModal:id}) + stack.push
 *   closeModal → history.back() → popstate → handlePopstate закроет top
 *   hardware back → popstate → handlePopstate закроет top
 * =========================================================================
 */

const stack = [];
const registry = {};
let initialized = false;
let closingInProgress = false;

function init() {
  if (initialized) return;
  initialized = true;
  // Baseline: фиксируем стартовое состояние истории, чтобы back имел куда возвращаться.
  history.replaceState({ __gymBaseline: true }, '', location.href);
  window.addEventListener('popstate', handlePopstate);
}

function handlePopstate() {
  closingInProgress = false;

  if (stack.length === 0) {
    // Стек пуст — это либо tab-навигация по hash, либо forward.
    // Не наше событие — игнорируем.
    return;
  }

  const topId = stack.pop();
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

  // Push в историю ДО отображения, чтобы back работал сразу.
  history.pushState({ gymModal: id }, '');
  stack.push(id);

  config.el.style.display = config.displayStyle || 'flex';

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

  // Программное закрытие = history.back().
  // Это триггернёт popstate, который закроет top-of-stack.
  closingInProgress = true;
  history.back();

  // Защита от «зависшего» флага, если popstate не сработает.
  setTimeout(() => { closingInProgress = false; }, 500);
}

export function isModalOpen(id) {
  return stack.includes(id);
}

export function getTopModalId() {
  return stack.length > 0 ? stack[stack.length - 1] : null;
}

/**
 * Форсированная очистка всех модалов БЕЗ синхронизации с историей.
 * Используется при logout, успешном save, discard session.
 */
export function resetAllModals() {
  stack.length = 0;
  closingInProgress = false;
  Object.keys(registry).forEach(id => {
    const config = registry[id];
    if (config && config.el) {
      config.el.style.display = 'none';
    }
  });
}
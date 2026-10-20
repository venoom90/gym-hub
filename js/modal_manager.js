/**
 * =========================================================================
 * GYM ANALYTICS HUB — MODAL MANAGER (V49 History Integrity)
 * =========================================================================
 * V49 изменения:
 * - resetAllModals() корректно откатывает историю через history.go(-depth):
 *   после вызова пользователь не «застревает» на пустых popstate-записях.
 * - handlePopstate реагирует ТОЛЬКО на «свои» события (state содержит
 *   gymModal или __gymBaseline). Hash-navigation и forward на произвольные
 *   записи игнорируются и не закрывают модалы случайно.
 * - Forward на модал восстанавливается: если event.state.gymModal не в стеке
 *   — открываем его без pushState (мы уже в «будущем»). Если в стеке, но не
 *   top — закрываем до него (back-семантика).
 * - В app.js tab-navigation теперь через history.replaceState, а не
 *   location.hash — устраняет конфликт с modal-pushState.
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
  // Baseline: фиксируем стартовое состояние истории, чтобы back имел куда возвращаться.
  history.replaceState({ __gymBaseline: true }, '', location.href);
  window.addEventListener('popstate', handlePopstate);
}

function isOurPopstateState(state) {
  if (!state || typeof state !== 'object') return false;
  return Boolean(state.gymModal) || Boolean(state.__gymBaseline);
}

/**
 * Закрывает верхний модал стека и вызывает его onClose.
 * Используется и в handlePopstate, и в resetAllModals.
 */
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
}

/**
 * Открывает модал без pushState. Нужно для forward-восстановления:
 * браузер уже перевёл нас в «будущее» через forward, pushState создал бы
 * новую запись и сломал историю.
 */
function openModalWithoutHistory(id) {
  const config = registry[id];
  if (!config || !config.el) return;
  if (stack.includes(id)) return;
  stack.push(id);
  config.el.style.display = config.displayStyle || 'flex';
  if (typeof config.onOpen === 'function') {
    try {
      config.onOpen();
    } catch (err) {
      console.error('[ModalManager] onOpen error for', id, err);
    }
  }
}

function handlePopstate(event) {
  // Поглощение popstate'ов от resetAllModals (history.go(-depth)).
  if (suppressPopstateCount > 0) {
    suppressPopstateCount--;
    closingInProgress = false;
    return;
  }

  if (!isOurPopstateState(event.state)) {
    // Чужое событие (hash-navigation, forward на произвольную запись).
    // Модал не трогаем — иначе таб-навигация случайно закроет его.
    closingInProgress = false;
    return;
  }

  closingInProgress = false;

  const topId = stack.length > 0 ? stack[stack.length - 1] : null;
  const eventModalId = event.state.gymModal;

  // Случай 1: state = baseline (back с любого модала в самый низ).
  if (event.state.__gymBaseline) {
    if (topId) closeStackTop();
    return;
  }

  // Случай 2: state = gymModal X.
  if (eventModalId) {
    if (eventModalId === topId) {
      // Back/forward на тот же модал — стек не меняется (no-op).
      return;
    }
    if (stack.includes(eventModalId)) {
      // Back: X есть в стеке, но не top → закрываем до X.
      while (stack.length > 0 && stack[stack.length - 1] !== eventModalId) {
        closeStackTop();
      }
      return;
    }
    // Forward: X не в стеке → восстанавливаем без pushState.
    if (registry[eventModalId] && registry[eventModalId].el) {
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
 *
 * V49 FIX: откатывает историю на реальную глубину стека через history.go(-N),
 * чтобы пользователь не «застревал» на пустых popstate-записях.
 */
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

  if (depth > 0) {
    suppressPopstateCount = depth;
    history.go(-depth);
    // Safety: если popstate по какой-то причине не пришёл (некоторые браузеры
    // генерируют один popstate на всю операцию history.go(-n)), снимаем
    // счётчик по таймауту.
    setTimeout(() => { suppressPopstateCount = 0; }, 400);
  }
}
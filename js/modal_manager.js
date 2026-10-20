/**
 * =========================================================================
 * GYM ANALYTICS HUB — MODAL MANAGER (V50 History + Transient Fixes)
 * =========================================================================
 * V50 (группа B аудита 20.10.2026):
 * - Bug 6: baseline-случай (back с любого модала в самый низ) теперь закрывает
 *   ВСЕ модалы через while (stack.length > 0). Раньше закрывался только top,
 *   и при накопленной истории из нескольких записей остальные модалы «висели»
 *   при уже откаченной истории.
 * - Bug 7: transient-модалы (например, confirm-sheet) НЕ восстанавливаются
 *   при forward. Их onClose/onOpen не рассчитаны на «оживление» без контекста
 *   (у confirm-sheet confirmSheetState = null → кнопки мертвы). Флаг
 *   config.transient = true ставится в registerModal.
 * - Bug 8: resetAllModals теперь ставит suppressPopstateCount = 1, а не depth.
 *   history.go(-N) эмитит ОДИН popstate на итоговое состояние. Старое значение
 *   проглатывало реальные события в окне 400 мс (hardware back, forward).
 * - V49-фиксы (isOurPopstateState, openModalWithoutHistory, history.go(-depth))
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
}

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
  // Поглощение popstate от resetAllModals (history.go(-depth) — один event).
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

  // Bug 6 fix: baseline — закрываем ВСЕ модалы, а не только top.
  if (event.state.__gymBaseline) {
    while (stack.length > 0) closeStackTop();
    return;
  }

  if (eventModalId) {
    if (eventModalId === topId) {
      return;
    }
    if (stack.includes(eventModalId)) {
      while (stack.length > 0 && stack[stack.length - 1] !== eventModalId) {
        closeStackTop();
      }
      return;
    }
    // Bug 7 fix: transient-модалы не восстанавливаем при forward.
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

/**
 * Форсированная очистка БЕЗ onClose (не вызывает callbacks).
 * Используется при logout / save success / discard live session.
 *
 * Bug 8 fix: history.go(-N) эмитит ОДИН popstate, не N.
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
    suppressPopstateCount = 1;
    history.go(-depth);
    setTimeout(() => { suppressPopstateCount = 0; }, 400);
  }
}
/**
 * =========================================================================
 * GYM ANALYTICS HUB — UI HELPERS (V1.2 Android Toast+Action)
 * =========================================================================
 * V1.2 (Android UX P1 #10, P0 #4, P2 #18, P2 #23):
 * - showToast(message, type, duration, action?): 4-й аргумент — { label, onClick }.
 *   Добавляет inline-кнопку действия (например, "Повторить"). Обратная
 *   совместимость: если action не передан — поведение V1.1 идентично.
 * - Toast позиционируется выше PAB, если liveWorkoutOverlay открыт
 *   (bottom 124px вместо 88px) — устраняет перекрытие кнопки "ЗАПИСАТЬ".
 * - Error-тосты с action получают pointer-events: auto (можно нажать кнопку,
 *   выделить и скопировать текст ошибки).
 * - V1.1-фиксы (Bug 5 onClose callbacks, Bug 12 a11y focus trap, Bug 7
 *   transient) сохранены.
 * =========================================================================
 */

import { registerModal, openModal, closeModal, isModalOpen } from './modal_manager.js';

let toastTimeout = null;
let confirmSheetState = null;
let previousActiveElement = null;

/* =========================================================
 * TOAST
 * ========================================================= */

function ensureToastElement() {
  let el = document.getElementById('__gym_toast__');
  if (el) return el;
  el = document.createElement('div');
  el.id = '__gym_toast__';
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.setAttribute('aria-atomic', 'true');
  el.style.display = 'none';
  document.body.appendChild(el);
  return el;
}

export function showToast(message, type, duration, action) {
  const toast = ensureToastElement();
  if (toastTimeout) { clearTimeout(toastTimeout); toastTimeout = null; }

  const palette = {
    info:    { bg: 'var(--md-sys-color-secondary-container)', fg: 'var(--md-sys-color-on-secondary-container)', border: 'var(--md-sys-color-outline-variant)' },
    success: { bg: 'var(--app-color-success-container)',      fg: 'var(--app-color-success)',                  border: 'var(--app-color-success)' },
    warning: { bg: 'var(--app-color-warning-container)',      fg: 'var(--app-color-warning)',                  border: 'var(--app-color-warning)' },
    error:   { bg: 'var(--md-sys-color-error-container)',     fg: 'var(--md-sys-color-on-error-container)',    border: 'var(--md-sys-color-error)' }
  };
  const p = palette[type] || palette.info;

  const hasAction = action && typeof action.label === 'string' && typeof action.onClick === 'function';

  // V1.2: контент пересобирается каждый раз (текст + опциональная кнопка).
  toast.innerHTML = '';
  toast.textContent = '';

  if (hasAction) {
    const textSpan = document.createElement('span');
    textSpan.textContent = String(message || '');
    textSpan.style.flex = '1 1 auto';
    textSpan.style.minWidth = '0';
    textSpan.style.whiteSpace = 'pre-wrap';
    textSpan.style.wordBreak = 'break-word';

    const actionBtn = document.createElement('button');
    actionBtn.type = 'button';
    actionBtn.textContent = action.label;
    actionBtn.style.cssText = [
      'flex:0 0 auto',
      'padding:8px 14px',
      'border-radius:var(--md-sys-shape-corner-medium)',
      'border:none',
      'background:' + p.fg,
      'color:' + p.bg,
      'font:600 0.8rem/1 Roboto, sans-serif',
      'cursor:pointer',
      'margin-left:8px',
      'min-height:36px',
      'white-space:nowrap'
    ].join(';');
    actionBtn.onclick = (e) => {
      e.stopPropagation();
      try {
        if (toastTimeout) { clearTimeout(toastTimeout); toastTimeout = null; }
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(8px)';
        toastTimeout = setTimeout(() => {
          toastTimeout = null;
          toast.style.display = 'none';
        }, 220);
        action.onClick();
      } catch (err) {
        console.error('[ui] toast action error:', err);
      }
    };

    toast.appendChild(textSpan);
    toast.appendChild(actionBtn);
  } else {
    toast.textContent = String(message || '');
  }

  // V1.2: toast над PAB в Live Workout.
  const isLiveOpen = isModalOpen('liveWorkoutOverlay');
  const bottomPx = isLiveOpen ? 124 : 88;

  toast.style.cssText = [
    'position:fixed',
    'left:16px',
    'right:16px',
    'bottom:calc(' + bottomPx + 'px + env(safe-area-inset-bottom, 0px))',
    'padding:12px 16px',
    'border-radius:var(--md-sys-shape-corner-medium)',
    'background:' + p.bg,
    'color:' + p.fg,
    'border:1px solid ' + p.border,
    'font: var(--md-sys-typescale-body-medium)',
    'font-weight:500',
    'z-index:5000',
    'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
    'transition:opacity 200ms ease, transform 200ms ease',
    'opacity:0',
    'transform:translateY(8px)',
    'pointer-events:' + (hasAction ? 'auto' : 'none'),
    'white-space:pre-wrap',
    'word-wrap:break-word',
    'display:flex',
    'align-items:center',
    'justify-content:space-between',
    'gap:8px'
  ].join(';');

  if (!hasAction) {
    toast.style.display = 'block';
  }

  void toast.offsetHeight;
  toast.style.opacity = '1';
  toast.style.transform = 'translateY(0)';

  const defaultMs = (type === 'error') ? 5500 : (type === 'warning') ? 4500 : 3500;
  const ms = Math.max(1000, typeof duration === 'number' ? duration : defaultMs);
  toastTimeout = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    toastTimeout = setTimeout(() => {
      toastTimeout = null;
      toast.style.display = 'none';
    }, 220);
  }, ms);
}

export function showErrorToast(m, action)   { showToast(m, 'error', undefined, action); }
export function showSuccessToast(m, action) { showToast(m, 'success', undefined, action); }
export function showWarningToast(m, action) { showToast(m, 'warning', undefined, action); }
export function showInfoToast(m, action)    { showToast(m, 'info', undefined, action); }

/* =========================================================
 * CONFIRM SHEET
 * ========================================================= */

function ensureConfirmSheetDom() {
  if (document.getElementById('gymConfirmSheet')) return;

  const overlay = document.createElement('div');
  overlay.id = 'gymConfirmSheet';
  overlay.className = 'live-sheet-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'gymConfirmSheetTitle');
  overlay.setAttribute('aria-describedby', 'gymConfirmSheetMessage');
  overlay.innerHTML = `
    <div class="live-sheet" style="padding-bottom: calc(20px + env(safe-area-inset-bottom, 0px));">
      <div class="live-sheet-handle" aria-hidden="true"></div>
      <div class="live-sheet-title" id="gymConfirmSheetTitle" style="text-align:center;">Подтверждение</div>
      <div class="live-sheet-subtitle" id="gymConfirmSheetMessage" style="text-align:center; margin-top:4px; line-height:1.45; white-space:pre-wrap;"></div>
      <div class="live-sheet-actions" style="margin-top:8px;">
        <md-outlined-button id="gymConfirmSheetCancelBtn" style="width:100%;">
          <span class="gym-cs-cancel-label">Отмена</span>
        </md-outlined-button>
        <md-filled-button id="gymConfirmSheetConfirmBtn" style="width:100%;">
          <span class="gym-cs-confirm-label">Подтвердить</span>
        </md-filled-button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
}

function applyConfirmVisuals(btn, danger) {
  if (!btn) return;
  if (danger) {
    btn.style.setProperty('--md-filled-button-container-color', 'var(--md-sys-color-error-container)');
    btn.style.setProperty('--md-filled-button-label-text-color', 'var(--md-sys-color-on-error-container)');
  } else {
    btn.style.removeProperty('--md-filled-button-container-color');
    btn.style.removeProperty('--md-filled-button-label-text-color');
  }
}

function clearConfirmStateAndVisuals() {
  const state = confirmSheetState;
  const btn = document.getElementById('gymConfirmSheetConfirmBtn');
  const labelEl = btn && btn.querySelector('.gym-cs-confirm-label');
  if (btn) {
    btn.dataset.confirmState = 'idle';
    if (btn._confirmTimer) { clearTimeout(btn._confirmTimer); btn._confirmTimer = null; }
    applyConfirmVisuals(btn, Boolean(state && state.danger));
    if (labelEl && state && state.idleLabel) labelEl.innerText = state.idleLabel;
  }
  confirmSheetState = null;
}

function dispatchPendingCallback() {
  if (!confirmSheetState) return;
  const state = confirmSheetState;
  const which = state.pendingWhich || 'cancel';
  const cb = (which === 'confirm') ? state.onConfirm : state.onCancel;

  clearConfirmStateAndVisuals();

  if (typeof cb === 'function') {
    try { cb(); } catch (e) { console.error('[ui] confirm sheet callback error:', e); }
  }
}

function handleConfirmSheetKeydown(e) {
  if (!isModalOpen('gymConfirmSheet')) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    const cancelBtn = document.getElementById('gymConfirmSheetCancelBtn');
    if (cancelBtn) cancelBtn.click();
    return;
  }

  if (e.key === 'Tab') {
    const focusables = [
      document.getElementById('gymConfirmSheetCancelBtn'),
      document.getElementById('gymConfirmSheetConfirmBtn')
    ].filter(Boolean);
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('keydown', handleConfirmSheetKeydown);
}

export function openConfirmSheet(opts) {
  const options = opts || {};

  if (isModalOpen('gymConfirmSheet')) {
    console.warn('[ui] Confirm sheet already open — ignoring duplicate request');
    return;
  }

  ensureConfirmSheetDom();

  const overlay = document.getElementById('gymConfirmSheet');
  const titleEl = document.getElementById('gymConfirmSheetTitle');
  const messageEl = document.getElementById('gymConfirmSheetMessage');
  const cancelBtn = document.getElementById('gymConfirmSheetCancelBtn');
  const confirmBtn = document.getElementById('gymConfirmSheetConfirmBtn');
  const cancelLabelEl = cancelBtn && cancelBtn.querySelector('.gym-cs-cancel-label');
  const confirmLabelEl = confirmBtn && confirmBtn.querySelector('.gym-cs-confirm-label');

  const danger = options.danger === true;
  const requireDoubleTap = (typeof options.requireDoubleTap === 'boolean')
    ? options.requireDoubleTap
    : danger;
  const idleLabel = options.confirmLabel || (danger ? 'Удалить' : 'Подтвердить');
  const confirmLabel = danger ? 'Точно ' + idleLabel.toLowerCase() + '?' : 'Точно?';

  if (titleEl) titleEl.innerText = options.title || 'Подтверждение';
  if (messageEl) {
    messageEl.innerText = options.message || '';
    messageEl.style.display = options.message ? '' : 'none';
  }
  if (cancelLabelEl) cancelLabelEl.innerText = options.cancelLabel || 'Отмена';
  if (confirmLabelEl) confirmLabelEl.innerText = idleLabel;

  confirmSheetState = {
    onConfirm: options.onConfirm,
    onCancel: options.onCancel,
    requireDoubleTap,
    idleLabel,
    confirmLabel,
    danger,
    pendingWhich: null
  };

  if (confirmBtn) {
    confirmBtn.dataset.confirmState = 'idle';
    if (confirmBtn._confirmTimer) { clearTimeout(confirmBtn._confirmTimer); confirmBtn._confirmTimer = null; }
    applyConfirmVisuals(confirmBtn, danger);
  }

  cancelBtn.onclick = () => {
    if (!confirmSheetState) return;
    confirmSheetState.pendingWhich = 'cancel';
    closeModal('gymConfirmSheet');
  };

  confirmBtn.onclick = () => {
    const state = confirmSheetState;
    if (!state) return;

    if (state.requireDoubleTap && confirmBtn.dataset.confirmState !== 'confirm') {
      confirmBtn.dataset.confirmState = 'confirm';
      confirmBtn.style.setProperty('--md-filled-button-container-color', 'var(--md-sys-color-error)');
      confirmBtn.style.setProperty('--md-filled-button-label-text-color', '#ffffff');
      if (confirmLabelEl) confirmLabelEl.innerText = state.confirmLabel;
      if (confirmBtn._confirmTimer) clearTimeout(confirmBtn._confirmTimer);
      confirmBtn._confirmTimer = setTimeout(() => {
        if (confirmBtn.dataset.confirmState === 'confirm' && confirmSheetState === state) {
          confirmBtn.dataset.confirmState = 'idle';
          applyConfirmVisuals(confirmBtn, state.danger);
          if (confirmLabelEl) confirmLabelEl.innerText = state.idleLabel;
        }
      }, 3000);
      return;
    }

    state.pendingWhich = 'confirm';
    closeModal('gymConfirmSheet');
  };

  overlay.onclick = (e) => {
    if (e.target === overlay) {
      closeModal('gymConfirmSheet');
    }
  };

  previousActiveElement = document.activeElement;

  registerModal('gymConfirmSheet', {
    el: overlay,
    displayStyle: 'flex',
    transient: true,
    onClose: () => {
      dispatchPendingCallback();
      if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
        try { previousActiveElement.focus(); } catch (e) {}
        previousActiveElement = null;
      }
    }
  });

  openModal('gymConfirmSheet');

  setTimeout(() => {
    const cancelBtnEl = document.getElementById('gymConfirmSheetCancelBtn');
    if (cancelBtnEl && typeof cancelBtnEl.focus === 'function') {
      try { cancelBtnEl.focus(); } catch (e) {}
    }
  }, 50);
}
/**
 * =========================================================================
 * GYM ANALYTICS HUB — UI HELPERS (V1.0)
 * =========================================================================
 * Универсальные компоненты, заменяющие нативные alert() / confirm()
 * для соответствия M3 Expressive + регламенту (запрет нативных окон).
 *
 * Контракт:
 *   showToast(message, type='info', duration=3500)
 *     type: 'info' | 'success' | 'warning' | 'error'
 *
 *   showErrorToast(m) / showSuccessToast(m) / showWarningToast(m) / showInfoToast(m)
 *
 *   openConfirmSheet({
 *     title, message, confirmLabel, cancelLabel, danger, requireDoubleTap,
 *     onConfirm, onCancel
 *   })
 *     danger: true        → красный стиль + double-tap по умолчанию
 *     requireDoubleTap:   → override; default = (danger === true)
 *
 * ИНВАРИАНТЫ:
 * - Все модалы через modal_manager (hardware back / backdrop корректны).
 * - Double-tap state в dataset + _confirmTimer (см. регламент §2.7).
 * - DOM создаётся динамически и идемпотентно (index.html не тронут).
 * - onCancel вызывается ровно один раз (кнопка / backdrop / back).
 * - onConfirm вызывается ровно один раз (2-й тап или 1-й при requireDoubleTap=false).
 * =========================================================================
 */

import { registerModal, openModal, closeModal, isModalOpen } from './modal_manager.js';

let toastTimeout = null;
let confirmSheetState = null;

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
  document.body.appendChild(el);
  return el;
}

export function showToast(message, type, duration) {
  const toast = ensureToastElement();
  if (toastTimeout) { clearTimeout(toastTimeout); toastTimeout = null; }

  const palette = {
    info:    { bg: 'var(--md-sys-color-secondary-container)', fg: 'var(--md-sys-color-on-secondary-container)', border: 'var(--md-sys-color-outline-variant)' },
    success: { bg: 'var(--app-color-success-container)',      fg: 'var(--app-color-success)',                  border: 'var(--app-color-success)' },
    warning: { bg: 'var(--app-color-warning-container)',      fg: 'var(--app-color-warning)',                  border: 'var(--app-color-warning)' },
    error:   { bg: 'var(--md-sys-color-error-container)',     fg: 'var(--md-sys-color-on-error-container)',    border: 'var(--md-sys-color-error)' }
  };
  const p = palette[type] || palette.info;

  toast.textContent = String(message || '');
  toast.style.cssText = [
    'position:fixed',
    'left:16px',
    'right:16px',
    'bottom:calc(88px + env(safe-area-inset-bottom, 0px))',
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
    'pointer-events:none',
    'white-space:pre-wrap',
    'word-wrap:break-word'
  ].join(';');

  // Принудительный reflow, чтобы transition сработал
  void toast.offsetHeight;
  toast.style.opacity = '1';
  toast.style.transform = 'translateY(0)';

  const ms = Math.max(1000, typeof duration === 'number' ? duration : 3500);
  toastTimeout = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    toastTimeout = setTimeout(() => {
      toastTimeout = null;
      if (toast.parentNode) toast.remove();
    }, 220);
  }, ms);
}

export function showErrorToast(m)   { showToast(m, 'error'); }
export function showSuccessToast(m) { showToast(m, 'success'); }
export function showWarningToast(m) { showToast(m, 'warning'); }
export function showInfoToast(m)    { showToast(m, 'info'); }

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

/**
 * Программный вызов onConfirm/onCancel с защитой от двойного вызова.
 * НЕ вызывает closeModal — это делает вызывающий код ДО (чтобы onClose
 * увидел null и не продублировал callback).
 */
function invokeCallback(which) {
  if (!confirmSheetState) return;
  const state = confirmSheetState;
  const cb = which === 'confirm' ? state.onConfirm : state.onCancel;
  clearConfirmStateAndVisuals();
  if (typeof cb === 'function') {
    try { cb(); } catch (e) { console.error('[ui] confirm sheet callback error:', e); }
  }
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
    danger
  };

  // Reset button state-machine
  if (confirmBtn) {
    confirmBtn.dataset.confirmState = 'idle';
    if (confirmBtn._confirmTimer) { clearTimeout(confirmBtn._confirmTimer); confirmBtn._confirmTimer = null; }
    applyConfirmVisuals(confirmBtn, danger);
  }

  cancelBtn.onclick = () => {
    invokeCallback('cancel');
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

    invokeCallback('confirm');
    closeModal('gymConfirmSheet');
  };

  overlay.onclick = (e) => {
    if (e.target === overlay) closeModal('gymConfirmSheet');
  };

  registerModal('gymConfirmSheet', {
    el: overlay,
    displayStyle: 'flex',
    onClose: () => {
      // Внешний close (backdrop / hardware back) — вызываем onCancel.
      // Если уже null — значит button-обработчик сам вызвал closeModal,
      // и callback уже выполнен — не дублируем.
      if (!confirmSheetState) return;
      invokeCallback('cancel');
    }
  });

  openModal('gymConfirmSheet');
}
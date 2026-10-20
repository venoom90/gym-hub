/**
 * =========================================================================
 * GYM ANALYTICS HUB — UI HELPERS (V1.1)
 * =========================================================================
 * V1.1 (группа B аудита 20.10.2026):
 * - Bug 5 (критический): onConfirm/onCancel теперь вызываются из onClose
 *   модала, а не ДО closeModal. Раньше цепочка «confirm → onConfirm → openModal»
 *   ломалась: closeModal('gymConfirmSheet') видел чужой top и старая шторка
 *   висела под новым модалом. State-machine через confirmSheetState.pendingWhich:
 *     null    → закрытие нативно (backdrop / hardware back) → onCancel
 *     'cancel'→ пользователь нажал Отмена
 *     'confirm'→ пользователь нажал Подтвердить (после double-tap)
 * - Bug 12 (a11y): toast не удаляется (role=status переиспользуется).
 *   Длительность по типу: error 5500, warning 4500, info/success 3500.
 *   aria-atomic="true".
 * - Bug 12 (a11y confirm-sheet): aria-labelledby / aria-describedby,
 *   Escape → cancel, focus trap на двух кнопках, возврат фокуса на
 *   previousActiveElement при закрытии.
 * - Bug 7 (transient): registerModal('gymConfirmSheet', { transient: true }) —
 *   forward не восстанавливает пустую шторку.
 * - V1.0-контракты сохранены: showToast / 4 shortcuts / openConfirmSheet.
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
    'word-wrap:break-word',
    'display:block'
  ].join(';');

  void toast.offsetHeight;
  toast.style.opacity = '1';
  toast.style.transform = 'translateY(0)';

  // Bug 12: ошибки живут дольше — пользователь успевает прочитать.
  const defaultMs = (type === 'error') ? 5500 : (type === 'warning') ? 4500 : 3500;
  const ms = Math.max(1000, typeof duration === 'number' ? duration : defaultMs);
  toastTimeout = setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(8px)';
    toastTimeout = setTimeout(() => {
      toastTimeout = null;
      // Bug 12: скрываем, а не удаляем — role=status переиспользуется,
      // скринридер не теряет live-region.
      toast.style.display = 'none';
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
  // Bug 12: привязка заголовка и описания.
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

/**
 * Bug 5 fix: callback вызывается из onClose модала, ПОСЛЕ закрытия.
 * pendingWhich:
 *   null      → backdrop / hardware back → onCancel
 *   'cancel'  → пользователь нажал Отмена
 *   'confirm' → пользователь нажал Подтвердить (после double-tap, если нужно)
 *
 * confirmSheetState обнуляется ДО вызова cb — чтобы cb мог открыть
 * новый confirm-sheet или другой модал без гонки.
 */
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

/**
 * Bug 12: Escape → cancel, Tab-ловушка на двух кнопках.
 * Повешен один раз на document, активен только при открытом confirm-sheet.
 */
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
      // backdrop = cancel (pendingWhich останется null → dispatch вызовет onCancel)
      closeModal('gymConfirmSheet');
    }
  };

  // Bug 12: возврат фокуса на элемент, который был в фокусе до открытия.
  previousActiveElement = document.activeElement;

  registerModal('gymConfirmSheet', {
    el: overlay,
    displayStyle: 'flex',
    transient: true,  // Bug 7: не восстанавливать при forward
    onClose: () => {
      dispatchPendingCallback();
      if (previousActiveElement && typeof previousActiveElement.focus === 'function') {
        try { previousActiveElement.focus(); } catch (e) {}
        previousActiveElement = null;
      }
    }
  });

  openModal('gymConfirmSheet');

  // Bug 12: фокус на безопасной кнопке при открытии.
  setTimeout(() => {
    const cancelBtnEl = document.getElementById('gymConfirmSheetCancelBtn');
    if (cancelBtnEl && typeof cancelBtnEl.focus === 'function') {
      try { cancelBtnEl.focus(); } catch (e) {}
    }
  }, 50);
}
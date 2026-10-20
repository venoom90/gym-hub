import { state, setInitialData, setQuotaWarningHandler } from './state.js';
import { fetchAnalyticsData } from './api.js';
import { renderOverviewModule } from './overview.js';
import { renderAnalyticsModule } from './analytics.js';
import { renderCoachModule } from './coach.js';
import { initSyncModule, renderSyncModule, handleIncomingReportText } from './sync.js';
import { initLiveWorkoutModule } from './live_workout.js';
import { registerModal, openModal, closeModal } from './modal_manager.js';
import { showToast, showErrorToast, showWarningToast } from './ui.js';

const SHARE_CACHE_NAME = 'gym-share-mailbox';
const LAST_SYNC_KEY = 'gym_last_sync_ts';
const GAS_CACHE_NAME = 'gym-gas-cache-v2';

let refreshSeq = 0;
let lastDataHash = '';

document.addEventListener('DOMContentLoaded', async () => {
  setQuotaWarningHandler(showWarningToast);

  initServiceWorker();
  initNavigation();
  initNetworkStatus();
  initLastSyncLabel();
  initSettingsModal();
  initRefreshButton();

  initSyncModule(async () => {
    await refreshApplicationData({ force: true });
  });

  initLiveWorkoutModule(async () => {
    await refreshApplicationData({ force: true });
  });

  const hasSharedData = await checkSharedReportCache();

  if (!hasSharedData) {
    handleRouteHash();
  }

  await refreshApplicationData({ force: true });
});

/* =========================================================
 * SERVICE WORKER (V54)
 * ========================================================= */

function initServiceWorker() {
  if (!('serviceWorker' in navigator)) return;

  const wasControlled = Boolean(navigator.serviceWorker.controller);
  let refreshing = false;
  // V54: Флаг для игнорирования первого SW_UPDATED при первичной установке.
  let isSwFirstInstall = !wasControlled;

  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (refreshing) return;
    if (!wasControlled) return;
    refreshing = true;
    location.reload();
  });

  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.type === 'SW_UPDATED') {
      // Показываем баннер только если страница уже была под контролем ДО этого запуска
      if (navigator.serviceWorker.controller && !isSwFirstInstall) {
        showSwUpdateBanner(event.data.version || '');
      }
      // После обработки первого сообщения сбрасываем флаг
      isSwFirstInstall = false;
    }
  });

  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js')
      .then(reg => {
        console.log('[SW] Успешно зарегистрирован, scope:', reg.scope);
        try {
          setInterval(() => { reg.update().catch(() => {}); }, 3600000);
        } catch (e) {}
      })
      .catch(err => {
        console.warn('[SW] Ошибка регистрации:', err);
      });
  });
}

function showSwUpdateBanner(version) {
  if (document.getElementById('swUpdateBanner')) return;

  const banner = document.createElement('div');
  banner.id = 'swUpdateBanner';
  banner.setAttribute('role', 'status');
  banner.setAttribute('aria-live', 'polite');
  banner.style.cssText = [
    'position:fixed',
    'left:16px',
    'right:16px',
    'bottom:calc(88px + env(safe-area-inset-bottom, 0px))',
    'padding:12px 16px',
    'border-radius:var(--md-sys-shape-corner-large)',
    'background:var(--md-sys-color-primary-container)',
    'color:var(--md-sys-color-on-primary-container)',
    'border:1px solid var(--md-sys-color-primary)',
    'font:var(--md-sys-typescale-body-medium)',
    'font-weight:500',
    'z-index:4000',
    'box-shadow:0 4px 16px rgba(0,0,0,0.4)',
    'display:flex',
    'align-items:center',
    'justify-content:space-between',
    'gap:12px'
  ].join(';');

  banner.innerHTML = `
    <span>Доступна новая версия приложения${version ? ' (' + version + ')' : ''}.</span>
    <button type="button" id="swUpdateBannerBtn" style="
      padding:8px 14px;
      border-radius:var(--md-sys-shape-corner-medium);
      border:none;
      background:var(--md-sys-color-primary);
      color:#00325e;
      font:600 0.85rem/1 'Roboto';
      cursor:pointer;
      flex-shrink:0;
      min-height:36px;
    ">Обновить</button>
  `;
  document.body.appendChild(banner);

  const btn = document.getElementById('swUpdateBannerBtn');
  if (btn) {
    btn.onclick = async () => {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg && reg.waiting) {
          reg.waiting.postMessage({ type: 'SKIP_WAITING' });
        } else {
          location.reload();
        }
      } catch (e) {
        console.warn('[App] SW update failed:', e);
        location.reload();
      }
    };
  }
}

/* =========================================================
 * NAVIGATION
 * ========================================================= */

function navigateToTab(tabName) {
  const targetHash = `tab-${tabName}`;
  history.replaceState({ __gymBaseline: true }, '', '#' + targetHash);
  handleRouteHash();
}

function initNavigation() {
  const navItems = document.querySelectorAll('#bottomNav .nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const targetTab = item.getAttribute('data-tab');
      if (targetTab) {
        navigateToTab(targetTab);
      }
    });
  });
}

function handleRouteHash() {
  const allowedTabs = ['overview', 'analytics', 'coach', 'sync'];
  const hash = window.location.hash.replace('#', '') || 'tab-overview';
  let tabName = hash.replace('tab-', '');

  if (!allowedTabs.includes(tabName)) {
    tabName = 'overview';
  }

  const tabs = {
    overview: document.getElementById('tab-overview'),
    analytics: document.getElementById('tab-analytics'),
    coach: document.getElementById('tab-coach'),
    sync: document.getElementById('tab-sync')
  };

  const navItems = document.querySelectorAll('#bottomNav .nav-item');
  navItems.forEach(n => {
    n.classList.toggle('active', n.getAttribute('data-tab') === tabName);
  });

  Object.keys(tabs).forEach(k => {
    if (tabs[k]) {
      tabs[k].classList.toggle('active', k === tabName);
    }
  });

  if (tabName === 'overview') renderOverviewModule();
  if (tabName === 'analytics') renderAnalyticsModule();
  if (tabName === 'coach') renderCoachModule();
  if (tabName === 'sync') renderSyncModule();

  window.scrollTo({ top: 0, behavior: 'smooth' });
}

/* =========================================================
 * SHARE TARGET
 * ========================================================= */

async function checkSharedReportCache() {
  if (!('caches' in window)) return false;
  try {
    const cache = await caches.open(SHARE_CACHE_NAME);
    const cachedResponse = await cache.match('shared-workout-data');
    if (cachedResponse) {
      const reportText = await cachedResponse.text();
      await cache.delete('shared-workout-data');
      if (reportText && reportText.trim()) {
        history.replaceState({ __gymBaseline: true }, '', '#tab-sync');
        handleRouteHash();
        handleIncomingReportText(reportText);
        return true;
      }
    }
  } catch (err) {
    console.warn('[App] Ошибка проверки входящего шэринга:', err);
  }
  return false;
}

/* =========================================================
 * DATA REFRESH
 * ========================================================= */

function computeDataHash(data) {
  if (!data) return '';
  try {
    return [
      (data.sets || []).length,
      (data.workouts || []).length,
      (data.cycles || []).length,
      (data.exercises || []).length,
      data.currentCycleId || '',
      data.suggestedNextCycleId || ''
    ].join('|');
  } catch (e) {
    return '';
  }
}

function isUserTyping() {
  const ae = document.activeElement;
  if (!ae) return false;
  const tag = ae.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function renderActiveTab(tabName, force) {
  if (!force && isUserTyping()) return;
  if (tabName === 'overview') renderOverviewModule();
  if (tabName === 'analytics') renderAnalyticsModule();
  if (tabName === 'coach') renderCoachModule();
  if (tabName === 'sync') renderSyncModule();
}

async function refreshApplicationData(opts) {
  const options = opts || {};
  const force = Boolean(options.force);
  const noCache = Boolean(options.noCache);

  const mySeq = ++refreshSeq;
  const refreshBtn = document.getElementById('refreshDataBtn');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.setAttribute('aria-busy', 'true');
  }

  let res;
  try {
    res = await fetchAnalyticsData({ noCache });
  } catch (err) {
    res = { success: false, error: err.message || 'Network error', fromCache: false, cacheAgeMs: 0 };
  } finally {
    if (mySeq === refreshSeq && refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.removeAttribute('aria-busy');
    }
  }

  if (mySeq !== refreshSeq) return;

  if (!res.success || !res.data) {
    if (navigator.onLine) {
      showErrorToast('Не удалось обновить данные: ' + (res.error || 'нет связи'));
    }
    return;
  }

  const newHash = computeDataHash(res.data);
  const changed = (newHash !== lastDataHash);
  lastDataHash = newHash;

  setInitialData(res.data);

  const syncTimestamp = (res.fromCache && res.cacheAgeMs > 0)
    ? (Date.now() - res.cacheAgeMs)
    : Date.now();
  localStorage.setItem(LAST_SYNC_KEY, String(syncTimestamp));
  renderLastSyncLabel();

  if (!changed && !force) return;

  const activeNav = document.querySelector('#bottomNav .nav-item.active');
  const curTab = activeNav ? activeNav.getAttribute('data-tab') : 'overview';
  renderActiveTab(curTab, force);
}

function initRefreshButton() {
  const btn = document.getElementById('refreshDataBtn');
  if (btn) {
    btn.onclick = async () => {
      if (btn.disabled) return;
      await refreshApplicationData({ force: true, noCache: true });
    };
  }
}

/* =========================================================
 * NETWORK / SYNC LABEL
 * ========================================================= */

function initNetworkStatus() {
  const dot = document.getElementById('networkStatusDot');
  const update = () => {
    if (!dot) return;
    if (navigator.onLine) {
      dot.classList.remove('offline');
      dot.title = 'Сетевой статус: Онлайн';
    } else {
      dot.classList.add('offline');
      dot.title = 'Сетевой статус: Оффлайн';
    }
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

function getLastSyncLabel() {
  const ts = parseInt(localStorage.getItem(LAST_SYNC_KEY) || '0', 10);
  if (!ts) return 'Нет данных';
  const diffMin = Math.floor((Date.now() - ts) / 60000);
  if (diffMin < 1) return 'Обновлено сейчас';
  if (diffMin < 60) return `Обновлено ${diffMin} мин назад`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) return `Обновлено ${diffH} ч назад`;
  return 'Устарело — обновите';
}

function renderLastSyncLabel() {
  const el = document.getElementById('lastSyncLabel');
  if (!el) return;
  el.innerText = getLastSyncLabel();
  const ts = parseInt(localStorage.getItem(LAST_SYNC_KEY) || '0', 10);
  const stale = !ts || (Date.now() - ts > 24 * 3600 * 1000);
  el.style.color = stale ? 'var(--app-color-warning)' : 'var(--md-sys-color-on-surface-variant)';
}

function initLastSyncLabel() {
  renderLastSyncLabel();
  setInterval(renderLastSyncLabel, 60000);
}

/* =========================================================
 * SETTINGS
 * ========================================================= */

function initSettingsModal() {
  const modal = document.getElementById('settingsModal');
  const openBtn = document.getElementById('openSettingsBtn');
  const closeBtn = document.getElementById('closeSettingsBtn');
  const tokenInput = document.getElementById('apiTokenInput');
  const saveBtn = document.getElementById('saveApiTokenBtn');

  if (!modal || !openBtn || !closeBtn) return;

  registerModal('settingsModal', {
    el: modal,
    displayStyle: 'flex',
    onOpen: () => {
      if (tokenInput) tokenInput.value = localStorage.getItem('gym_api_token') || '';
    }
  });

  openBtn.onclick = () => openModal('settingsModal');
  closeBtn.onclick = () => closeModal('settingsModal');
  modal.onclick = (e) => {
    if (e.target === modal) closeModal('settingsModal');
  };

  if (saveBtn && tokenInput) {
    saveBtn.onclick = async () => {
      const val = tokenInput.value.trim();
      const prevToken = localStorage.getItem('gym_api_token') || '';
      localStorage.setItem('gym_api_token', val);
      closeModal('settingsModal');

      const tokenChanged = (val !== prevToken);

      if (tokenChanged) {
        try {
          if ('caches' in window) {
            await caches.delete(GAS_CACHE_NAME);
            console.log('[App] GAS-кэш очищен после смены токена');
          }
        } catch (e) {
          console.warn('[App] Не удалось очистить GAS-кэш:', e);
        }
      }

      showToast('Токен авторизации сохранён', 'success');

      if (tokenChanged) {
        await refreshApplicationData({ force: true, noCache: true });
      }
    };
  }
}
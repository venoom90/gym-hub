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

let refreshSeq = 0;
let lastDataHash = '';

document.addEventListener('DOMContentLoaded', async () => {
  // V51: регистрируем quota-warning handler ДО первого setDbData.
  // State больше не импортирует ui.js (устранена циклическая зависимость).
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

function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then(reg => {
          console.log('[SW] Успешно зарегистрирован, scope:', reg.scope);
        })
        .catch(err => {
          console.warn('[SW] Ошибка регистрации:', err);
        });
    });
  }
}

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

  const mySeq = ++refreshSeq;
  const refreshBtn = document.getElementById('refreshDataBtn');
  if (refreshBtn) {
    refreshBtn.disabled = true;
    refreshBtn.setAttribute('aria-busy', 'true');
  }

  let res;
  try {
    res = await fetchAnalyticsData();
  } catch (err) {
    res = { success: false, error: err.message || 'Network error' };
  } finally {
    if (mySeq === refreshSeq && refreshBtn) {
      refreshBtn.disabled = false;
      refreshBtn.removeAttribute('aria-busy');
    }
  }

  if (mySeq !== refreshSeq) return;

  if (!res.success || !res.data) {
    showErrorToast('Не удалось обновить данные: ' + (res.error || 'нет связи'));
    return;
  }

  const newHash = computeDataHash(res.data);
  const changed = (newHash !== lastDataHash);
  lastDataHash = newHash;

  setInitialData(res.data);
  localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
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
      await refreshApplicationData({ force: false });
    };
  }
}

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
    saveBtn.onclick = () => {
      const val = tokenInput.value.trim();
      localStorage.setItem('gym_api_token', val);
      closeModal('settingsModal');
      showToast('Токен авторизации сохранён', 'success');
    };
  }
}
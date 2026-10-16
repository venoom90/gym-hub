import { state, setInitialData } from './state.js';
import { fetchAnalyticsData } from './api.js';
import { renderOverviewModule } from './overview.js';
import { renderAnalyticsModule } from './analytics.js';
import { renderCoachModule } from './coach.js';
import { initSyncModule, renderSyncModule, handleIncomingReportText } from './sync.js';
import { initLiveWorkoutModule } from './live_workout.js';
import { registerModal, openModal, closeModal } from './modal_manager.js';

const SHARE_CACHE_NAME = 'gym-share-mailbox';
const LAST_SYNC_KEY = 'gym_last_sync_ts';

document.addEventListener('DOMContentLoaded', async () => {
  initServiceWorker();
  initNavigation();
  initNetworkStatus();
  initLastSyncLabel();
  initSettingsModal();
  initRefreshButton();

  initSyncModule(async () => {
    await refreshApplicationData();
  });

  initLiveWorkoutModule(async () => {
    await refreshApplicationData();
  });

  const hasSharedData = await checkSharedReportCache();

  if (!hasSharedData) {
    handleRouteHash();
  }

  await refreshApplicationData();
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

function initNavigation() {
  const navItems = document.querySelectorAll('#bottomNav .nav-item');
  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const targetTab = item.getAttribute('data-tab');
      if (targetTab) {
        window.location.hash = `tab-${targetTab}`;
      }
    });
  });

  window.addEventListener('hashchange', () => {
    handleRouteHash();
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
        window.location.hash = 'tab-sync';
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

async function refreshApplicationData() {
  const statusDot = document.getElementById('networkStatusDot');
  if (statusDot) statusDot.classList.add('offline');

  const res = await fetchAnalyticsData();
  if (res.success && res.data) {
    setInitialData(res.data);
    localStorage.setItem(LAST_SYNC_KEY, String(Date.now()));
    renderLastSyncLabel();
    if (statusDot) statusDot.classList.remove('offline');

    const activeNav = document.querySelector('#bottomNav .nav-item.active');
    const curTab = activeNav ? activeNav.getAttribute('data-tab') : 'overview';

    if (curTab === 'overview') renderOverviewModule();
    if (curTab === 'analytics') renderAnalyticsModule();
    if (curTab === 'coach') renderCoachModule();
    if (curTab === 'sync') renderSyncModule();
  } else {
    console.warn('[App] Сервер вернул ошибку или нет связи:', res.error);
  }
}

function initRefreshButton() {
  const btn = document.getElementById('refreshDataBtn');
  if (btn) {
    btn.onclick = async () => {
      btn.disabled = true;
      await refreshApplicationData();
      btn.disabled = false;
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

  // V5.4.0: регистрация через ModalManager (hardware back корректно закрывает)
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
      alert('Токен авторизации сохранен!');
    };
  }
}
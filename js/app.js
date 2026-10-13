import { state, setInitialData } from './state.js';
import { fetchAnalyticsData } from './api.js';
import { renderOverviewModule } from './overview.js';
import { renderAnalyticsModule } from './analytics.js';
import { renderCoachModule } from './coach.js';
import { initSyncModule, renderSyncModule, handleIncomingReportText } from './sync.js';

let deferredInstallPrompt = null;
const SHARE_CACHE_NAME = 'gym-share-temp-v34';

document.addEventListener('DOMContentLoaded', async () => {
  initServiceWorker();
  initPwaInstall();
  initNavigation();
  initNetworkStatus();
  initSettingsModal();
  initRefreshButton();

  initSyncModule(async () => {
    await refreshApplicationData();
  });

  // 1. Первичная проверка входящего шэринга отчета (ДО загрузки с сервера)
  await checkSharedReportCache();

  // 2. Первичная отрисовка активной вкладки из локального кэша
  handleRouteHash();

  // 3. Фоновое обновление базы данных с сервера Google Таблиц
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

function initPwaInstall() {
  const installBtn = document.getElementById('installAppBtn');

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (installBtn) {
      installBtn.style.display = 'inline-flex';
      installBtn.onclick = async () => {
        if (!deferredInstallPrompt) return;
        deferredInstallPrompt.prompt();
        const choice = await deferredInstallPrompt.userChoice;
        if (choice.outcome === 'accepted') {
          installBtn.style.display = 'none';
        }
        deferredInstallPrompt = null;
      };
    }
  });

  window.addEventListener('appinstalled', () => {
    if (installBtn) installBtn.style.display = 'none';
    deferredInstallPrompt = null;
    console.log('[PWA] Приложение успешно установлено на устройство.');
  });
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

  // Защита от неизвестного хэша с гарантированным переходом на обзор
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
  if (!('caches' in window)) return;

  try {
    const cache = await caches.open(SHARE_CACHE_NAME);
    const cachedResponse = await cache.match('shared-workout-data');
    if (cachedResponse) {
      const reportText = await cachedResponse.text();
      await cache.delete('shared-workout-data');

      if (reportText && reportText.trim()) {
        window.location.hash = 'tab-sync';
        handleIncomingReportText(reportText);
      }
    }
  } catch (err) {
    console.warn('[App] Ошибка проверки шэринга отчета:', err);
  }
}

async function refreshApplicationData() {
  const statusDot = document.getElementById('networkStatusDot');
  if (statusDot) statusDot.classList.add('offline');

  const res = await fetchAnalyticsData();
  if (res.success && res.data) {
    setInitialData(res.data);
    if (statusDot) statusDot.classList.remove('offline');

    const activeNav = document.querySelector('#bottomNav .nav-item.active');
    const curTab = activeNav ? activeNav.getAttribute('data-tab') : 'overview';

    if (curTab === 'overview') renderOverviewModule();
    if (curTab === 'analytics') renderAnalyticsModule();
    if (curTab === 'coach') renderCoachModule();
    if (curTab === 'sync') renderSyncModule();
  } else {
    console.warn('[App] Сервер вернул ошибку или нет сети:', res.error);
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

function initSettingsModal() {
  const modal = document.getElementById('settingsModal');
  const openBtn = document.getElementById('openSettingsBtn');
  const closeBtn = document.getElementById('closeSettingsBtn');
  const tokenInput = document.getElementById('apiTokenInput');
  const saveBtn = document.getElementById('saveApiTokenBtn');

  if (!modal || !openBtn || !closeBtn) return;

  openBtn.onclick = () => {
    if (tokenInput) tokenInput.value = localStorage.getItem('gym_api_token') || '';
    modal.style.display = 'flex';
  };

  closeBtn.onclick = () => { modal.style.display = 'none'; };
  modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };

  if (saveBtn && tokenInput) {
    saveBtn.onclick = () => {
      const val = tokenInput.value.trim();
      localStorage.setItem('gym_api_token', val);
      modal.style.display = 'none';
      alert('Токен авторизации сохранен!');
    };
  }
}
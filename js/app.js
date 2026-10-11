import { state, setActiveTab, setDbData, setGeminiApiKey } from './state.js';
import { fetchAnalyticsData } from './api.js';
import { renderOverviewModule } from './overview.js';
import { renderAnalyticsModule } from './analytics.js';
import { initSyncModule, handleIncomingReportText } from './sync.js';

let deferredPrompt = null;
const SHARE_CACHE_NAME = 'gym-share-temp-v30';

document.addEventListener('DOMContentLoaded', async () => {
  initServiceWorker();
  initNetworkStatus();
  initNavigation();
  initSettingsModal();
  initInstallPrompt();
  initSyncModule(handleDataReload);

  // Мгновенная проверка шэринга до тяжелых сетевых запросов
  checkCachedShareData();

  await loadCachedOrRemoteData();
});

function initServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: '/gym-hub/' }).then((reg) => {
      console.log('[SW] Зарегистрирован:', reg.scope);
    }).catch((err) => {
      console.warn('[SW] Ошибка регистрации:', err);
    });

    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'SHARED_WORKOUT_TEXT') {
        switchTabToSync(event.data.text);
      }
    });
  }
}

async function checkCachedShareData(retries = 8) {
  try {
    const cache = await caches.open(SHARE_CACHE_NAME);
    const response = await cache.match('/gym-hub/shared-workout-data');
    if (response) {
      const data = await response.json();
      if (data && data.text && (Date.now() - data.timestamp < 300000)) {
        await cache.delete('/gym-hub/shared-workout-data');
        if (window.location.search.includes('shared=1')) {
          window.history.replaceState({}, document.title, window.location.pathname);
        }
        switchTabToSync(data.text);
        return;
      }
    }
  } catch (e) {
    console.warn('[Share] Ошибка вычитки данных из Cache Storage:', e);
  }

  if (retries > 0 && window.location.search.includes('shared=1')) {
    setTimeout(() => checkCachedShareData(retries - 1), 150);
  }
}

function switchTabToSync(reportText) {
  const syncNav = document.querySelector('.nav-item[data-tab="sync"]');
  if (syncNav) {
    syncNav.click();
  } else {
    document.querySelectorAll('.tab-content').forEach((tab) => tab.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach((n) => n.classList.remove('active'));
    const syncTab = document.getElementById('tab-sync');
    if (syncTab) syncTab.classList.add('active');
    setActiveTab('sync');
  }

  if (reportText) {
    handleIncomingReportText(reportText);
  }
}

function initNetworkStatus() {
  const dot = document.getElementById('networkStatusDot');
  const update = () => {
    state.isOnline = navigator.onLine;
    if (dot) {
      if (state.isOnline) {
        dot.classList.remove('offline');
        dot.title = 'Сетевой статус: Онлайн';
      } else {
        dot.classList.add('offline');
        dot.title = 'Сетевой статус: Оффлайн (Локальный кэш)';
      }
    }
  };
  window.addEventListener('online', update);
  window.addEventListener('offline', update);
  update();
}

function initNavigation() {
  const navItems = document.querySelectorAll('.nav-item');
  navItems.forEach((item) => {
    item.addEventListener('click', () => {
      const targetTab = item.getAttribute('data-tab');
      navItems.forEach((n) => n.classList.remove('active'));
      item.classList.add('active');

      document.querySelectorAll('.tab-content').forEach((tab) => {
        tab.classList.remove('active');
      });

      const activeSection = document.getElementById(`tab-${targetTab}`);
      if (activeSection) activeSection.classList.add('active');

      setActiveTab(targetTab);

      if (targetTab === 'overview') renderOverviewModule();
      if (targetTab === 'analytics') renderAnalyticsModule();
    });
  });

  const refreshBtn = document.getElementById('refreshDataBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.style.animation = 'spin 1s infinite linear';
      await handleDataReload();
      refreshBtn.style.animation = '';
    });
  }
}

function initSettingsModal() {
  const modal = document.getElementById('settingsModal');
  const openBtn = document.getElementById('openSettingsBtn');
  const closeBtn = document.getElementById('closeSettingsBtn');
  const saveBtn = document.getElementById('saveApiKeyBtn');
  const input = document.getElementById('geminiApiKeyInput');

  if (!modal || !openBtn) return;

  openBtn.onclick = () => {
    if (input) input.value = state.geminiApiKey;
    modal.style.display = 'flex';
  };

  closeBtn.onclick = () => { modal.style.display = 'none'; };
  modal.onclick = (e) => { if (e.target === modal) modal.style.display = 'none'; };

  saveBtn.onclick = () => {
    if (input) {
      setGeminiApiKey(input.value);
      modal.style.display = 'none';
      alert('API ключ Gemini успешно сохранен.');
    }
  };
}

function initInstallPrompt() {
  const installBtn = document.getElementById('installAppBtn');
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;
    if (installBtn) installBtn.style.display = 'inline-flex';
  });

  if (installBtn) {
    installBtn.onclick = async () => {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if (choice.outcome === 'accepted') {
        installBtn.style.display = 'none';
      }
      deferredPrompt = null;
    };
  }
}

async function loadCachedOrRemoteData() {
  const cachedStr = localStorage.getItem('gym_cached_db_data');
  if (cachedStr) {
    try {
      const cachedData = JSON.parse(cachedStr);
      setDbData(cachedData);
      if (state.activeTab === 'overview') renderOverviewModule();
      if (state.activeTab === 'analytics') renderAnalyticsModule();
    } catch (e) {
      console.warn('[Cache] Ошибка чтения локального кэша:', e);
    }
  }

  await handleDataReload();
}

async function handleDataReload() {
  const res = await fetchAnalyticsData();
  if (res.success && res.data) {
    setDbData(res.data);
    localStorage.setItem('gym_cached_db_data', JSON.stringify(res.data));
    if (state.activeTab === 'overview') renderOverviewModule();
    if (state.activeTab === 'analytics') renderAnalyticsModule();
  }
}
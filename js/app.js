import { fetchAnalyticsData } from './api.js';
import { renderOverviewModule } from './overview.js';
import { renderAnalyticsModule, runGeminiCycleAudit } from './analytics.js';
import { initSyncModule, handleIncomingReportText } from './sync.js';
import { state } from './state.js';

let deferredInstallPrompt = null;

const CACHE_KEY_DB = 'gym_cached_db_data';
const SHARE_CACHE_NAME = 'gym-share-temp-v23';

function loadLocalCachedData() {
  try {
    const raw = localStorage.getItem(CACHE_KEY_DB);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        state.dbData = {
          sets: parsed.sets || [],
          cyclesSummary: parsed.cyclesSummary || [],
          catalog: parsed.catalog || [],
          currentCycleId: parsed.currentCycleId || 'C-1'
        };
        return true;
      }
    }
  } catch (e) {
    console.warn('[Offline Cache] Ошибка чтения данных из localStorage:', e);
  }
  return false;
}

function updateNetworkStatus() {
  const dot = document.getElementById('networkStatusDot');
  if (!dot) return;
  if (navigator.onLine) {
    dot.classList.remove('offline');
    dot.title = 'Сетевой статус: Онлайн';
  } else {
    dot.classList.add('offline');
    dot.title = 'Сетевой статус: Оффлайн (локальная память)';
  }
}

async function syncDataWithServer(isManual = false) {
  try {
    await fetchAnalyticsData();
    if (state.dbData && (state.dbData.sets || []).length > 0) {
      localStorage.setItem(CACHE_KEY_DB, JSON.stringify(state.dbData));
    }
    safeRenderOverview();
    safeRenderAnalytics();
    updateNetworkStatus();
  } catch (err) {
    console.warn('[Offline Sync] Сеть недоступна, используются локальные данные:', err.message);
    const dot = document.getElementById('networkStatusDot');
    if (dot) dot.classList.add('offline');
    if (isManual) {
      alert('Нет связи с сервером Google Таблиц. Отображаются данные из памяти устройства.');
    }
  }
}

function safeRenderOverview() {
  try {
    renderOverviewModule();
  } catch (err) {
    console.error('[Render Error] Ошибка отрисовки модуля Обзор:', err);
  }
}

function safeRenderAnalytics() {
  try {
    renderAnalyticsModule();
  } catch (err) {
    console.error('[Render Error] Ошибка отрисовки модуля Аналитика:', err);
  }
}

function switchTab(tabId) {
  document.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));

  const targetTab = document.getElementById(`tab-${tabId}`);
  if (targetTab) targetTab.classList.add('active');

  const targetNavItem = document.querySelector(`.nav-item[data-tab="${tabId}"]`);
  if (targetNavItem) targetNavItem.classList.add('active');

  if (tabId === 'overview') safeRenderOverview();
  if (tabId === 'analytics') safeRenderAnalytics();
}

function initNavigation() {
  const nav = document.getElementById('bottomNav');
  if (!nav) return;

  nav.addEventListener('click', (e) => {
    const item = e.target.closest('.nav-item');
    if (item && item.dataset.tab) {
      switchTab(item.dataset.tab);
    }
  });

  const refreshBtn = document.getElementById('refreshDataBtn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', async () => {
      await syncDataWithServer(true);
    });
  }
}

function initModals() {
  const settingsModal = document.getElementById('settingsModal');
  const openSettingsBtn = document.getElementById('openSettingsBtn');
  const closeSettingsBtn = document.getElementById('closeSettingsBtn');
  const saveApiKeyBtn = document.getElementById('saveApiKeyBtn');
  const apiKeyInput = document.getElementById('geminiApiKeyInput');

  if (openSettingsBtn && settingsModal) {
    openSettingsBtn.addEventListener('click', () => {
      apiKeyInput.value = localStorage.getItem('gemini_api_key') || '';
      settingsModal.style.display = 'flex';
    });
  }

  if (closeSettingsBtn) {
    closeSettingsBtn.addEventListener('click', () => {
      settingsModal.style.display = 'none';
    });
  }

  if (saveApiKeyBtn) {
    saveApiKeyBtn.addEventListener('click', () => {
      localStorage.setItem('gemini_api_key', apiKeyInput.value.trim());
      settingsModal.style.display = 'none';
      alert('Ключ Gemini API успешно сохранен!');
    });
  }

  const dayModal = document.getElementById('daySummaryModal');
  const closeDayModalBtn = document.getElementById('closeDayModalBtn');
  if (closeDayModalBtn && dayModal) {
    closeDayModalBtn.addEventListener('click', () => {
      dayModal.style.display = 'none';
    });
  }

  const runAuditBtn = document.getElementById('runAiAuditBtn');
  if (runAuditBtn) {
    runAuditBtn.addEventListener('click', () => {
      runGeminiCycleAudit();
    });
  }
}

function initServiceWorkerAndShareTarget() {
  const installBtn = document.getElementById('installAppBtn');

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js', { scope: '/gym-hub/' }).catch((err) => {
        console.warn('Регистрация Service Worker отклонена:', err);
      });
    });

    navigator.serviceWorker.addEventListener('message', (event) => {
      if (event.data && event.data.type === 'SHARED_WORKOUT_TEXT') {
        switchTab('sync');
        handleIncomingReportText(event.data.text);
      }
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (installBtn) installBtn.style.display = 'inline-flex';
  });

  if (installBtn) {
    installBtn.addEventListener('click', async () => {
      if (deferredInstallPrompt) {
        deferredInstallPrompt.prompt();
        deferredInstallPrompt = null;
        installBtn.style.display = 'none';
      }
    });
  }

  checkCachedShareData();
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
        switchTab('sync');
        handleIncomingReportText(data.text);
        return;
      }
    }
  } catch (e) {
    console.warn('Ошибка вычитки данных из Cache Storage:', e);
  }

  if (retries > 0 && window.location.search.includes('shared=1')) {
    setTimeout(() => checkCachedShareData(retries - 1), 150);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  initNavigation();
  initModals();
  initSyncModule(() => {
    if (state.dbData) {
      localStorage.setItem(CACHE_KEY_DB, JSON.stringify(state.dbData));
    }
    safeRenderOverview();
    safeRenderAnalytics();
  });
  initServiceWorkerAndShareTarget();

  window.addEventListener('online', updateNetworkStatus);
  window.addEventListener('offline', updateNetworkStatus);
  updateNetworkStatus();

  loadLocalCachedData();
  safeRenderOverview();

  syncDataWithServer(false);
});
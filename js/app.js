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

// V49 D: race protection и dedup-хэш.
let refreshSeq = 0;
let lastDataHash = '';
let toastTimeout = null;

document.addEventListener('DOMContentLoaded', async () => {
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

/**
 * V49 D: tab-navigation через history.replaceState.
 * Не создаёт записей в истории, не срабатывает hashchange, не конфликтует
 * с pushState/popstate в modal_manager.js (см. fix 2.2 аудита).
 * __gymBaseline сохраняется, чтобы back из модала корректно распознавался.
 */
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
  // V49 D: hashchange-listener убран. navigateToTab вызывает handleRouteHash()
  // синхронно; слушатель приводил к двойному рендеру и конфликту с popstate.
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
        // V49 D: replaceState вместо location.hash (не создаёт запись, не
        // сбивает baseline-state, согласовано с modal_manager).
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

/**
 * Лёгкий хэш «изменились ли данные». Только ключевые метрики — набор
 * элементов, идентификаторы циклов. Не ловит правки внутри существующих
 * сетов (это и не нужно для «не дёргать UI при ручном refresh»).
 */
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

/**
 * Пользователь сейчас набирает текст / держит открытый дропдаун.
 * Перерисовка активной вкладки сбила бы фокус, выделение и ввод.
 */
function isUserTyping() {
  const ae = document.activeElement;
  if (!ae) return false;
  const tag = ae.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

function render
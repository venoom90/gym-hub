import { state, setInitialData } from './state.js';
import { fetchAnalyticsData } from './api.js';
import { renderOverviewModule } from './overview.js';
import { renderAnalyticsModule } from './analytics.js';
import { renderCoachModule } from './coach.js';
import { renderSyncModule } from './sync.js';

document.addEventListener('DOMContentLoaded', async () => {
  initNavigation();
  initNetworkStatus();
  initSettingsModal();
  initRefreshButton();

  // Начальная загрузка данных через GAS
  await refreshApplicationData();
});

function initNavigation() {
  const navItems = document.querySelectorAll('#bottomNav .nav-item');
  const tabs = {
    overview: document.getElementById('tab-overview'),
    analytics: document.getElementById('tab-analytics'),
    coach: document.getElementById('tab-coach'),
    sync: document.getElementById('tab-sync')
  };

  navItems.forEach(item => {
    item.addEventListener('click', () => {
      const targetTab = item.getAttribute('data-tab');
      if (!targetTab || !tabs[targetTab]) return;

      navItems.forEach(n => n.classList.remove('active'));
      item.classList.add('active');

      Object.keys(tabs).forEach(k => {
        if (tabs[k]) tabs[k].classList.remove('active');
      });
      tabs[targetTab].classList.add('active');

      // Ленивая отрисовка активного модуля
      if (targetTab === 'overview') renderOverviewModule();
      if (targetTab === 'analytics') renderAnalyticsModule();
      if (targetTab === 'coach') renderCoachModule();
      if (targetTab === 'sync') renderSyncModule();

      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  });
}

async function refreshApplicationData() {
  const statusDot = document.getElementById('networkStatusDot');
  if (statusDot) statusDot.classList.add('offline');

  const res = await fetchAnalyticsData();
  if (res.success && res.data) {
    setInitialData(res.data);
    if (statusDot) statusDot.classList.remove('offline');

    // Отрисовка активной вкладки
    const activeNav = document.querySelector('#bottomNav .nav-item.active');
    const curTab = activeNav ? activeNav.getAttribute('data-tab') : 'overview';

    if (curTab === 'overview') renderOverviewModule();
    if (curTab === 'analytics') renderAnalyticsModule();
    if (curTab === 'coach') renderCoachModule();
    if (curTab === 'sync') renderSyncModule();
  } else {
    console.warn('[App] Не удалось обновить данные с сервера.');
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
      alert('Токен авторизации сохранен в локальной памяти!');
    };
  }
}
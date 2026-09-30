const state = {
  settings: null,
  versions: [],
  selectedVersion: null,
  rank: null,
  manifest: null,
  accounts: [],
  activeAccountId: null,
  servers: [],
  instances: [],
  achievements: [],
  lastLevel: null,
  modUpdates: [],
  shareCardDataUrl: null
};

const THEME_COLORS = [
  '#ff8c1a', // نارنجی (پیش‌فرض)
  '#ff3c3c', // قرمز
  '#3b82f6', // آبی
  '#a855f7', // بنفش
  '#14b8a6', // فیروزه‌ای
  '#22c55e', // سبز
  '#ec4899', // صورتی
  '#eab308'  // طلایی
];

const HOME_TIP_KEYS = ['home.tip1', 'home.tip2', 'home.tip3', 'home.tip4', 'home.tip5', 'home.tip6'];

function currentLang() {
  return (state.settings && state.settings.lang) || 'fa';
}
function tt(key) {
  return t(key, currentLang());
}

// ===================== دیالوگ‌های تمی (جایگزین alert/confirm/prompt مرورگر) =====================
let dialogResolve = null;
let dialogType = 'alert';

function showAlert(message) {
  return openThemedDialog({ type: 'alert', message });
}
function showConfirm(message, opts = {}) {
  return openThemedDialog({ type: 'confirm', message, danger: !!opts.danger, okText: opts.okText });
}
function showPrompt(message, defaultValue) {
  return openThemedDialog({ type: 'prompt', message, defaultValue: defaultValue || '' });
}

function openThemedDialog({ type, message, defaultValue, okText, danger }) {
  return new Promise((resolve) => {
    dialogResolve = resolve;
    dialogType = type;
    const overlay = document.getElementById('ph-dialog-overlay');
    const msgEl = document.getElementById('ph-dialog-message');
    const inputEl = document.getElementById('ph-dialog-input');
    const okBtn = document.getElementById('ph-dialog-ok');
    const cancelBtn = document.getElementById('ph-dialog-cancel');
    const iconEl = document.getElementById('ph-dialog-icon');

    msgEl.textContent = message;
    inputEl.style.display = type === 'prompt' ? 'block' : 'none';
    inputEl.value = defaultValue || '';
    cancelBtn.style.display = type === 'alert' ? 'none' : 'inline-flex';
    okBtn.textContent = okText || tt('dialog.ok');
    cancelBtn.textContent = tt('dialog.cancel');
    okBtn.classList.toggle('btn-danger', !!danger);
    iconEl.className = 'ph-dialog-icon' + (danger ? ' danger' : '');
    iconEl.innerHTML = `<i class="fa-solid ${danger ? 'fa-triangle-exclamation' : 'fa-circle-info'}"></i>`;

    overlay.classList.add('open');
    setTimeout(() => { if (type === 'prompt') { inputEl.focus(); inputEl.select(); } else { okBtn.focus(); } }, 60);
  });
}

function closeThemedDialog(value) {
  document.getElementById('ph-dialog-overlay').classList.remove('open');
  const resolve = dialogResolve;
  dialogResolve = null;
  if (resolve) resolve(value);
}

function cancelValueForCurrentDialog() {
  return dialogType === 'prompt' ? null : false;
}

document.getElementById('ph-dialog-ok').addEventListener('click', () => {
  if (dialogType === 'prompt') closeThemedDialog(document.getElementById('ph-dialog-input').value);
  else closeThemedDialog(true);
});
document.getElementById('ph-dialog-cancel').addEventListener('click', () => closeThemedDialog(cancelValueForCurrentDialog()));
document.getElementById('ph-dialog-overlay').addEventListener('click', (e) => {
  if (e.target.id === 'ph-dialog-overlay') closeThemedDialog(cancelValueForCurrentDialog());
});
document.getElementById('ph-dialog-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); closeThemedDialog(document.getElementById('ph-dialog-input').value); }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && document.getElementById('ph-dialog-overlay').classList.contains('open')) {
    closeThemedDialog(cancelValueForCurrentDialog());
  }
});

// ===================== INIT =====================
async function init() {
  state.settings = await window.ph.getSettings();
  applyTheme(state.settings.accentColor);
  applyLanguage(state.settings.lang || 'fa');
  showRandomTip();

  document.getElementById('input-mcdir').value = state.settings.mcDir || '';
  document.getElementById('input-java').value = state.settings.javaPath || '';
  document.getElementById('input-ram-min').value = state.settings.ramMin;
  document.getElementById('input-ram-max').value = state.settings.ramMax;
  document.getElementById('ram-min-val').textContent = state.settings.ramMin;
  document.getElementById('ram-max-val').textContent = state.settings.ramMax;
  document.getElementById('input-close-tray').checked = state.settings.closeToTray !== false;
  document.getElementById('input-minimize-launch').checked = state.settings.minimizeOnLaunch !== false;
  document.getElementById('input-game-booster').checked = !!state.settings.gameBoosterEnabled;
  document.getElementById('input-auto-backup').checked = !!state.settings.autoBackupEnabled;
  document.getElementById('input-backup-before-launch').checked = !!state.settings.autoBackupBeforeLaunch;
  document.getElementById('input-backup-interval').value = state.settings.autoBackupIntervalHours || 2;
  document.getElementById('backup-interval-val').textContent = state.settings.autoBackupIntervalHours || 2;
  document.getElementById('input-custom-jvm').value = state.settings.customJvmArgs || '';
  document.getElementById('input-custom-game').value = state.settings.customGameArgs || '';
  document.getElementById('input-discord-rpc').checked = !!state.settings.discordRpcEnabled;

  await refreshVersions();
  await refreshRank();
  await refreshAccounts();
  await refreshServers();
  await refreshInstances();
  buildThemePicker();
  listenForAchievementUnlocks();
  listenForJavaProgress();
  listenForModpackProgress();
  listenForCrashAnalysis();
  refreshPortableStatus();
  setupDragAndDrop();
  refreshLanGames();
  setInterval(refreshLanGames, 4000);
  setupKeyboardShortcuts();
  listenForProtocolActions();
  refreshRecentlyPlayed();
  checkLauncherUpdateBadge();

  if (state.settings.lastVersion && state.versions.some((v) => v.id === state.settings.lastVersion)) {
    selectVersion(state.settings.lastVersion);
  }

  if (!state.settings.onboardingComplete) {
    showOnboarding();
  }
}

function showRandomTip() {
  const el = document.getElementById('home-tip');
  const key = HOME_TIP_KEYS[Math.floor(Math.random() * HOME_TIP_KEYS.length)];
  el.textContent = tt(key);
}

function redrawAllForLanguage() {
  showRandomTip();
  renderVersionSelect();
  renderAccountsList();
  renderActiveAccountChip();
  renderServersList();
  renderRank();
  renderTools();
  updateSkinNote();
  if (state.manifest) renderDownloadList();
  renderInstancesList();
  renderAchievementsGrid();
}

// ===================== داک و پنل‌ها =====================
document.querySelectorAll('.dock-btn').forEach((btn) => {
  btn.addEventListener('click', () => openPanel(btn.dataset.panel));
});
document.getElementById('panel-backdrop').addEventListener('click', closePanel);
document.getElementById('panel-close').addEventListener('click', closePanel);

function openPanel(name) {
  document.querySelectorAll('.psection').forEach((s) => s.classList.remove('active'));
  document.getElementById('psection-' + name).classList.add('active');
  document.getElementById('panel-title').innerHTML = `<i class="fa-solid ${panelIconClass(name)}"></i> ${tt(panelTitleKey(name))}`;
  document.getElementById('panel-overlay').classList.add('open');
  document.querySelectorAll('.dock-btn').forEach((b) => b.classList.toggle('active', b.dataset.panel === name));

  if (name === 'account') { refreshAccounts(); updateSkinViewer(); }
  if (name === 'status') refreshRank();
  if (name === 'tools') { refreshServers(); refreshInstances(); }
  if (name === 'achievements') refreshAchievements();
  if (name === 'leaderboard') refreshLeaderboard();
}

function panelTitleKey(name) {
  return {
    settings: 'nav.settings', account: 'nav.accounts', tools: 'nav.tools',
    status: 'nav.status', log: 'nav.log', achievements: 'nav.achievements', leaderboard: 'nav.leaderboard'
  }[name];
}

function panelIconClass(name) {
  return {
    settings: 'fa-gear', account: 'fa-user', tools: 'fa-toolbox',
    status: 'fa-chart-line', log: 'fa-terminal', achievements: 'fa-trophy', leaderboard: 'fa-ranking-star'
  }[name];
}

function closePanel() {
  document.getElementById('panel-overlay').classList.remove('open');
  document.querySelectorAll('.dock-btn').forEach((b) => b.classList.remove('active'));
}

// زیرمنوی ابزارها
document.querySelectorAll('.sub-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.sub-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tools-subpage').forEach((p) => p.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tools-sub-' + btn.dataset.sub).classList.add('active');
    if (btn.dataset.sub === 'gallery') loadGallery();
    if (btn.dataset.sub === 'instances') refreshInstances();
    if (btn.dataset.sub === 'mods') refreshInstalledMods();
    if (btn.dataset.sub === 'content') refreshInstalledContent();
    if (btn.dataset.sub === 'worlds') refreshWorlds();
    if (btn.dataset.sub === 'news') refreshNews();
  });
});

// زیرمنوی داخلی ریسورس‌پک/شیدر
let currentContentType = 'resourcepack';
document.querySelectorAll('.content-type-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.content-type-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    currentContentType = btn.dataset.contentType;
    document.getElementById('content-search-results').innerHTML = '';
    refreshInstalledContent();
  });
});

// ===================== نسخه‌ها (صفحه‌ی اصلی) =====================
async function refreshVersions() {
  const res = await window.ph.scanVersions();
  if (!res.ok) {
    state.versions = [];
    renderVersionSelect(res.error);
    return;
  }
  state.versions = res.versions;
  renderVersionSelect();
  renderInstanceVersionSelect();
}

function renderVersionSelect(errorMsg) {
  const select = document.getElementById('home-version-select');
  const prevValue = select.value;
  select.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = errorMsg || tt('home.selectVersionPlaceholder');
  select.appendChild(placeholder);

  state.versions.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v.id;
    const tag = v.isModded ? tt('home.modded') : v.type;
    opt.textContent = (v.favorite ? '★ ' : '') + v.id + ' — ' + tag;
    select.appendChild(opt);
  });

  if (state.selectedVersion && state.versions.some((v) => v.id === state.selectedVersion)) {
    select.value = state.selectedVersion;
  } else if (prevValue) {
    select.value = prevValue;
  }
}

document.getElementById('home-version-select').addEventListener('change', (e) => {
  selectVersion(e.target.value || null);
});

function selectVersion(id) {
  state.selectedVersion = id;
  document.getElementById('btn-launch').disabled = !id;
  const select = document.getElementById('home-version-select');
  if (select.value !== (id || '')) select.value = id || '';
  updateSkinViewer();
  updateFavoriteButton();
}

function updateFavoriteButton() {
  const btn = document.getElementById('btn-toggle-favorite');
  if (!btn) return;
  const unlocked = hasFeature('favorites');
  btn.disabled = !unlocked || !state.selectedVersion;
  const v = state.versions.find((x) => x.id === state.selectedVersion);
  btn.classList.toggle('active', !!(v && v.favorite));
}

document.getElementById('btn-toggle-favorite').addEventListener('click', async () => {
  if (!state.selectedVersion || !hasFeature('favorites')) return;
  await window.ph.toggleFavorite(state.selectedVersion);
  await refreshVersions();
  selectVersion(state.selectedVersion);
});

// ===================== اجرا =====================
document.getElementById('btn-launch').addEventListener('click', async () => {
  if (!state.selectedVersion) return;
  const btn = document.getElementById('btn-launch');
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
  clearLog();
  const res = await window.ph.launchVersion(state.selectedVersion);
  if (!res.ok) {
    appendLog('[ERROR] ' + res.error);
    setStatus('error', res.error);
    btn.disabled = false;
    btn.innerHTML = `<i class="fa-solid fa-play"></i> <span>${tt('home.launchBtn')}</span>`;
  }
});

window.ph.onGameStatus((data) => {
  const btn = document.getElementById('btn-launch');
  if (data.running) {
    setStatus('running', data.versionId);
    startLiveXpBar();
  } else {
    setStatus('idle', tt('status.idle'));
    btn.disabled = !state.selectedVersion;
    btn.innerHTML = `<i class="fa-solid fa-play"></i> <span>${tt('home.launchBtn')}</span>`;
    if (data.xpGained > 0) appendLog(`[XP] +${data.xpGained} XP`);
    stopLiveXpBar();
  }
});

// ===================== نوار XP زنده (پر شدن تدریجی هم‌زمان با گذر زمان بازی) =====================
let liveXpTimer = null;
let liveXpSessionStart = null;
let liveXpBaseline = null; // {xpIntoLevel, xpForNext, level} در لحظه‌ی شروع نشست یا آخرین سینک با سرور

function startLiveXpBar() {
  stopLiveXpBar();
  liveXpSessionStart = Date.now();
  if (state.rank) liveXpBaseline = { xpIntoLevel: state.rank.xpIntoLevel, xpForNext: state.rank.xpForNext, level: state.rank.level };
  liveXpTimer = setInterval(updateLiveXpBar, 2000);
  updateLiveXpBar();
}

function stopLiveXpBar() {
  if (liveXpTimer) { clearInterval(liveXpTimer); liveXpTimer = null; }
  liveXpBaseline = null;
  if (state.rank) renderXpBarOnly(state.rank.xpIntoLevel, state.rank.xpForNext);
}

function updateLiveXpBar() {
  if (!liveXpBaseline || !liveXpSessionStart) return;
  const elapsedSec = (Date.now() - liveXpSessionStart) / 1000;
  const liveXpFraction = (elapsedSec / 3600) * 100; // ۱۰۰ XP به ازای هر ۱ ساعت
  let xpIntoLevel = liveXpBaseline.xpIntoLevel + liveXpFraction;
  let xpForNext = liveXpBaseline.xpForNext;
  // اگه توی همین نشست از این لول رد بشیم (به لول بعد برسیم)، نوار رو بریز و از نو با لول بعدی حساب کن
  while (xpIntoLevel >= xpForNext) {
    xpIntoLevel -= xpForNext;
    xpForNext = xpForNext + 100; // تقریب معقول تا زمانی که rank:updated واقعی از سرور برسه و دقیقش کنه
  }
  renderXpBarOnly(xpIntoLevel, xpForNext);
}

function renderXpBarOnly(xpIntoLevel, xpForNext) {
  const fillEl = document.getElementById('xp-bar-fill');
  const textEl = document.getElementById('xp-text');
  if (!fillEl || !textEl) return;
  const pct = Math.min(100, Math.round((xpIntoLevel / xpForNext) * 100));
  fillEl.style.width = pct + '%';
  textEl.textContent = `${Math.floor(xpIntoLevel)} / ${xpForNext} XP`;
}

window.ph.onGameLog((line) => appendLog(line));
window.ph.onRankUpdated((rank) => {
  if (state.lastLevel !== null && rank.level > state.lastLevel) {
    showLevelUpToast(rank);
  }
  state.lastLevel = rank.level;
  state.rank = rank;
  renderRank();
  // با هر آپدیت واقعی از سرور، مبنای محاسبه‌ی زنده رو هم دقیق‌سازی کن
  if (liveXpTimer) {
    liveXpSessionStart = Date.now();
    liveXpBaseline = { xpIntoLevel: rank.xpIntoLevel, xpForNext: rank.xpForNext, level: rank.level };
  }
});

function showLevelUpToast(rank) {
  const el = document.getElementById('levelup-toast');
  el.innerHTML = `
    <i class="fa-solid ${rank.rankIcon}"></i>
    <div>
      <div class="toast-title">Lv.${rank.level} — ${tt('rank.' + rank.rankKey)}</div>
      <div class="toast-sub">${tt('status.level')} ${rank.level}!</div>
    </div>
  `;
  el.classList.remove('show');
  void el.offsetWidth; // ری‌استارت انیمیشن
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 4500);
}

function setStatus(kind, text) {
  const pill = document.getElementById('status-pill');
  pill.className = 'status-pill ' + kind;
  pill.textContent = text;
}

// ===================== لاگ =====================
function appendLog(text) {
  const el = document.getElementById('log-output');
  el.textContent += text + '\n';
  el.scrollTop = el.scrollHeight;
}
function clearLog() {
  document.getElementById('log-output').textContent = '';
}
document.getElementById('btn-clear-log').addEventListener('click', clearLog);
document.getElementById('btn-copy-log').addEventListener('click', async () => {
  const text = document.getElementById('log-output').textContent;
  try {
    await navigator.clipboard.writeText(text);
    const btn = document.getElementById('btn-copy-log');
    const original = btn.innerHTML;
    btn.innerHTML = `<i class="fa-solid fa-check"></i> ${tt('log.copied')}`;
    setTimeout(() => { btn.innerHTML = original; }, 1500);
  } catch (e) { /* ignore */ }
});

// ===================== دانلود =====================
document.getElementById('btn-load-manifest').addEventListener('click', loadManifest);
document.getElementById('dl-search').addEventListener('input', renderDownloadList);
document.getElementById('dl-filter-release').addEventListener('change', renderDownloadList);
document.getElementById('dl-filter-snapshot').addEventListener('change', renderDownloadList);

async function loadManifest() {
  const listEl = document.getElementById('dl-list');
  listEl.innerHTML = `<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i></div>`;
  const res = await window.ph.getManifest();
  if (!res.ok) {
    listEl.innerHTML = `<div class="empty-state">${res.error}</div>`;
    return;
  }
  state.manifest = res.versions;
  renderDownloadList();
}

function renderDownloadList() {
  if (!state.manifest) return;
  const query = (document.getElementById('dl-search').value || '').toLowerCase();
  const showRelease = document.getElementById('dl-filter-release').checked;
  const showSnapshot = document.getElementById('dl-filter-snapshot').checked;
  const listEl = document.getElementById('dl-list');

  const filtered = state.manifest.filter((v) => {
    if (!v.id.toLowerCase().includes(query)) return false;
    if (v.type === 'release' && !showRelease) return false;
    if (v.type !== 'release' && !showSnapshot) return false;
    return true;
  }).slice(0, 100);

  listEl.innerHTML = '';
  if (filtered.length === 0) {
    listEl.innerHTML = `<div class="empty-state">-</div>`;
    return;
  }
  filtered.forEach((v) => {
    const item = document.createElement('div');
    item.className = 'version-card';
    item.title = v.id;
    item.innerHTML = `
      <div class="version-card-icon"><i class="fa-solid fa-cube"></i></div>
      <div class="version-card-id">${v.id}</div>
      <span class="version-tag">${v.type}</span>
      <button class="dl-btn" data-id="${v.id}" aria-label="download"></button>
      <div class="dl-hint"><i class="fa-solid fa-download"></i></div>
    `;
    item.querySelector('.dl-btn').addEventListener('click', () => startDownload(v.id));
    listEl.appendChild(item);
  });
}

async function startDownload(versionId) {
  if (!state.settings.mcDir) {
    await showAlert(tt('home.setDirFirst'));
    return;
  }
  const wrap = document.getElementById('progress-wrap');
  wrap.style.display = 'block';
  document.getElementById('progress-fill').style.width = '0%';
  document.getElementById('progress-text').textContent = versionId + '...';
  const res = await window.ph.downloadVersion(versionId);
  if (!res.ok) {
    document.getElementById('progress-text').textContent = '❌ ' + res.error;
  } else {
    document.getElementById('progress-text').textContent = '✅ ' + versionId;
    refreshVersions();
    setTimeout(() => { wrap.style.display = 'none'; }, 3000);
  }
}

window.ph.onDownloadProgress((data) => {
  const wrap = document.getElementById('progress-wrap');
  wrap.style.display = 'block';
  const pct = data.total > 0 ? Math.round((data.current / data.total) * 100) : 0;
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('progress-text').textContent = `${data.stage} (${data.current}/${data.total})`;
});

// ===================== سرورها =====================
async function refreshServers() {
  state.servers = await window.ph.listServers();
  renderServersList();
}

function renderServersList() {
  const list = document.getElementById('servers-list');
  list.innerHTML = '';
  if (!state.servers || state.servers.length === 0) {
    list.innerHTML = `<div class="empty-state">-</div>`;
    return;
  }
  state.servers.forEach((s) => {
    const item = document.createElement('div');
    item.className = 'account-item';
    item.innerHTML = `
      <div class="avatar-circle"><i class="fa-solid fa-server"></i></div>
      <div class="info">
        <div class="name">${s.name}</div>
        <div class="type-badge">${s.address}</div>
      </div>
      <span class="ping-badge" id="ping-${s.id}"><i class="fa-solid fa-spinner fa-spin"></i></span>
      <div class="actions">
        <button class="icon-btn connect-btn" title="connect"><i class="fa-solid fa-plug"></i></button>
        <button class="icon-btn remove-server-btn" title="remove"><i class="fa-solid fa-trash"></i></button>
      </div>
    `;
    item.querySelector('.connect-btn').addEventListener('click', () => quickConnect(s.address));
    item.querySelector('.remove-server-btn').addEventListener('click', async () => {
      if (!await showConfirm(tt('servers.deleteConfirm'), { danger: true, okText: tt('dialog.delete') })) return;
      await window.ph.removeServer(s.id);
      refreshServers();
    });
    list.appendChild(item);
    pingOneServer(s);
  });
}

async function pingOneServer(s) {
  const badge = document.getElementById('ping-' + s.id);
  if (!badge) return;
  const res = await window.ph.pingServer(s.address);
  if (!badge.isConnected) return;
  if (res.ok && res.online) {
    badge.className = 'ping-badge online';
    const players = res.players ? `${res.players.online}/${res.players.max}` : '';
    badge.innerHTML = `<i class="fa-solid fa-signal"></i> ${res.ping}ms · ${players}`;
  } else {
    badge.className = 'ping-badge offline';
    badge.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ${tt('servers.offline')}`;
  }
}

document.getElementById('btn-add-server').addEventListener('click', async () => {
  const nameEl = document.getElementById('input-server-name');
  const addrEl = document.getElementById('input-server-address');
  if (!addrEl.value.trim()) return;
  await window.ph.addServer(nameEl.value.trim(), addrEl.value.trim());
  nameEl.value = '';
  addrEl.value = '';
  refreshServers();
});

async function quickConnect(address) {
  if (!state.selectedVersion) {
    await showAlert(tt('home.selectVersionPlaceholder'));
    return;
  }
  closePanel();
  clearLog();
  const res = await window.ph.launchVersion(state.selectedVersion, address);
  if (!res.ok) appendLog('[ERROR] ' + res.error);
}

// ===================== اکانت‌ها =====================
async function refreshAccounts() {
  const res = await window.ph.listAccounts();
  state.accounts = res.accounts;
  state.activeAccountId = res.activeAccountId;
  renderAccountsList();
  renderActiveAccountChip();
  renderSkinsList();
}

function renderActiveAccountChip() {
  const active = state.accounts.find((a) => a.id === state.activeAccountId);
  const homeAvatar = document.getElementById('home-account-avatar');
  const homeName = document.getElementById('home-account-name');
  const homeUsername = document.getElementById('home-username');
  if (!active) {
    homeAvatar.textContent = '?';
    homeName.textContent = '-';
    homeUsername.textContent = '-';
  } else {
    homeAvatar.textContent = active.username.charAt(0).toUpperCase();
    homeName.textContent = active.username;
    homeUsername.textContent = active.username;
  }
  renderAccountQuickMenu();
}

function renderAccountQuickMenu() {
  const menu = document.getElementById('account-quick-menu');
  menu.innerHTML = '';
  state.accounts.forEach((a) => {
    const item = document.createElement('div');
    item.className = 'account-quick-item' + (a.id === state.activeAccountId ? ' active' : '');
    item.innerHTML = `<div class="avatar-circle" style="width:22px;height:22px;font-size:10px">${a.username.charAt(0).toUpperCase()}</div><span>${a.username}</span>`;
    item.addEventListener('click', async (e) => {
      e.stopPropagation();
      await window.ph.setActiveAccount(a.id);
      await refreshAccounts();
      updateSkinViewer();
      document.getElementById('home-account-chip').classList.remove('open');
    });
    menu.appendChild(item);
  });
}

document.getElementById('home-account-chip').addEventListener('click', (e) => {
  document.getElementById('home-account-chip').classList.toggle('open');
});
document.addEventListener('click', (e) => {
  if (!e.target.closest('#home-account-chip')) {
    document.getElementById('home-account-chip').classList.remove('open');
  }
});

function renderAccountsList() {
  const list = document.getElementById('accounts-list');
  list.innerHTML = '';
  if (state.accounts.length === 0) {
    list.innerHTML = `<div class="empty-state">-</div>`;
    return;
  }
  state.accounts.forEach((a) => {
    const item = document.createElement('div');
    item.className = 'account-item' + (a.id === state.activeAccountId ? ' active-account' : '');
    const skinCount = (a.skins || []).length;
    const badge = skinCount > 0 ? `<i class="fa-solid fa-shirt"></i> ${skinCount}` : tt('accounts.typeOffline');
    item.innerHTML = `
      <div class="avatar-circle">${a.username.charAt(0).toUpperCase()}</div>
      <div class="info">
        <div class="name">${a.username}</div>
        <div class="type-badge">${badge}</div>
      </div>
      <div class="actions">
        <button class="icon-btn set-active-btn" title="set active"><i class="fa-solid fa-check"></i></button>
        <button class="icon-btn remove-account-btn" title="remove"><i class="fa-solid fa-trash"></i></button>
      </div>
    `;
    item.querySelector('.set-active-btn').addEventListener('click', async () => {
      await window.ph.setActiveAccount(a.id);
      await refreshAccounts();
      renderSkinsList();
      updateSkinViewer();
    });
    item.querySelector('.remove-account-btn').addEventListener('click', async () => {
      if (!await showConfirm(tt('accounts.deleteConfirm'), { danger: true, okText: tt('dialog.delete') })) return;
      await window.ph.removeAccount(a.id);
      await refreshAccounts();
      renderSkinsList();
      updateSkinViewer();
    });
    list.appendChild(item);
  });
}

document.getElementById('btn-add-offline').addEventListener('click', async () => {
  const input = document.getElementById('input-new-offline');
  const username = input.value.trim();
  if (!username) return;
  const res = await window.ph.addOfflineAccount(username);
  if (res.ok) {
    input.value = '';
    await refreshAccounts();
  }
});

// ===================== اسکین‌ها =====================
function renderSkinsList() {
  const list = document.getElementById('skins-list');
  const active = state.accounts.find((a) => a.id === state.activeAccountId);
  list.innerHTML = '';
  if (!active || !active.skins || active.skins.length === 0) {
    list.innerHTML = `<div class="empty-state">-</div>`;
    return;
  }
  active.skins.forEach((s) => {
    const item = document.createElement('div');
    item.className = 'account-item' + (s.id === active.activeSkinId ? ' active-account' : '');
    const modelLabel = s.model === 'slim' ? tt('accounts.modelSlim') : tt('accounts.modelClassic');
    item.innerHTML = `
      <div class="avatar-circle"><i class="fa-solid fa-shirt"></i></div>
      <div class="info">
        <div class="name">${s.name}</div>
        <div class="type-badge">${modelLabel}${s.id === active.activeSkinId ? ' · ' + tt('accounts.skinActive') : ''}</div>
      </div>
      <div class="actions">
        <button class="icon-btn set-skin-btn" title="use"><i class="fa-solid fa-check"></i></button>
        <button class="icon-btn remove-skin-btn" title="remove"><i class="fa-solid fa-trash"></i></button>
      </div>
    `;
    item.querySelector('.set-skin-btn').addEventListener('click', async () => {
      const res = await window.ph.setActiveSkin(active.id, s.id);
      if (res.ok) { await refreshAccounts(); renderSkinsList(); updateSkinViewer(); }
    });
    item.querySelector('.remove-skin-btn').addEventListener('click', async () => {
      const res = await window.ph.removeSkin(active.id, s.id);
      if (res.ok) { await refreshAccounts(); renderSkinsList(); updateSkinViewer(); }
    });
    list.appendChild(item);
  });
}

document.getElementById('btn-upload-skin').addEventListener('click', async () => {
  const active = state.accounts.find((a) => a.id === state.activeAccountId);
  const statusEl = document.getElementById('skin-upload-status');
  if (!active) { statusEl.textContent = '❌'; return; }
  const name = document.getElementById('input-skin-name').value.trim();
  const model = document.querySelector('input[name="skin-model"]:checked').value;
  const res = await window.ph.uploadSkin(active.id, name, model);
  if (res.canceled) return;
  if (!res.ok) {
    statusEl.textContent = '❌ ' + res.error;
    return;
  }
  statusEl.textContent = '✅';
  document.getElementById('input-skin-name').value = '';
  await refreshAccounts();
  renderSkinsList();
  updateSkinViewer();
});

// ===================== اسکین =====================
function loadImagePromise(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function drawSkinFront(img) {
  const canvas = document.getElementById('skin-canvas');
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const legacy = img.height <= 32;
  const scale = 8;
  const centerX = canvas.width / 2;
  let y = 10;

  ctx.drawImage(img, 8, 8, 8, 8, centerX - 4 * scale, y, 8 * scale, 8 * scale);
  ctx.drawImage(img, 40, 8, 8, 8, centerX - 4 * scale, y, 8 * scale, 8 * scale);
  y += 8 * scale;

  ctx.drawImage(img, 20, 20, 8, 12, centerX - 4 * scale, y, 8 * scale, 12 * scale);
  if (!legacy) ctx.drawImage(img, 20, 36, 8, 12, centerX - 4 * scale, y, 8 * scale, 12 * scale);

  ctx.drawImage(img, 44, 20, 4, 12, centerX - 8 * scale, y, 4 * scale, 12 * scale);
  if (!legacy) {
    ctx.drawImage(img, 36, 52, 4, 12, centerX + 4 * scale, y, 4 * scale, 12 * scale);
  } else {
    ctx.save();
    ctx.translate(centerX + 8 * scale, y);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 44, 20, 4, 12, 0, 0, 4 * scale, 12 * scale);
    ctx.restore();
  }

  y += 12 * scale;

  ctx.drawImage(img, 4, 20, 4, 12, centerX - 4 * scale, y, 4 * scale, 12 * scale);
  if (!legacy) {
    ctx.drawImage(img, 20, 52, 4, 12, centerX, y, 4 * scale, 12 * scale);
  } else {
    ctx.save();
    ctx.translate(centerX + 4 * scale, y);
    ctx.scale(-1, 1);
    ctx.drawImage(img, 4, 20, 4, 12, 0, 0, 4 * scale, 12 * scale);
    ctx.restore();
  }
}

function updateSkinNote() {
  const active = state.accounts.find((a) => a.id === state.activeAccountId);
  const note = document.getElementById('skin-note');
  if (active && !active.activeSkinId) note.textContent = tt('accounts.skinOfflineNote');
  else note.textContent = '';
}

async function updateSkinViewer() {
  const canvas = document.getElementById('skin-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  updateSkinNote();

  const active = state.accounts.find((a) => a.id === state.activeAccountId);
  if (!active) return;

  try {
    if (active.activeSkinId) {
      const res = await window.ph.getUploadedSkinImage(active.id, active.activeSkinId);
      if (res.ok) {
        const img = await loadImagePromise(res.dataUrl);
        drawSkinFront(img);
      }
    } else if (state.selectedVersion) {
      const res = await window.ph.getOfflineSkin(state.selectedVersion);
      if (res.ok) {
        const img = await loadImagePromise(res.dataUrl);
        drawSkinFront(img);
      }
    }
  } catch (e) { /* ignore render errors */ }
}

// ===================== ابزارها (بکاپ/فولدر/جاوا/نیتیو/تم) =====================
document.querySelectorAll('.tool-btn[data-folder]').forEach((btn) => {
  btn.addEventListener('click', () => window.ph.openFolder(btn.dataset.folder));
});

document.getElementById('tool-backup').addEventListener('click', async () => {
  if (!hasFeature('backup')) return;
  const res = await window.ph.createBackup();
  document.getElementById('backup-status').textContent = res.ok ? `✅ ${res.path}` : `❌ ${res.error}`;
});

document.getElementById('btn-detect-java').addEventListener('click', async () => {
  const info = await window.ph.detectJava();
  document.getElementById('maintenance-status').textContent = info ? `Java ${info.major} — ${info.raw}` : '❌';
});

document.getElementById('btn-clear-natives').addEventListener('click', async () => {
  const res = await window.ph.clearNatives();
  document.getElementById('maintenance-status').textContent = `✅ ${res.cleared}`;
});

function hasFeature(name) {
  // همه‌ی قابلیت‌ها از همون ابتدا برای همه باز هستن؛ سیستم رنک/لول فقط جنبه‌ی نمایشیه.
  return true;
}

function renderTools() {
  const backupBtn = document.getElementById('tool-backup');
  backupBtn.disabled = !hasFeature('backup');
  document.getElementById('theme-lock-msg').textContent = hasFeature('theme') ? '' : '🔒';
  document.getElementById('theme-picker').style.display = hasFeature('theme') ? 'flex' : 'none';
  renderBoosterLock();
  updateFavoriteButton();
}

function renderBoosterLock() {
  const checkbox = document.getElementById('input-game-booster');
  const lockMsg = document.getElementById('booster-lock-msg');
  if (!checkbox) return;
  const unlocked = hasFeature('gameBooster');
  checkbox.disabled = !unlocked;
  lockMsg.textContent = unlocked ? '' : '🔒 Lv.20';
}

function buildThemePicker() {
  const wrap = document.getElementById('theme-picker');
  wrap.innerHTML = '';
  THEME_COLORS.forEach((c) => {
    const dot = document.createElement('div');
    dot.className = 'theme-swatch' + (state.settings.accentColor === c ? ' selected' : '');
    dot.style.background = c;
    dot.addEventListener('click', async () => {
      state.settings = await window.ph.saveSettings({ accentColor: c });
      applyTheme(c);
      buildThemePicker();
    });
    wrap.appendChild(dot);
  });
}

function applyTheme(color) {
  document.documentElement.style.setProperty('--accent', color);
  document.documentElement.style.setProperty('--accent-soft', color + '33');
}

// ===================== گالری =====================
async function loadGallery() {
  const grid = document.getElementById('gallery-grid');
  const lockMsg = document.getElementById('gallery-lock-msg');
  if (!hasFeature('gallery')) {
    grid.innerHTML = '';
    lockMsg.textContent = '🔒';
    return;
  }
  lockMsg.textContent = '';
  const files = await window.ph.listGallery();
  grid.innerHTML = files.length ? '' : `<div class="empty-state">-</div>`;
  files.forEach((f) => {
    const item = document.createElement('div');
    item.className = 'gallery-item';
    const fileUrl = 'file://' + f;
    item.innerHTML = `
      <img src="${fileUrl}" />
      <button class="gallery-delete-btn" title="delete"><i class="fa-solid fa-trash"></i></button>
    `;
    item.querySelector('img').addEventListener('click', () => openLightbox(fileUrl));
    item.querySelector('.gallery-delete-btn').addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!await showConfirm(tt('gallery.deleteConfirm'), { danger: true, okText: tt('dialog.delete') })) return;
      const res = await window.ph.deleteScreenshot(f);
      if (res.ok) loadGallery(); else await showAlert(res.error);
    });
    grid.appendChild(item);
  });
}

function openLightbox(src) {
  document.getElementById('lightbox-img').src = src;
  document.getElementById('lightbox').classList.add('show');
}
document.getElementById('lightbox-close').addEventListener('click', () => {
  document.getElementById('lightbox').classList.remove('show');
});
document.getElementById('lightbox').addEventListener('click', (e) => {
  if (e.target.id === 'lightbox') document.getElementById('lightbox').classList.remove('show');
});

// ===================== وضعیت (رنک/XP/پلی‌تایم) =====================
async function refreshRank() {
  state.rank = await window.ph.getRank();
  if (state.lastLevel === null) state.lastLevel = state.rank.level;
  renderRank();
}

function formatHours(seconds) {
  return (seconds / 3600).toFixed(1);
}

function renderRank() {
  renderTools();
  if (!state.rank) return;
  const r = state.rank;
  document.getElementById('rank-icon-big').className = 'fa-solid ' + r.rankIcon + ' rank-icon-big';
  document.getElementById('rank-name-big').textContent = tt('rank.' + r.rankKey);
  document.getElementById('rank-level-big').textContent = r.level;
  const pct = Math.min(100, Math.round((r.xpIntoLevel / r.xpForNext) * 100));
  document.getElementById('xp-bar-fill').style.width = pct + '%';
  document.getElementById('xp-text').textContent = `${r.xpIntoLevel} / ${r.xpForNext} XP`;
  document.getElementById('playtime-text').textContent = `${tt('status.totalPlaytime')}: ${formatHours(r.totalPlaySeconds)}h`;
  document.getElementById('next-rank-text').textContent = r.nextRank
    ? `${tt('status.xpToNext')}: ${tt('rank.' + r.nextRank.key)} (Lv.${r.nextRank.minLevel})`
    : tt('status.maxRank');

  const list = document.getElementById('playtime-by-version');
  list.innerHTML = '';
  if (!r.playtimeByVersion || r.playtimeByVersion.length === 0) {
    list.innerHTML = `<div class="empty-state">${tt('status.noData')}</div>`;
  } else {
    r.playtimeByVersion.forEach((entry) => {
      const item = document.createElement('div');
      item.className = 'account-item';
      item.innerHTML = `
        <div class="avatar-circle"><i class="fa-solid fa-cube"></i></div>
        <div class="info">
          <div class="name">${entry.versionId}</div>
        </div>
        <div class="type-badge">${formatHours(entry.seconds)}h</div>
      `;
      list.appendChild(item);
    });
  }

  // مینی‌رنک روی چیپ اکانت هم آپدیت بشه (اگه بخوایم بعداً استفاده کنیم)
}

// ===================== زبان =====================
document.getElementById('select-lang').addEventListener('change', async (e) => {
  const lang = e.target.value;
  state.settings = await window.ph.saveSettings({ lang });
  applyLanguage(lang);
  redrawAllForLanguage();
});

// ===================== تنظیمات =====================
document.getElementById('btn-browse-mcdir').addEventListener('click', async () => {
  const dir = await window.ph.browseFolder();
  if (dir) document.getElementById('input-mcdir').value = dir;
});

document.getElementById('btn-auto-detect-mcdir').addEventListener('click', async () => {
  const statusEl = document.getElementById('auto-detect-status');
  statusEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
  const res = await window.ph.autoDetectMcDir();
  if (res.ok) {
    document.getElementById('input-mcdir').value = res.path;
    statusEl.textContent = '✅ ' + res.path;
  } else {
    statusEl.textContent = tt('settings.autoDetectFail');
  }
});

document.getElementById('btn-browse-java').addEventListener('click', async () => {
  const file = await window.ph.browseJava();
  if (file) document.getElementById('input-java').value = file;
});

document.getElementById('input-ram-min').addEventListener('input', (e) => {
  document.getElementById('ram-min-val').textContent = e.target.value;
});
document.getElementById('input-ram-max').addEventListener('input', (e) => {
  document.getElementById('ram-max-val').textContent = e.target.value;
});

document.getElementById('btn-save-settings').addEventListener('click', async () => {
  const ramMin = parseInt(document.getElementById('input-ram-min').value, 10);
  const ramMax = parseInt(document.getElementById('input-ram-max').value, 10);
  if (ramMin > ramMax) {
    document.getElementById('settings-status').textContent = '❌';
    return;
  }
  const newSettings = {
    mcDir: document.getElementById('input-mcdir').value.trim(),
    javaPath: document.getElementById('input-java').value.trim(),
    closeToTray: document.getElementById('input-close-tray').checked,
    minimizeOnLaunch: document.getElementById('input-minimize-launch').checked,
    gameBoosterEnabled: document.getElementById('input-game-booster').checked,
    autoBackupEnabled: document.getElementById('input-auto-backup').checked,
    autoBackupBeforeLaunch: document.getElementById('input-backup-before-launch').checked,
    autoBackupIntervalHours: parseInt(document.getElementById('input-backup-interval').value, 10),
    customJvmArgs: document.getElementById('input-custom-jvm').value.trim(),
    customGameArgs: document.getElementById('input-custom-game').value.trim(),
    ramMin, ramMax
  };
  state.settings = await window.ph.saveSettings(newSettings);
  await window.ph.toggleDiscordRpc(document.getElementById('input-discord-rpc').checked);
  document.getElementById('settings-status').textContent = '✅';
  await refreshVersions();
});

document.getElementById('input-backup-interval').addEventListener('input', (e) => {
  document.getElementById('backup-interval-val').textContent = e.target.value;
});

// ===================== دستاوردها =====================
async function refreshAchievements() {
  state.achievements = await window.ph.listAchievements();
  renderAchievementsGrid();
}

function renderAchievementsGrid() {
  const grid = document.getElementById('achievements-grid');
  if (!grid || !state.achievements) return;
  grid.innerHTML = '';
  const unlockedCount = state.achievements.filter((a) => a.unlocked).length;
  const total = state.achievements.length;
  document.getElementById('ach-progress-text').textContent = `${unlockedCount} / ${total}`;
  document.getElementById('ach-progress-fill').style.width = (total ? Math.round((unlockedCount / total) * 100) : 0) + '%';
  state.achievements.forEach((a) => {
    const card = document.createElement('div');
    card.className = 'ach-card' + (a.unlocked ? '' : ' locked');
    card.innerHTML = `
      <i class="fa-solid ${a.icon}"></i>
      <div>${tt('ach.' + a.id + '.name')}</div>
      <div class="muted small">${tt('ach.' + a.id + '.desc')}</div>
    `;
    grid.appendChild(card);
  });
}

function listenForAchievementUnlocks() {
  window.ph.onAchievementUnlocked((data) => {
    const el = document.getElementById('levelup-toast');
    el.innerHTML = `
      <i class="fa-solid ${data.icon}"></i>
      <div>
        <div class="toast-title">${tt('ach.unlockedLabel')}</div>
        <div class="toast-sub">${tt('ach.' + data.id + '.name')}</div>
      </div>
    `;
    el.classList.remove('show');
    void el.offsetWidth;
    el.classList.add('show');
    setTimeout(() => el.classList.remove('show'), 4500);
    if (document.getElementById('psection-achievements').classList.contains('active')) refreshAchievements();
  });
}

// ===================== نمونه‌ها (Instance) =====================
async function refreshInstances() {
  state.instances = await window.ph.listInstances();
  renderInstanceVersionSelect();
  renderInstancesList();
}

function renderInstanceVersionSelect() {
  const select = document.getElementById('instance-version-select');
  if (!select) return;
  const prev = select.value;
  select.innerHTML = '';
  state.versions.forEach((v) => {
    const opt = document.createElement('option');
    opt.value = v.id;
    opt.textContent = v.id;
    select.appendChild(opt);
  });
  if (prev) select.value = prev;
}

function renderInstancesList() {
  const list = document.getElementById('instances-list');
  if (!list) return;
  list.innerHTML = '';
  if (!state.instances || state.instances.length === 0) {
    list.innerHTML = `<div class="empty-state">-</div>`;
    return;
  }
  state.instances.forEach((inst) => {
    const item = document.createElement('div');
    item.className = 'account-item';
    item.innerHTML = `
      <div class="avatar-circle"><i class="fa-solid fa-cube"></i></div>
      <div class="info">
        <div class="name">${inst.name}</div>
        <div class="type-badge">${inst.versionId}</div>
      </div>
      <div class="actions">
        <button class="icon-btn instance-launch-btn" title="launch"><i class="fa-solid fa-play"></i></button>
        <button class="icon-btn instance-folder-btn" title="folder"><i class="fa-solid fa-folder-open"></i></button>
        <button class="icon-btn instance-delete-btn" title="delete"><i class="fa-solid fa-trash"></i></button>
      </div>
    `;
    item.querySelector('.instance-launch-btn').addEventListener('click', async () => {
      closePanel();
      clearLog();
      const res = await window.ph.launchInstance(inst.id);
      if (!res.ok) appendLog('[ERROR] ' + res.error);
    });
    item.querySelector('.instance-folder-btn').addEventListener('click', () => {
      window.ph.openInstanceFolder(inst.id, '');
    });
    item.querySelector('.instance-delete-btn').addEventListener('click', async () => {
      if (!await showConfirm(tt('instances.deleteConfirm'), { danger: true, okText: tt('dialog.delete') })) return;
      await window.ph.deleteInstance(inst.id);
      refreshInstances();
    });
    list.appendChild(item);
  });
}

document.getElementById('btn-create-instance').addEventListener('click', async () => {
  const nameEl = document.getElementById('input-instance-name');
  const versionId = document.getElementById('instance-version-select').value;
  if (!nameEl.value.trim() || !versionId) return;
  const res = await window.ph.createInstance(nameEl.value.trim(), versionId);
  if (res.ok) {
    nameEl.value = '';
    refreshInstances();
  }
});

// ===================== مادها =====================
async function refreshInstalledMods() {
  const mods = await window.ph.listMods(null);
  const list = document.getElementById('mods-installed-list');
  list.innerHTML = '';
  if (!mods || mods.length === 0) {
    list.innerHTML = `<div class="empty-state">-</div>`;
    return;
  }
  mods.forEach((fileName) => {
    const update = (state.modUpdates || []).find((u) => u.fileName === fileName);
    const item = document.createElement('div');
    item.className = 'account-item';
    item.innerHTML = `
      <div class="avatar-circle"><i class="fa-solid fa-puzzle-piece"></i></div>
      <div class="info"><div class="name">${fileName}</div></div>
      ${update ? `<span class="update-badge"><i class="fa-solid fa-arrow-up"></i> ${tt('mods.updateAvailable')}</span>` : ''}
      <div class="actions">
        ${update ? `<button class="icon-btn mod-update-btn" title="update"><i class="fa-solid fa-download"></i></button>` : ''}
        <button class="icon-btn mod-remove-btn" title="remove"><i class="fa-solid fa-trash"></i></button>
      </div>
    `;
    if (update) {
      item.querySelector('.mod-update-btn').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
        const res = await window.ph.applyModUpdate(update.fileName, update.projectId, update.latestVersionId, null);
        if (res.ok) {
          state.modUpdates = state.modUpdates.filter((u) => u.fileName !== fileName);
          refreshInstalledMods();
          updateToolsDockBadge();
        } else {
          await showAlert(res.error);
        }
      });
    }
    item.querySelector('.mod-remove-btn').addEventListener('click', async () => {
      if (!await showConfirm(tt('mods.removeConfirm'), { danger: true, okText: tt('dialog.delete') })) return;
      await window.ph.removeMod(fileName, null);
      refreshInstalledMods();
    });
    list.appendChild(item);
  });
}

function getModTarget() {
  const mcVersion = document.getElementById('mods-target-version').value.trim();
  const loader = document.getElementById('mods-target-loader').value;
  return { mcVersion, loader };
}

document.getElementById('btn-use-current-version').addEventListener('click', async () => {
  if (!state.selectedVersion) {
    await showAlert(tt('home.selectVersionPlaceholder'));
    return;
  }
  const res = await window.ph.suggestModTarget(state.selectedVersion);
  if (res.ok) {
    document.getElementById('mods-target-version').value = res.mcVersion;
    document.getElementById('mods-target-loader').value = res.loader;
  } else {
    await showAlert(res.error);
  }
});

document.getElementById('btn-search-mods').addEventListener('click', async () => {
  const query = document.getElementById('mods-search').value.trim();
  const { mcVersion, loader } = getModTarget();
  if (!mcVersion) {
    await showAlert(tt('mods.needVersion'));
    return;
  }
  const resultsList = document.getElementById('mods-search-results');
  resultsList.innerHTML = `<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i></div>`;
  const res = await window.ph.searchMods(query, mcVersion, loader);
  if (!res.ok) {
    resultsList.innerHTML = `<div class="empty-state">${res.error}</div>`;
    return;
  }
  resultsList.innerHTML = '';
  if (res.results.length === 0) {
    resultsList.innerHTML = `<div class="empty-state">-</div>`;
    return;
  }
  res.results.forEach((mod) => {
    const item = document.createElement('div');
    item.className = 'account-item';
    item.innerHTML = `
      <img class="mod-icon" src="${mod.iconUrl || ''}" onerror="this.style.display='none'" />
      <div class="info">
        <div class="name">${mod.title}</div>
        <div class="type-badge">${mod.author || ''}</div>
      </div>
      <button class="btn-ghost mod-install-btn"><i class="fa-solid fa-download"></i></button>
    `;
    item.querySelector('.mod-install-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
      const { mcVersion: mv, loader: ld } = getModTarget();
      const installRes = await window.ph.installMod(mod.id, mv, ld, null);
      if (installRes.ok) {
        const count = (installRes.installed || []).length;
        btn.innerHTML = count > 1 ? `<i class="fa-solid fa-check"></i> ${count}` : `<i class="fa-solid fa-check"></i>`;
        btn.title = count > 1 ? tt('mods.depsInstalled').replace('{n}', count) : '';
        refreshInstalledMods();
        // قبلاً وابستگی‌ی ضروری‌ای که نصبش شکست می‌خورد کاملاً بی‌صدا گم می‌شد و کاربر فکر می‌کرد
        // ماد کامل نصب شده؛ حالا اگه چیزی جا افتاده باشه بهش می‌گیم.
        if (installRes.depFailures && installRes.depFailures.length) {
          showToast(tt('mods.depFailedWarning').replace('{n}', installRes.depFailures.length), 'error');
        }
      } else {
        btn.innerHTML = `<i class="fa-solid fa-xmark"></i>`;
        await showAlert(installRes.error);
      }
    });
    resultsList.appendChild(item);
  });
});

// ===================== دانلود خودکار جاوا =====================
document.getElementById('btn-auto-java').addEventListener('click', async () => {
  const statusEl = document.getElementById('maintenance-status');
  if (!state.selectedVersion) {
    statusEl.textContent = tt('home.selectVersionPlaceholder');
    return;
  }
  const reqRes = await window.ph.getRequiredJavaVersion(state.selectedVersion);
  if (!reqRes.ok) {
    statusEl.textContent = '❌ ' + reqRes.error;
    return;
  }
  document.getElementById('java-install-progress').style.display = 'block';
  statusEl.textContent = `Java ${reqRes.major}...`;
  const res = await window.ph.autoInstallJava(reqRes.major);
  if (res.ok) {
    statusEl.textContent = `✅ Java ${res.major}`;
  } else {
    statusEl.textContent = '❌ ' + res.error;
  }
});

function listenForJavaProgress() {
  window.ph.onJavaInstallProgress((data) => {
    const pct = data.total > 0 ? Math.round((data.current / data.total) * 100) : 50;
    document.getElementById('java-progress-fill').style.width = pct + '%';
    document.getElementById('java-progress-text').textContent = data.stage;
  });
}

// ===================== ریسورس‌پک و شیدر =====================
async function refreshInstalledContent() {
  const list = await window.ph.listContent(currentContentType, null);
  const el = document.getElementById('content-installed-list');
  el.innerHTML = '';
  if (!list || list.length === 0) { el.innerHTML = `<div class="empty-state">-</div>`; return; }
  list.forEach((fileName) => {
    const item = document.createElement('div');
    item.className = 'account-item';
    item.innerHTML = `
      <div class="avatar-circle"><i class="fa-solid fa-palette"></i></div>
      <div class="info"><div class="name">${fileName}</div></div>
      <div class="actions"><button class="icon-btn content-remove-btn" title="remove"><i class="fa-solid fa-trash"></i></button></div>
    `;
    item.querySelector('.content-remove-btn').addEventListener('click', async () => {
      if (!await showConfirm(tt('content.removeConfirm'), { danger: true, okText: tt('dialog.delete') })) return;
      await window.ph.removeContent(fileName, currentContentType, null);
      refreshInstalledContent();
    });
    el.appendChild(item);
  });
}

document.getElementById('btn-search-content').addEventListener('click', async () => {
  const query = document.getElementById('content-search').value.trim();
  const resultsList = document.getElementById('content-search-results');
  resultsList.innerHTML = `<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i></div>`;
  const res = await window.ph.searchContent(query, state.selectedVersion, currentContentType);
  if (!res.ok) { resultsList.innerHTML = `<div class="empty-state">${res.error}</div>`; return; }
  resultsList.innerHTML = '';
  if (res.results.length === 0) { resultsList.innerHTML = `<div class="empty-state">-</div>`; return; }
  res.results.forEach((item) => {
    const el = document.createElement('div');
    el.className = 'account-item';
    el.innerHTML = `
      <img class="mod-icon" src="${item.iconUrl || ''}" onerror="this.style.display='none'" />
      <div class="info">
        <div class="name">${item.title}</div>
        <div class="type-badge">${item.author || ''}</div>
      </div>
      <button class="btn-ghost content-install-btn"><i class="fa-solid fa-download"></i></button>
    `;
    el.querySelector('.content-install-btn').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
      const installRes = await window.ph.installContent(item.id, state.selectedVersion, currentContentType, null);
      if (installRes.ok) { btn.innerHTML = `<i class="fa-solid fa-check"></i>`; refreshInstalledContent(); }
      else { btn.innerHTML = `<i class="fa-solid fa-xmark"></i>`; await showAlert(installRes.error); }
    });
    resultsList.appendChild(el);
  });
});

// ===================== وارد کردن Modpack =====================
document.getElementById('btn-import-modpack').addEventListener('click', async () => {
  const statusEl = document.getElementById('modpack-import-status');
  const progressWrap = document.getElementById('modpack-import-progress');
  statusEl.textContent = '';
  const res = await window.ph.importModpack();
  if (res.canceled) return;
  progressWrap.style.display = 'none';
  if (res.ok) {
    statusEl.textContent = `✅ ${res.instance.name}`;
    refreshInstances();
    if (res.warning) showToast(res.warning, 'error');
  } else {
    statusEl.textContent = '❌ ' + res.error;
  }
});

function listenForModpackProgress() {
  window.ph.onModpackImportProgress((data) => {
    const wrap = document.getElementById('modpack-import-progress');
    wrap.style.display = 'block';
    const pct = data.total > 0 ? Math.round((data.current / data.total) * 100) : 0;
    document.getElementById('modpack-progress-fill').style.width = pct + '%';
    document.getElementById('modpack-progress-text').textContent = `${data.stage} (${data.current}/${data.total})`;
  });
}

// ===================== مدیریت دنیاها =====================
async function refreshWorlds() {
  const worlds = await window.ph.listWorlds(null);
  const list = document.getElementById('worlds-list');
  list.innerHTML = '';
  if (!worlds || worlds.length === 0) { list.innerHTML = `<div class="empty-state">-</div>`; return; }
  worlds.forEach((w) => {
    const item = document.createElement('div');
    item.className = 'account-item';
    const sizeMB = (w.sizeBytes / (1024 * 1024)).toFixed(1);
    const dateStr = w.lastPlayed ? new Date(w.lastPlayed).toLocaleDateString(currentLang()) : '-';
    item.innerHTML = `
      ${w.iconDataUrl ? `<img class="mod-icon" src="${w.iconDataUrl}" />` : `<div class="avatar-circle"><i class="fa-solid fa-earth-americas"></i></div>`}
      <div class="info">
        <div class="name">${w.name}</div>
        <div class="type-badge">${dateStr} · ${sizeMB}MB</div>
        <div class="seed-row" id="seed-row-${w.name.replace(/[^a-zA-Z0-9]/g, '_')}"></div>
      </div>
      <div class="actions">
        <button class="icon-btn world-seed-btn" title="seed"><i class="fa-solid fa-dice"></i></button>
        <button class="icon-btn world-rename-btn" title="rename"><i class="fa-solid fa-pen"></i></button>
        <button class="icon-btn world-dup-btn" title="duplicate"><i class="fa-solid fa-copy"></i></button>
        <button class="icon-btn world-folder-btn" title="folder"><i class="fa-solid fa-folder-open"></i></button>
        <button class="icon-btn world-delete-btn" title="delete"><i class="fa-solid fa-trash"></i></button>
      </div>
    `;
    item.querySelector('.world-seed-btn').addEventListener('click', async () => {
      const seedRow = item.querySelector('.seed-row');
      seedRow.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
      const res = await window.ph.getWorldSeed(null, w.name);
      if (!res.ok) { seedRow.textContent = res.error; return; }
      seedRow.innerHTML = `<span>${tt('worlds.seed')}: ${res.seed}</span> <button class="icon-btn seed-copy-btn" title="copy"><i class="fa-solid fa-copy"></i></button>`;
      seedRow.querySelector('.seed-copy-btn').addEventListener('click', () => navigator.clipboard.writeText(res.seed));
    });
    item.querySelector('.world-rename-btn').addEventListener('click', async () => {
      const newName = await showPrompt(tt('worlds.renamePrompt'), w.name);
      if (!newName || newName === w.name) return;
      const res = await window.ph.renameWorld(null, w.name, newName);
      if (res.ok) refreshWorlds(); else await showAlert(res.error);
    });
    item.querySelector('.world-dup-btn').addEventListener('click', async () => {
      await window.ph.duplicateWorld(null, w.name);
      refreshWorlds();
    });
    item.querySelector('.world-folder-btn').addEventListener('click', () => {
      window.ph.openWorldFolder(null, w.name);
    });
    item.querySelector('.world-delete-btn').addEventListener('click', async () => {
      if (!await showConfirm(tt('worlds.deleteConfirm'), { danger: true, okText: tt('dialog.delete') })) return;
      await window.ph.deleteWorld(null, w.name);
      refreshWorlds();
    });
    list.appendChild(item);
  });
}

// ===================== اخبار رسمی ماینکرافت =====================
async function refreshNews() {
  const list = document.getElementById('news-list');
  list.innerHTML = `<div class="empty-state"><i class="fa-solid fa-spinner fa-spin"></i></div>`;
  const res = await window.ph.fetchNews();
  if (!res.ok || !res.entries || res.entries.length === 0) {
    list.innerHTML = `<div class="empty-state">-</div>`;
    return;
  }
  list.innerHTML = '';
  res.entries.forEach((n) => {
    const item = document.createElement('div');
    item.className = 'account-item';
    item.innerHTML = `
      ${n.image ? `<img class="mod-icon" src="${n.image}" />` : `<div class="avatar-circle"><i class="fa-solid fa-newspaper"></i></div>`}
      <div class="info">
        <div class="name">${n.title}</div>
        <div class="type-badge">${n.date || ''}</div>
      </div>
      ${n.link ? `<button class="icon-btn news-open-btn" title="open"><i class="fa-solid fa-arrow-up-right-from-square"></i></button>` : ''}
    `;
    if (n.link) {
      item.querySelector('.news-open-btn').addEventListener('click', () => {
        window.ph.openExternal('https://www.minecraft.net' + n.link);
      });
    }
    list.appendChild(item);
  });
}

// ===================== تحلیلگر کرش =====================
function listenForCrashAnalysis() {
  window.ph.onCrashAnalysis((data) => {
    appendLog('⚠️ ' + tt('crash.detected'));
    appendLog(tt('crash.' + data.key));
    appendLog(tt('crash.reportPath') + ': ' + data.reportPath);
  });
}

// ===================== حالت پرتابل =====================
async function refreshPortableStatus() {
  const status = await window.ph.getPortableStatus();
  const el = document.getElementById('portable-status');
  const btn = document.getElementById('btn-enable-portable');
  if (status.isPortable) {
    el.textContent = '✅ ' + tt('portable.active');
    btn.style.display = 'none';
  } else {
    el.textContent = '';
    btn.style.display = 'block';
  }
}

document.getElementById('btn-enable-portable').addEventListener('click', async () => {
  const res = await window.ph.enablePortable();
  if (!res.ok) { document.getElementById('portable-status').textContent = '❌ ' + res.error; return; }
  if (res.requiresRestart) {
    if (await showConfirm(tt('portable.restartConfirm'))) window.ph.restartApp();
  }
});

// ===================== چک آپدیت لانچر =====================
document.getElementById('btn-check-update').addEventListener('click', async () => {
  const statusEl = document.getElementById('update-status');
  statusEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
  const res = await window.ph.checkUpdate();
  if (res.unset) { statusEl.textContent = tt('update.notConfigured'); return; }
  if (!res.ok) { statusEl.textContent = '❌ ' + res.error; return; }
  if (res.hasUpdate) {
    statusEl.innerHTML = `🎉 ${tt('update.available')} (v${res.latestVersion})`;
    if (res.url) {
      const link = document.createElement('button');
      link.className = 'btn-ghost';
      link.style.marginTop = '8px';
      link.textContent = tt('update.download');
      link.addEventListener('click', () => window.ph.openExternal(res.url));
      statusEl.appendChild(document.createElement('br'));
      statusEl.appendChild(link);
    }
  } else {
    statusEl.textContent = '✅ ' + tt('update.upToDate');
  }
});

// ===================== خروجی/ورودی گرفتن از خود لانچر =====================
document.getElementById('btn-export-backup').addEventListener('click', async () => {
  const statusEl = document.getElementById('data-backup-status');
  const res = await window.ph.exportLauncherBackup();
  if (res.canceled) return;
  statusEl.textContent = res.ok ? `✅ ${res.path}` : '❌ ' + res.error;
});

document.getElementById('btn-import-backup').addEventListener('click', async () => {
  const statusEl = document.getElementById('data-backup-status');
  const res = await window.ph.importLauncherBackup();
  if (res.canceled) return;
  if (!res.ok) { statusEl.textContent = '❌ ' + res.error; return; }
  if (res.requiresRestart) {
    if (await showConfirm(tt('portable.restartConfirm'))) window.ph.restartApp();
  }
});

// ===================== درگ‌اند‌دراپ نصب فایل =====================
function setupDragAndDrop() {
  const overlay = document.getElementById('drop-overlay');
  let dragCounter = 0;

  document.addEventListener('dragover', (e) => { e.preventDefault(); });

  document.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragCounter++;
    overlay.classList.add('show');
  });

  document.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('show'); }
  });

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    overlay.classList.remove('show');
    const files = Array.from(e.dataTransfer.files || []);
    for (const file of files) {
      const filePath = file.path;
      if (!filePath) continue;
      const lower = filePath.toLowerCase();
      let kind = null;
      if (lower.endsWith('.mrpack')) kind = 'modpack';
      else if (lower.endsWith('.jar')) kind = 'mod';
      else if (lower.endsWith('.zip')) kind = currentContentType === 'shader' ? 'shader' : 'resourcepack';
      else continue;

      const res = await window.ph.installDroppedFile(filePath, kind);
      openPanel('tools');
      if (kind === 'modpack') {
        document.querySelector('.sub-btn[data-sub="instances"]').click();
        if (res.ok) { refreshInstances(); } else { await showAlert(res.error); }
      } else if (kind === 'mod') {
        document.querySelector('.sub-btn[data-sub="mods"]').click();
        if (res.ok) refreshInstalledMods(); else await showAlert(res.error);
      } else {
        document.querySelector('.sub-btn[data-sub="content"]').click();
        if (res.ok) refreshInstalledContent(); else await showAlert(res.error);
      }
    }
  });
}

// ===================== کشف دنیاهای LAN =====================
async function refreshLanGames() {
  const list = document.getElementById('lan-list');
  if (!list) return;
  const games = await window.ph.listLanGames();
  list.innerHTML = '';
  if (!games || games.length === 0) {
    list.innerHTML = `<div class="empty-state">-</div>`;
    return;
  }
  games.forEach((g) => {
    const item = document.createElement('div');
    item.className = 'account-item';
    item.innerHTML = `
      <div class="avatar-circle"><i class="fa-solid fa-house-signal"></i></div>
      <div class="info">
        <div class="name">${g.motd || tt('lan.unnamed')}</div>
        <div class="type-badge">${g.address}:${g.port}</div>
      </div>
      <div class="actions"><button class="icon-btn lan-connect-btn" title="connect"><i class="fa-solid fa-plug"></i></button></div>
    `;
    item.querySelector('.lan-connect-btn').addEventListener('click', () => quickConnect(`${g.address}:${g.port}`));
    list.appendChild(item);
  });
}

// ===================== آپدیت‌کننده‌ی مادها =====================
document.getElementById('btn-check-mod-updates').addEventListener('click', async () => {
  const { mcVersion, loader } = getModTarget();
  if (!mcVersion) {
    await showAlert(tt('mods.needVersion'));
    return;
  }
  const btn = document.getElementById('btn-check-mod-updates');
  btn.disabled = true;
  btn.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
  const res = await window.ph.checkModUpdates(mcVersion, loader, null);
  btn.disabled = false;
  btn.innerHTML = `<i class="fa-solid fa-arrows-rotate"></i> <span>${tt('mods.checkUpdates')}</span>`;
  if (!res.ok) { await showAlert(res.error); return; }
  state.modUpdates = res.updates || [];
  refreshInstalledMods();
  updateToolsDockBadge();
});

// ===================== کارت رنک قابل‌اشتراک =====================
document.getElementById('btn-generate-card').addEventListener('click', async () => {
  if (!state.rank) return;
  const active = state.accounts.find((a) => a.id === state.activeAccountId);
  const canvas = document.getElementById('rank-share-canvas');
  const ctx = canvas.getContext('2d');
  const W = canvas.width, H = canvas.height;

  const grad = ctx.createLinearGradient(0, 0, W, H);
  grad.addColorStop(0, '#141416');
  grad.addColorStop(1, '#0a0a0c');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = 'rgba(255,140,26,.4)';
  ctx.lineWidth = 2;
  ctx.strokeRect(1, 1, W - 2, H - 2);

  const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ff8c1a';

  ctx.fillStyle = accent;
  ctx.font = 'bold 28px sans-serif';
  ctx.fillText('PH Launcher', 36, 56);

  ctx.fillStyle = '#f2f2f2';
  ctx.font = 'bold 40px sans-serif';
  ctx.fillText(active ? active.username : 'Player', 36, 120);

  ctx.fillStyle = accent;
  ctx.font = 'bold 32px sans-serif';
  ctx.fillText(`Lv.${state.rank.level} — ${tt('rank.' + state.rank.rankKey)}`, 36, 168);

  ctx.fillStyle = '#9a9aa2';
  ctx.font = '18px sans-serif';
  ctx.fillText(`${formatHours(state.rank.totalPlaySeconds)}h ${tt('status.totalPlaytime')}`, 36, 210);

  const unlockedCount = (await window.ph.listAchievements()).filter((a) => a.unlocked).length;
  ctx.fillText(`🏆 ${unlockedCount} ${tt('ach.title')}`, 36, 240);

  const barY = 280, barW = W - 72, barH = 16;
  ctx.fillStyle = 'rgba(255,255,255,.08)';
  roundRect(ctx, 36, barY, barW, barH, 8); ctx.fill();
  const pct = Math.min(1, state.rank.xpIntoLevel / state.rank.xpForNext);
  const barGrad = ctx.createLinearGradient(36, 0, 36 + barW, 0);
  barGrad.addColorStop(0, accent); barGrad.addColorStop(1, '#ff5e1a');
  ctx.fillStyle = barGrad;
  roundRect(ctx, 36, barY, barW * pct, barH, 8); ctx.fill();

  ctx.fillStyle = '#9a9aa2';
  ctx.font = '14px sans-serif';
  ctx.fillText(`${state.rank.xpIntoLevel} / ${state.rank.xpForNext} XP`, 36, barY + 36);

  const dataUrl = canvas.toDataURL('image/png');
  const preview = document.getElementById('share-preview');
  preview.src = dataUrl;
  preview.style.display = 'block';
  document.getElementById('btn-save-card').disabled = false;
  document.getElementById('btn-copy-card').disabled = false;
  state.shareCardDataUrl = dataUrl;
});

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

document.getElementById('btn-save-card').addEventListener('click', async () => {
  if (!state.shareCardDataUrl) return;
  const res = await window.ph.saveImage(state.shareCardDataUrl, 'ph-launcher-rank-card.png');
  const statusEl = document.getElementById('share-status');
  if (res.canceled) return;
  statusEl.textContent = res.ok ? '✅ ' + res.path : '❌ ' + res.error;
});

document.getElementById('btn-copy-card').addEventListener('click', async () => {
  if (!state.shareCardDataUrl) return;
  const res = await window.ph.copyImageToClipboard(state.shareCardDataUrl);
  document.getElementById('share-status').textContent = res.ok ? '✅' : '❌ ' + res.error;
});

// ===================== اخیراً بازی‌شده =====================
async function refreshRecentlyPlayed() {
  const row = document.getElementById('recently-played-row');
  const list = await window.ph.listRecentlyPlayed();
  row.innerHTML = '';
  if (!list || list.length === 0) return;
  list.forEach((r) => {
    const chip = document.createElement('button');
    chip.className = 'recent-chip';
    chip.innerHTML = `<i class="fa-solid fa-clock-rotate-left"></i> ${r.name}`;
    chip.addEventListener('click', async () => {
      if (r.instanceId) {
        closePanel();
        clearLog();
        const res = await window.ph.launchInstance(r.instanceId);
        if (!res.ok) appendLog('[ERROR] ' + res.error);
      } else if (state.versions.some((v) => v.id === r.versionId)) {
        selectVersion(r.versionId);
      }
    });
    row.appendChild(chip);
  });
}

// ===================== میان‌برهای صفحه‌کلید =====================
function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (e) => {
    const inInput = ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter' && !inInput) {
      e.preventDefault();
      const btn = document.getElementById('btn-launch');
      if (!btn.disabled) btn.click();
    }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'l' && !inInput) {
      e.preventDefault();
      document.getElementById('home-version-select').focus();
    }
    if ((e.ctrlKey || e.metaKey) && e.key === ',') {
      e.preventDefault();
      openPanel('settings');
    }
  });
}

// ===================== پروتکل ph-launcher:// =====================
function listenForProtocolActions() {
  window.ph.onProtocolAction(async (data) => {
    if (data.action === 'connect' && data.params.address) {
      if (!state.selectedVersion) {
        await showAlert(tt('home.selectVersionPlaceholder'));
        return;
      }
      closePanel();
      clearLog();
      const res = await window.ph.launchVersion(state.selectedVersion, data.params.address);
      if (!res.ok) appendLog('[ERROR] ' + res.error);
    } else if (data.action === 'launch' && data.params.version) {
      if (state.versions.some((v) => v.id === data.params.version)) {
        selectVersion(data.params.version);
        document.getElementById('btn-launch').click();
      }
    }
  });
}

// ===================== بج آپدیت روی داک ===================== 
function updateToolsDockBadge() {
  const badge = document.getElementById('dock-badge-tools');
  badge.style.display = (state.modUpdates && state.modUpdates.length > 0) ? 'block' : 'none';
}

async function checkLauncherUpdateBadge() {
  try {
    const res = await window.ph.checkUpdate();
    document.getElementById('dock-badge-settings').style.display = (res.ok && res.hasUpdate) ? 'block' : 'none';
  } catch (e) { /* بی‌صدا نادیده بگیر */ }
}

// ===================== ویزارد خوش‌آمدگویی (اولین اجرا) =====================
function showOnboarding() {
  document.getElementById('onboard-lang-select').value = currentLang();
  document.getElementById('onboarding-overlay').style.display = 'flex';
}

function goToOnboardStep(n) {
  document.querySelectorAll('.onboarding-step').forEach((s) => s.classList.remove('active'));
  document.getElementById('onboard-step-' + n).classList.add('active');
  document.querySelectorAll('.onboarding-dots .dot').forEach((d) => {
    d.classList.toggle('active', d.dataset.step === String(n));
  });
}

document.getElementById('onboard-lang-select').addEventListener('change', async (e) => {
  state.settings = await window.ph.saveSettings({ lang: e.target.value });
  applyLanguage(e.target.value);
  redrawAllForLanguage();
});

document.querySelectorAll('.onboard-next').forEach((btn) => {
  btn.addEventListener('click', () => {
    const next = btn.dataset.next;
    if (next) goToOnboardStep(next);
  });
});

document.getElementById('onboard-btn-detect').addEventListener('click', async () => {
  const statusEl = document.getElementById('onboard-dir-status');
  statusEl.innerHTML = `<i class="fa-solid fa-spinner fa-spin"></i>`;
  const res = await window.ph.autoDetectMcDir();
  if (res.ok) {
    state.settings = await window.ph.saveSettings({ mcDir: res.path });
    document.getElementById('input-mcdir').value = res.path;
    statusEl.textContent = '✅ ' + res.path;
    await refreshVersions();
  } else {
    statusEl.textContent = tt('settings.autoDetectFail');
  }
});

document.getElementById('onboard-btn-browse').addEventListener('click', async () => {
  const dir = await window.ph.browseFolder();
  if (dir) {
    state.settings = await window.ph.saveSettings({ mcDir: dir });
    document.getElementById('input-mcdir').value = dir;
    document.getElementById('onboard-dir-status').textContent = '✅ ' + dir;
    await refreshVersions();
  }
});

document.getElementById('onboard-finish').addEventListener('click', async () => {
  const username = document.getElementById('onboard-username').value.trim();
  if (username) {
    const active = state.accounts.find((a) => a.id === state.activeAccountId);
    if (active && active.username === 'Player') {
      // اکانت پیش‌فرض «Player» رو با اسمی که کاربر خودش نوشته جایگزین کن
      const res = await window.ph.addOfflineAccount(username);
      if (res.ok) {
        await window.ph.setActiveAccount(res.account.id);
        await window.ph.removeAccount(active.id);
      }
    } else if (!active) {
      const res = await window.ph.addOfflineAccount(username);
      if (res.ok) await window.ph.setActiveAccount(res.account.id);
    }
    await refreshAccounts();
  }
  state.settings = await window.ph.saveSettings({ onboardingComplete: true });
  document.getElementById('onboarding-overlay').style.display = 'none';
});

// ===================== کمک‌کننده‌های عمومی UI: توست، اسکلت لودینگ، حالت خالی =====================
function escHtml(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function showToast(message, type) {
  const stack = document.getElementById('toast-stack');
  if (!stack) return;
  const el = document.createElement('div');
  el.className = 'toast ' + (type || 'info');
  const icon = type === 'error' ? 'fa-circle-exclamation' : type === 'success' ? 'fa-circle-check' : 'fa-circle-info';
  el.innerHTML = `<i class="fa-solid ${icon}"></i><span>${escHtml(message)}</span>`;
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  }, 3200);
}

function skeletonRows(n) {
  return Array.from({ length: n }, () => '<div class="skeleton"></div>').join('');
}

function emptyBlock(icon, text, actionHtml) {
  return `<div class="empty-block"><i class="fa-solid ${icon}"></i><div>${escHtml(text)}</div>${actionHtml || ''}</div>`;
}

function formatDuration(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m`;
  return s > 0 ? '<1m' : '0m';
}

function formatDateShort(unixSeconds) {
  try {
    return new Date(unixSeconds * 1000).toLocaleDateString(currentLang() === 'fa' ? 'fa-IR' : currentLang());
  } catch (e) { return ''; }
}

// ===================== لیدربورد =====================
const LB = { mode: 'playtime', me: '', busy: false };

function lbErrText(code) {
  const map = {
    bad_key: 'lb.err.bad_key', network: 'lb.err.network', host_challenge: 'lb.err.host_challenge',
    bad_response: 'lb.err.bad_response', bad_url: 'lb.err.bad_url', name_taken: 'lb.err.name_taken',
    bad_username: 'lb.err.bad_username', db_connect_failed: 'lb.err.server', db_error: 'lb.err.server',
    config_missing: 'lb.err.server', not_configured: 'lb.notConfigured'
  };
  return tt(map[code] || 'lb.err.unknown');
}

function lbAchIcon(id) {
  const a = (state.achievements || []).find((x) => x.id === id);
  return a ? a.icon : 'fa-medal';
}

function lbAchName(id) {
  const key = 'ach.' + id + '.name';
  const txt = tt(key);
  return txt === key ? id : txt;
}

function lbShowList() {
  document.getElementById('lb-detail').style.display = 'none';
  document.getElementById('lb-list').style.display = 'flex';
}

async function refreshLeaderboard() {
  const listEl = document.getElementById('lb-list');
  const summary = document.getElementById('lb-summary');
  lbShowList();
  document.querySelectorAll('.lb-tab').forEach((b) => b.classList.toggle('active', b.dataset.lb === LB.mode));

  // پیکربندی لیدربورد (آدرس/کلید) دیگه سمت رابط کاربری نیست — مستقیم توی main.js هاردکده،
  // پس این‌جا فقط از روی جواب واقعی IPC می‌فهمیم وصله یا نه (خطای not_configured از پایین میاد).
  if (LB.busy) return;
  LB.busy = true;
  listEl.innerHTML = skeletonRows(6);
  summary.textContent = '';
  try {
    if (!state.achievements || !state.achievements.length) state.achievements = await window.ph.listAchievements();
    if (LB.mode === 'wall') {
      const res = await window.ph.leaderboardAchievements();
      if (!res.ok) throw new Error(res.error);
      renderLbWall(res);
    } else {
      const res = await window.ph.leaderboardFetch(LB.mode);
      if (!res.ok) throw new Error(res.error);
      LB.me = res.me || '';
      renderLbList(res);
      if (res.syncError) showToast(tt('lb.syncFailed') + ': ' + lbErrText(res.syncError), 'error');
    }
  } catch (e) {
    summary.textContent = '';
    listEl.innerHTML = emptyBlock('fa-triangle-exclamation', lbErrText(e.message));
  } finally {
    LB.busy = false;
  }
}

function renderLbList(res) {
  const listEl = document.getElementById('lb-list');
  document.getElementById('lb-summary').textContent = tt('lb.players').replace('{n}', res.totalPlayers);
  if (!res.players.length) {
    listEl.innerHTML = emptyBlock('fa-users-slash', tt('lb.noPlayers'));
    return;
  }
  listEl.innerHTML = '';
  res.players.forEach((p, i) => {
    const row = document.createElement('div');
    const isMe = LB.me && p.username.toLowerCase() === LB.me.toLowerCase();
    row.className = `lb-row pos-${i + 1}` + (isMe ? ' me' : '');
    const main = LB.mode === 'achievements' ? `${p.achievements} <i class="fa-solid fa-trophy"></i>` : formatDuration(p.playtime);
    const sub = LB.mode === 'achievements'
      ? `<span><i class="fa-solid fa-clock"></i>${formatDuration(p.playtime)}</span><span><i class="fa-solid fa-star"></i>${escHtml(tt('lb.level'))} ${p.level}</span>`
      : `<span><i class="fa-solid fa-star"></i>${escHtml(tt('lb.level'))} ${p.level}</span><span><i class="fa-solid fa-trophy"></i>${p.achievements}</span><span><i class="fa-solid fa-rocket"></i>${p.launches}</span>`;
    row.innerHTML = `
      <div class="lb-pos">${i + 1}</div>
      <div>
        <div class="lb-name">${escHtml(p.username)}${isMe ? `<span class="you-tag">${escHtml(tt('lb.you'))}</span>` : ''}</div>
        <div class="lb-sub">${sub}</div>
      </div>
      <div class="lb-value">${main}</div>`;
    row.addEventListener('click', () => openLbPlayer(p.username));
    listEl.appendChild(row);
  });
}

async function openLbPlayer(name) {
  const detail = document.getElementById('lb-detail');
  document.getElementById('lb-list').style.display = 'none';
  detail.style.display = 'block';
  detail.innerHTML = skeletonRows(4);
  const res = await window.ph.leaderboardPlayer(name);
  if (!res.ok) {
    detail.innerHTML = `<button class="btn-ghost" id="lb-back"><i class="fa-solid fa-rotate-left"></i> ${escHtml(tt('lb.back'))}</button>` + emptyBlock('fa-triangle-exclamation', lbErrText(res.error));
    document.getElementById('lb-back').addEventListener('click', lbShowList);
    return;
  }
  const p = res.player;
  const unlockedIds = new Set(p.achievements.map((a) => a.id));
  const times = {};
  p.achievements.forEach((a) => { times[a.id] = a.at; });
  // اول همه‌ی دستاوردهای شناخته‌شده (باز/قفل)، بعد دستاوردهای ناشناخته‌ی نسخه‌های جدیدتر
  const known = (state.achievements || []).map((a) => a.id);
  const extra = p.achievements.map((a) => a.id).filter((id) => !known.includes(id));
  const cards = known.concat(extra).map((id) => {
    const on = unlockedIds.has(id);
    return `<div class="ach-card${on ? '' : ' locked'}" title="${on ? escHtml(formatDateShort(times[id])) : ''}">
      <i class="fa-solid ${escHtml(lbAchIcon(id))}"></i><div>${escHtml(lbAchName(id))}</div>
      ${on ? `<div class="muted small">${escHtml(formatDateShort(times[id]))}</div>` : ''}
    </div>`;
  }).join('');
  detail.innerHTML = `
    <div class="lb-detail-head">
      <button class="btn-ghost" id="lb-back"><i class="fa-solid fa-rotate-left"></i> ${escHtml(tt('lb.back'))}</button>
      <h3>${escHtml(p.username)}</h3>
    </div>
    <div class="lb-stats">
      <div class="lb-stat"><b>${formatDuration(p.playtime)}</b><span>${escHtml(tt('lb.playtime'))}</span></div>
      <div class="lb-stat"><b>${p.level}</b><span>${escHtml(tt('lb.level'))}</span></div>
      <div class="lb-stat"><b>${p.launches}</b><span>${escHtml(tt('lb.launches'))}</span></div>
      <div class="lb-stat"><b>${p.achievements.length}</b><span>${escHtml(tt('lb.achievements'))}</span></div>
    </div>
    <div class="achievements-grid">${cards}</div>`;
  document.getElementById('lb-back').addEventListener('click', lbShowList);
}

function renderLbWall(res) {
  const listEl = document.getElementById('lb-list');
  document.getElementById('lb-summary').textContent = tt('lb.players').replace('{n}', res.totalPlayers);
  const byId = {};
  res.achievements.forEach((a) => { byId[a.id] = a; });
  const ids = (state.achievements || []).map((a) => a.id);
  Object.keys(byId).forEach((id) => { if (!ids.includes(id)) ids.push(id); });
  listEl.innerHTML = '';
  ids.forEach((id) => {
    const a = byId[id] || { count: 0, players: [] };
    const item = document.createElement('div');
    item.className = 'lb-wall-item';
    const chips = a.players.length
      ? a.players.map((pl) => `<span class="lb-chip clickable" data-name="${escHtml(pl.username)}">${escHtml(pl.username)}</span>`).join('')
      : `<span class="muted small">${escHtml(tt('lb.nobody'))}</span>`;
    item.innerHTML = `
      <div class="wall-icon"><i class="fa-solid ${escHtml(lbAchIcon(id))}"></i></div>
      <div>
        <div style="font-weight:700;font-size:13px">${escHtml(lbAchName(id))}</div>
        <div class="muted small">${escHtml(tt('lb.unlockedBy'))}</div>
        <div class="lb-chips">${chips}</div>
      </div>
      <div class="wall-count">${a.count}</div>`;
    item.querySelectorAll('.lb-chip.clickable').forEach((c) => c.addEventListener('click', () => openLbPlayer(c.dataset.name)));
    listEl.appendChild(item);
  });
}

document.querySelectorAll('.lb-tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    LB.mode = btn.dataset.lb;
    refreshLeaderboard();
  });
});
document.getElementById('lb-refresh').addEventListener('click', refreshLeaderboard);

init();

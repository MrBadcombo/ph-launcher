const { app, BrowserWindow, ipcMain, dialog, shell, nativeImage, Tray, Menu, Notification, clipboard, session } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const https = require('https');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const AdmZip = require('adm-zip');
const zlib = require('zlib');

// ---------- محافظ کلی در برابر کرش کل برنامه ----------
// این پروژه بزرگه و همیشه احتمال داره یه گوشه‌ی پیش‌بینی‌نشده خطا بده (مثلاً یه دانلود، یه
// عملیات فایل‌سیستمی و...). بدون این محافظ، هر خطای catch-نشده کل پنجره‌ی الکترون رو کرش
// می‌کنه (دقیقاً همون چیزی که برای اسم‌ست‌های تکراری موقع دانلود پیش اومد). این‌جا فقط
// لاگش می‌کنیم و برنامه به کارش ادامه می‌ده، به‌جای اینکه کاربر یهو با یه دیالوگ خطا مواجه بشه.
process.on('uncaughtException', (err) => {
  console.error('[uncaughtException]', err);
  try {
    if (typeof safeSend === 'function') safeSend('game:log', `[ERROR] خطای غیرمنتظره: ${err.message}`);
  } catch (e) { /* اگه safeSend هنوز تعریف نشده یا خودش خطا داد، فقط از لاگ بالا رد شو */ }
});

process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
let cachedManifest = null;

function httpRequestRaw(url, options = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: options.method || 'GET',
      headers: options.headers || {}
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => resolve({ statusCode: res.statusCode, body: data }));
    });
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

function upsertAccount(account) {
  const idx = appData.accounts.findIndex((a) => a.id === account.id);
  if (idx >= 0) appData.accounts[idx] = account; else appData.accounts.push(account);
  saveData(appData);
}

function sanitizeAccount(a) {
  return {
    id: a.id,
    username: a.username,
    uuid: a.uuid,
    skins: (a.skins || []).map((s) => ({ id: s.id, name: s.name, model: s.model })),
    activeSkinId: a.activeSkinId || null
  };
}

// ===================== لایه‌ی شبکه: تایم‌اوت + تلاش مجدد + تایید فایل =====================
// قبلاً هیچ‌کدوم از درخواست‌ها تایم‌اوت نداشتن؛ یه اتصال معلق (مثلاً به‌خاطر اینترنت ناپایدار) می‌تونست
// کل دانلود رو برای همیشه روی «آخرین فایل‌ها» گیر بندازه. خطاها هم بی‌سروصدا نادیده گرفته می‌شدن.
const NET_TIMEOUT_MS = 25000;   // اگه ۲۵ ثانیه هیچ دیتایی نیومد، اتصال رو قطع و دوباره تلاش می‌کنیم
const NET_MAX_REDIRECTS = 5;
const NET_MAX_ATTEMPTS = 3;

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function isPermanentHttpError(err) {
  // خطای 4xx (به‌جز 408 و 429) با تکرار درست نمی‌شه
  const m = /^HTTP (\d+)/.exec((err && err.message) || '');
  if (!m) return false;
  const code = parseInt(m[1], 10);
  return code >= 400 && code < 500 && code !== 408 && code !== 429;
}

function httpGetJSONOnce(url, redirectsLeft) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const req = https.get(url, { headers: { 'User-Agent': 'PH-Launcher' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return done(reject, new Error('too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        return httpGetJSONOnce(next, redirectsLeft - 1).then((v) => done(resolve, v), (e) => done(reject, e));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return done(reject, new Error('HTTP ' + res.statusCode + ' برای ' + url));
      }
      let data = '';
      res.setEncoding('utf8'); // جلوی خراب شدن کاراکترهای چندبایتی (فارسی/چینی...) بین chunkها رو می‌گیره
      res.on('data', (c) => (data += c));
      res.on('error', (e) => done(reject, e));
      res.on('end', () => {
        try { done(resolve, JSON.parse(data)); } catch (e) { done(reject, e); }
      });
    });
    req.setTimeout(NET_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => done(reject, e));
  });
}

async function httpGetJSON(url) {
  let lastErr;
  for (let attempt = 0; attempt < NET_MAX_ATTEMPTS; attempt++) {
    try {
      return await httpGetJSONOnce(url, NET_MAX_REDIRECTS);
    } catch (e) {
      lastErr = e;
      if (isPermanentHttpError(e)) break;
      await sleep(600 * (attempt + 1));
    }
  }
  throw lastErr;
}

function httpPostJSON(url, bodyObj) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (fn, v) => { if (!settled) { settled = true; fn(v); } };
    const body = JSON.stringify(bodyObj);
    const u = new URL(url);
    const req = https.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'POST',
      headers: {
        'User-Agent': 'PH-Launcher',
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('error', (e) => done(reject, e));
      res.on('end', () => {
        try { done(resolve, JSON.parse(data)); } catch (e) { done(reject, e); }
      });
    });
    req.setTimeout(NET_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
    req.on('error', (e) => done(reject, e));
    req.write(body);
    req.end();
  });
}

// یک بار تلاش برای دانلود. sha1 اختیاریه؛ اگه حجم یا هش با مقدار مورد انتظار نخوند، فایل ناقص/خراب
// دور ریخته می‌شه (قبلاً یه فایل نصفه‌نیمه می‌تونست به‌عنوان «دانلودشده» بمونه و بازی بالا نیاد).
function downloadFileOnce(url, destPath, expectedSize, sha1, redirectsLeft) {
  return new Promise((resolve, reject) => {
    if (expectedSize && fs.existsSync(destPath)) {
      try {
        if (fs.statSync(destPath).size === expectedSize) return resolve(false);
      } catch (e) { /* نادیده بگیر و دوباره دانلود کن */ }
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    // پسوند تصادفی: دو دانلود هم‌زمان روی یه مقصد، فایل موقت همدیگه رو خراب نمی‌کنن.
    const tmpPath = destPath + '.' + crypto.randomBytes(4).toString('hex') + '.part';
    const file = fs.createWriteStream(tmpPath);
    let settled = false;
    let req = null;

    const fail = (err) => {
      if (settled) return;
      settled = true;
      try { if (req) req.destroy(); } catch (e) { /* رد شو */ }
      file.close(() => fs.unlink(tmpPath, () => reject(err)));
    };
    file.on('error', fail);

    try {
      req = https.get(url, { headers: { 'User-Agent': 'PH-Launcher' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (settled) return;
          settled = true;
          file.close(() => fs.unlink(tmpPath, () => {}));
          if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
          const next = new URL(res.headers.location, url).toString();
          return downloadFileOnce(next, destPath, expectedSize, sha1, redirectsLeft - 1).then(resolve, reject);
        }
        if (res.statusCode !== 200) {
          res.resume();
          return fail(new Error('HTTP ' + res.statusCode + ' برای ' + url));
        }
        const hash = sha1 ? crypto.createHash('sha1') : null;
        let received = 0;
        res.on('data', (c) => { received += c.length; if (hash) hash.update(c); });
        res.on('error', fail);
        res.on('aborted', () => fail(new Error('connection aborted')));
        res.pipe(file);
        file.on('finish', () => {
          if (settled) return;
          if (expectedSize && received !== expectedSize) {
            return fail(new Error(`حجم فایل نادرسته (${received} به‌جای ${expectedSize})`));
          }
          if (hash && hash.digest('hex') !== String(sha1).toLowerCase()) {
            return fail(new Error('هش فایل دانلودشده با مقدار مورد انتظار نمی‌خونه'));
          }
          file.close(() => {
            if (settled) return;
            settled = true;
            try {
              fs.renameSync(tmpPath, destPath);
              resolve(true);
            } catch (err) {
              // اگه دقیقاً همین لحظه یه دانلود هم‌زمان دیگه فایل مقصد رو کامل نوشته باشه، شکست حساب نمی‌شه.
              fs.unlink(tmpPath, () => {});
              if (fs.existsSync(destPath)) resolve(true);
              else reject(err);
            }
          });
        });
      });
      req.setTimeout(NET_TIMEOUT_MS, () => req.destroy(new Error('timeout')));
      req.on('error', fail);
    } catch (err) {
      fail(err);
    }
  });
}

// خروجی: true = دانلود شد ، false = از قبل سالم موجود بود
async function downloadFile(url, destPath, expectedSize, sha1) {
  let lastErr;
  for (let attempt = 0; attempt < NET_MAX_ATTEMPTS; attempt++) {
    try {
      return await downloadFileOnce(url, destPath, expectedSize, sha1, NET_MAX_REDIRECTS);
    } catch (e) {
      lastErr = e;
      if (isPermanentHttpError(e)) break;
      await sleep(500 * (attempt + 1));
    }
  }
  throw lastErr;
}

// آرایه‌ی شکست‌ها رو برمی‌گردونه ({item, error}) تا صدا زننده تصمیم بگیره؛ دیگه هیچ خطایی بی‌صدا گم نمی‌شه.
async function downloadWithConcurrency(items, worker, concurrency, onProgress) {
  let index = 0;
  let done = 0;
  const total = items.length;
  const failures = [];
  async function runOne() {
    while (index < items.length) {
      const myIndex = index++;
      try {
        await worker(items[myIndex]);
      } catch (e) {
        failures.push({ item: items[myIndex], error: e.message });
        console.warn('download item failed', e.message);
      }
      done++;
      if (onProgress) onProgress(done, total);
    }
  }
  const runners = [];
  for (let i = 0; i < concurrency; i++) runners.push(runOne());
  await Promise.all(runners);
  return failures;
}

function detectJavaVersion(javaPath) {
  try {
    const result = spawnSync(javaPath || 'java', ['-version'], { encoding: 'utf-8' });
    const out = (result.stderr || '') + (result.stdout || '');
    const match = out.match(/version "?(\d+)(\.(\d+))?/);
    if (!match) return null;
    let major = parseInt(match[1], 10);
    if (major === 1 && match[3]) major = parseInt(match[3], 10); // فرمت قدیمی 1.8.0
    return { major, raw: out.split('\n')[0].trim() };
  } catch (e) {
    return null;
  }
}

// ---------- تشخیص خودکار پوشه‌ی ماینکرافت ----------
function autoDetectMcDir() {
  const home = os.homedir();
  const candidates = [];
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    candidates.push(path.join(appData, '.minecraft'));
  } else if (process.platform === 'darwin') {
    candidates.push(path.join(home, 'Library', 'Application Support', 'minecraft'));
  } else {
    candidates.push(path.join(home, '.minecraft'));
    candidates.push(path.join(home, '.var', 'app', 'com.mojang.Minecraft', '.minecraft')); // Flatpak
  }
  for (const c of candidates) {
    if (fs.existsSync(c) && fs.existsSync(path.join(c, 'versions'))) return c;
  }
  return null;
}

// ---------- مسیر داده‌های خود لانچر (تنظیمات، رنک، لیست مورد علاقه‌ها) ----------
// حالت پرتابل: اگه یه پوشه‌ی «ph-data» کنار فایل اجرایی وجود داشته باشه، از همون به‌جای
// پوشه‌ی پروفایل کاربری ویندوز/لینوکس/مک استفاده می‌کنیم (برای اجرا از روی فلش و مشابه آن).
const PORTABLE_DIR = path.join(path.dirname(process.execPath), 'ph-data');
const IS_PORTABLE = fs.existsSync(PORTABLE_DIR);
const DATA_DIR = IS_PORTABLE ? PORTABLE_DIR : app.getPath('userData');
const DATA_FILE = path.join(DATA_DIR, 'ph-launcher-data.json');

function defaultData() {
  return {
    settings: {
      mcDir: '',
      javaPath: '',
      ramMin: 1024,
      ramMax: 2048,
      accentColor: '#ff8c1a',
      lang: 'fa',
      favorites: [],
      activeAccountId: null,
      servers: [],
      lastVersion: '',
      closeToTray: true,
      minimizeOnLaunch: true,
      gameBoosterEnabled: false,
      autoBackupEnabled: false,
      autoBackupBeforeLaunch: false,
      autoBackupIntervalHours: 2,
      lastAutoBackupAt: 0,
      autoJavaMap: {},
      customJvmArgs: '',
      customGameArgs: '',
      discordRpcEnabled: false,
      lanDiscoveryEnabled: true,
      onboardingComplete: false,
      leaderboardToken: '' // شناسه‌ی ناشناس این نصب برای لیدربورد؛ خودکار ساخته می‌شه، ربطی به آدرس/کلید سرور نداره
    },
    rank: {
      totalPlaySeconds: 0,
      xp: 0,
      level: 1,
      playtimeByVersion: {}
    },
    accounts: [],
    instances: [],
    stats: { launchCount: 0, versionsPlayed: [], modsInstalledCount: 0, instancesCreated: 0, serversPinged: 0 },
    achievementsUnlocked: [],
    achievementTimes: {},
    recentlyPlayed: []
  };
}

function loadData() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    if (!fs.existsSync(DATA_FILE)) {
      const d = defaultData();
      fs.writeFileSync(DATA_FILE, JSON.stringify(d, null, 2));
      return d;
    }
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    // merge with defaults so new fields never crash old save files
    const d = defaultData();
    d.settings = Object.assign({}, d.settings, parsed.settings || {});
    d.rank = Object.assign({}, d.rank, parsed.rank || {});
    d.rank.playtimeByVersion = Object.assign({}, d.rank.playtimeByVersion, (parsed.rank && parsed.rank.playtimeByVersion) || {});
    d.accounts = parsed.accounts || [];
    d.instances = parsed.instances || [];
    d.stats = Object.assign({}, d.stats, parsed.stats || {});
    d.achievementsUnlocked = parsed.achievementsUnlocked || [];
    d.achievementTimes = parsed.achievementTimes || {};
    d.recentlyPlayed = parsed.recentlyPlayed || [];
    return d;
  } catch (e) {
    console.error('loadData error', e);
    return defaultData();
  }
}

function saveData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    // یه خطای نوشتن دیسک (دیسک پر، دسترسی و...) نباید کل برنامه رو کرش کنه؛
    // فقط لاگش می‌کنیم و برنامه به کارش ادامه می‌ده.
    console.warn('saveData failed:', err.message);
  }
}

let appData = loadData();

function ensureDefaultAccount() {
  if (appData.accounts.length === 0) {
    const account = { id: 'off-' + crypto.randomBytes(6).toString('hex'), type: 'offline', username: 'Player', uuid: offlineUUID('Player') };
    appData.accounts.push(account);
    appData.settings.activeAccountId = account.id;
    saveData(appData);
  } else if (!appData.settings.activeAccountId || !appData.accounts.some((a) => a.id === appData.settings.activeAccountId)) {
    appData.settings.activeAccountId = appData.accounts[0].id;
    saveData(appData);
  }
}
ensureDefaultAccount();

// اگه مسیر ماینکرافت هنوز تنظیم نشده، خودکار امتحان کن پیداش کنی
if (!appData.settings.mcDir) {
  const detected = autoDetectMcDir();
  if (detected) {
    appData.settings.mcDir = detected;
    saveData(appData);
  }
}

// ---------- سیستم رنک / XP ----------
// هر ساعت بازی = 100 XP. هر لول نیاز به (level * 100) XP تجمعی بیشتر داره.
const RANKS = [
  { key: 'explorer', minLevel: 1, icon: 'fa-compass', unlock: [] },
  { key: 'guardian', minLevel: 5, icon: 'fa-shield-halved', unlock: ['theme', 'favorites', 'trayQuickLaunch'] },
  { key: 'destroyer', minLevel: 10, icon: 'fa-fire', unlock: ['theme', 'favorites', 'trayQuickLaunch', 'gallery', 'quickfolders'] },
  { key: 'titan', minLevel: 20, icon: 'fa-dragon', unlock: ['theme', 'favorites', 'trayQuickLaunch', 'gallery', 'quickfolders', 'backup', 'turboDownload', 'gameBooster'] },
  { key: 'immortal', minLevel: 30, icon: 'fa-crown', unlock: ['theme', 'favorites', 'trayQuickLaunch', 'gallery', 'quickfolders', 'backup', 'turboDownload', 'gameBooster', 'legend-badge'] }
];

function isFeatureUnlocked(key) {
  // همه‌ی قابلیت‌ها از همون ابتدا برای همه باز هستن؛ سیستم رنک/لول فقط جنبه‌ی نمایشیه.
  return true;
}

function xpNeededForLevel(level) {
  // مقدار XP لازم برای رفتن از لول level به level+1
  return level * 100;
}

function computeLevelFromXP(totalXP) {
  let level = 1;
  let remaining = totalXP;
  while (remaining >= xpNeededForLevel(level)) {
    remaining -= xpNeededForLevel(level);
    level++;
  }
  return { level, xpIntoLevel: remaining, xpForNext: xpNeededForLevel(level) };
}

function getRankInfo(level) {
  let current = RANKS[0];
  for (const r of RANKS) {
    if (level >= r.minLevel) current = r;
  }
  const idx = RANKS.indexOf(current);
  const next = RANKS[idx + 1] || null;
  return { current, next };
}

function addPlaySeconds(seconds, versionId) {
  const before = appData.rank.totalPlaySeconds;
  const after = before + seconds;
  const hoursBefore = Math.floor(before / 3600);
  const hoursAfter = Math.floor(after / 3600);
  const newHours = hoursAfter - hoursBefore;
  if (newHours > 0) {
    appData.rank.xp += newHours * 100;
  }
  appData.rank.totalPlaySeconds = after;
  if (versionId) {
    appData.rank.playtimeByVersion[versionId] = (appData.rank.playtimeByVersion[versionId] || 0) + seconds;
  }
  saveData(appData);
  return newHours * 100;
}

function getFullRankSnapshot() {
  const { level, xpIntoLevel, xpForNext } = computeLevelFromXP(appData.rank.xp);
  appData.rank.level = level;
  const { current, next } = getRankInfo(level);
  const playtimeList = Object.entries(appData.rank.playtimeByVersion || {})
    .map(([versionId, seconds]) => ({ versionId, seconds }))
    .sort((a, b) => b.seconds - a.seconds);
  return {
    xp: appData.rank.xp,
    level,
    xpIntoLevel,
    xpForNext,
    totalPlaySeconds: appData.rank.totalPlaySeconds,
    rankKey: current.key,
    rankIcon: current.icon,
    unlocked: current.unlock,
    nextRank: next ? { key: next.key, minLevel: next.minLevel } : null,
    playtimeByVersion: playtimeList
  };
}

// ---------- دستاوردها ----------
const ACHIEVEMENTS = [
  { id: 'first-launch', icon: 'fa-rocket', condition: (s, rank) => s.launchCount >= 1 },
  { id: 'ten-launches', icon: 'fa-fire', condition: (s, rank) => s.launchCount >= 10 },
  { id: 'fifty-launches', icon: 'fa-crown', condition: (s, rank) => s.launchCount >= 50 },
  { id: 'version-collector', icon: 'fa-layer-group', condition: (s, rank) => s.versionsPlayed.length >= 5 },
  { id: 'ten-hours', icon: 'fa-clock', condition: (s, rank) => rank.totalPlaySeconds >= 36000 },
  { id: 'hundred-hours', icon: 'fa-hourglass-half', condition: (s, rank) => rank.totalPlaySeconds >= 360000 },
  { id: 'max-rank', icon: 'fa-crown', condition: (s, rank) => rank.level >= 30 },
  { id: 'modder', icon: 'fa-puzzle-piece', condition: (s, rank) => s.modsInstalledCount >= 1 },
  { id: 'mod-collector', icon: 'fa-boxes-stacked', condition: (s, rank) => s.modsInstalledCount >= 10 },
  { id: 'instance-builder', icon: 'fa-cubes', condition: (s, rank) => s.instancesCreated >= 1 },
  { id: 'network-explorer', icon: 'fa-network-wired', condition: (s, rank) => s.serversPinged >= 5 }
];

function checkAchievements() {
  appData.stats = appData.stats || { launchCount: 0, versionsPlayed: [], modsInstalledCount: 0, instancesCreated: 0, serversPinged: 0 };
  const rankSnap = getFullRankSnapshot();
  let changed = false;
  for (const ach of ACHIEVEMENTS) {
    if (appData.achievementsUnlocked.includes(ach.id)) continue;
    try {
      if (ach.condition(appData.stats, rankSnap)) {
        appData.achievementsUnlocked.push(ach.id);
        appData.achievementTimes = appData.achievementTimes || {};
        appData.achievementTimes[ach.id] = Date.now();
        changed = true;
        if (mainWindow) safeSend('achievements:unlocked', { id: ach.id, icon: ach.icon });
      }
    } catch (e) { /* ignore */ }
  }
  if (changed) saveData(appData);
}

// ---------- کمک‌کننده‌های منطق ماینکرافت ----------
function currentOsName() {
  const p = process.platform;
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'osx';
  return 'linux';
}

function evaluateRules(rules, features = {}) {
  // rules آرایه‌ای از { action: allow/disallow, os: {name}, features: {...} }
  if (!rules || rules.length === 0) return true;
  let allowed = false;
  for (const rule of rules) {
    let matches = true;
    if (rule.os && rule.os.name) {
      matches = matches && (rule.os.name === currentOsName());
    }
    if (rule.features) {
      for (const key of Object.keys(rule.features)) {
        if (features[key] !== rule.features[key]) { matches = false; break; }
      }
    }
    if (matches) {
      allowed = rule.action === 'allow';
    }
  }
  return allowed;
}

function readJSON(p) {
  return JSON.parse(fs.readFileSync(p, 'utf-8'));
}

// نسخه‌ها (مثل فورج/فابریک) می‌تونن inheritsFrom داشته باشن که باید با نسخه‌ی پدر ادغام بشه
function findVersionJsonPath(mcDir, versionId) {
  const expected = path.join(mcDir, 'versions', versionId, `${versionId}.json`);
  if (fs.existsSync(expected)) return expected;
  // اگه کسی فایل‌ها رو دستی توی پوشه ریخته و اسم json با اسم پوشه فرق داره، هر json داخل پوشه رو پیدا کن
  const dir = path.join(mcDir, 'versions', versionId);
  if (fs.existsSync(dir)) {
    const jsonFile = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.json'));
    if (jsonFile) return path.join(dir, jsonFile);
  }
  return null;
}

function findVersionJarPath(mcDir, versionId, jarSourceId) {
  const candidates = [
    path.join(mcDir, 'versions', jarSourceId, `${jarSourceId}.jar`),
    path.join(mcDir, 'versions', versionId, `${versionId}.jar`)
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return c;
  }
  // آخرین تلاش: هر فایل jar داخل پوشه‌ی خود نسخه
  const dir = path.join(mcDir, 'versions', versionId);
  if (fs.existsSync(dir)) {
    const jarFile = fs.readdirSync(dir).find((f) => f.toLowerCase().endsWith('.jar'));
    if (jarFile) return path.join(dir, jarFile);
  }
  return null;
}

function resolveVersionJson(mcDir, versionId, seen = new Set()) {
  if (seen.has(versionId)) throw new Error('حلقه‌ی نامعتبر در inheritsFrom نسخه‌ها');
  seen.add(versionId);
  const jsonPath = findVersionJsonPath(mcDir, versionId);
  if (!jsonPath) throw new Error(`فایل json نسخه‌ی ${versionId} پیدا نشد`);
  let json = readJSON(jsonPath);
  if (json.inheritsFrom) {
    const parent = resolveVersionJson(mcDir, json.inheritsFrom, seen);
    json = mergeVersionJson(parent, json);
  }
  json.__ownId = versionId;
  return json;
}

function mergeVersionJson(parent, child) {
  const merged = Object.assign({}, parent, child);
  merged.libraries = [...(parent.libraries || []), ...(child.libraries || [])];
  if (parent.arguments || child.arguments) {
    merged.arguments = {
      game: [...((parent.arguments && parent.arguments.game) || []), ...((child.arguments && child.arguments.game) || [])],
      jvm: [...((parent.arguments && parent.arguments.jvm) || []), ...((child.arguments && child.arguments.jvm) || [])]
    };
  }
  if (parent.minecraftArguments && !child.minecraftArguments) {
    merged.minecraftArguments = parent.minecraftArguments;
  }
  // برای بازی جار خود نسخه، اگه child مقدار نداره از parent استفاده کن
  merged.__jarSource = child.mainClass ? child.id : parent.id;
  merged.mainClass = child.mainClass || parent.mainClass;
  merged.assetIndex = child.assetIndex || parent.assetIndex;
  merged.assets = child.assets || parent.assets;
  return merged;
}

function libraryPathFromName(name) {
  // group:artifact:version[:classifier]
  const parts = name.split(':');
  const [group, artifact, version] = parts;
  const classifier = parts[3];
  const groupPath = group.replace(/\./g, '/');
  const fileName = classifier
    ? `${artifact}-${version}-${classifier}.jar`
    : `${artifact}-${version}.jar`;
  return path.join(groupPath, artifact, version, fileName);
}

function collectClasspathAndNatives(mcDir, versionJson, nativesDir) {
  const classpath = [];
  const nativesToExtract = [];

  for (const lib of versionJson.libraries || []) {
    if (lib.rules && !evaluateRules(lib.rules)) continue;

    let added = false;

    if (lib.downloads) {
      if (lib.downloads.artifact && lib.downloads.artifact.path) {
        const libFile = path.join(mcDir, 'libraries', lib.downloads.artifact.path);
        if (fs.existsSync(libFile)) {
          classpath.push(libFile);
          added = true;
        }
      }
      if (lib.natives) {
        const key = lib.natives[currentOsName()];
        if (key) {
          const classifierKey = key.replace('${arch}', os.arch() === 'x64' ? '64' : '32');
          const classifierInfo = lib.downloads.classifiers && lib.downloads.classifiers[classifierKey];
          if (classifierInfo && classifierInfo.path) {
            const nativeFile = path.join(mcDir, 'libraries', classifierInfo.path);
            if (fs.existsSync(nativeFile)) nativesToExtract.push(nativeFile);
          }
        }
      }
    } else if (lib.name) {
      const relPath = libraryPathFromName(lib.name);
      const libFile = path.join(mcDir, 'libraries', relPath);
      if (fs.existsSync(libFile)) {
        classpath.push(libFile);
        added = true;
      }
      if (lib.natives) {
        const key = lib.natives[currentOsName()];
        if (key) {
          const classifierKey = key.replace('${arch}', os.arch() === 'x64' ? '64' : '32');
          const nativeRel = libraryPathFromName(`${lib.name}:${classifierKey}`);
          const nativeFile = path.join(mcDir, 'libraries', nativeRel);
          if (fs.existsSync(nativeFile)) nativesToExtract.push(nativeFile);
        }
      }
    }
  }

  // استخراج نیتیوها داخل پوشه‌ی موقت نیتیو
  if (!fs.existsSync(nativesDir)) fs.mkdirSync(nativesDir, { recursive: true });
  for (const jarFile of nativesToExtract) {
    try {
      const zip = new AdmZip(jarFile);
      zip.getEntries().forEach((entry) => {
        if (!entry.isDirectory && !entry.entryName.startsWith('META-INF')) {
          zip.extractEntryTo(entry, nativesDir, false, true);
        }
      });
    } catch (e) {
      console.warn('خطا در استخراج نیتیو', jarFile, e.message);
    }
  }

  return classpath;
}

function offlineUUID(username) {
  // پیاده‌سازی معادل UUID.nameUUIDFromBytes("OfflinePlayer:" + username) در جاوا
  const hash = crypto.createHash('md5').update('OfflinePlayer:' + username).digest();
  hash[6] = (hash[6] & 0x0f) | 0x30; // version 3
  hash[8] = (hash[8] & 0x3f) | 0x80; // variant
  const hex = hash.toString('hex');
  return [
    hex.substring(0, 8),
    hex.substring(8, 12),
    hex.substring(12, 16),
    hex.substring(16, 20),
    hex.substring(20, 32)
  ].join('-');
}

function substitute(str, map) {
  return str.replace(/\$\{(.+?)\}/g, (m, key) => (key in map ? map[key] : m));
}

function buildArguments(versionJson, mcDir, gameDir, nativesDir, classpath, settings, account, quickPlayServer, boosterEnabled) {
  const features = quickPlayServer ? { has_quick_plays_support: true } : {};
  const map = {
    auth_player_name: account.username,
    version_name: versionJson.__ownId,
    game_directory: gameDir,
    assets_root: path.join(mcDir, 'assets'),
    assets_index_name: versionJson.assets || (versionJson.assetIndex && versionJson.assetIndex.id) || 'legacy',
    auth_uuid: account.uuid,
    auth_access_token: '0',
    user_type: 'legacy',
    version_type: versionJson.type || 'release',
    natives_directory: nativesDir,
    launcher_name: 'PH-Launcher',
    launcher_version: '1.1.0',
    classpath: classpath.join(path.delimiter),
    auth_session: '0',
    clientid: '0',
    auth_xuid: '0',
    user_properties: '{}',
    quickPlayMultiplayer: quickPlayServer || ''
  };

  const jvmArgs = [];
  const gameArgs = [];

  jvmArgs.push(`-Xms${settings.ramMin}M`);
  jvmArgs.push(`-Xmx${settings.ramMax}M`);
  jvmArgs.push(`-Djava.library.path=${nativesDir}`);

  if (boosterEnabled) {
    // نکته‌ی مهم: تنظیمات ریز G1GC معروف به «Aikar's Flags» اصلاً برای heapهای بزرگ سمت
    // سرور (۶ گیگ به بالا) طراحی شدن. اگه دقیقاً همین فلگ‌ها رو روی یه heap کوچیک (مثلاً
    // ۱ تا ۳ گیگ که خیلی از کاربرا برای بازی تک‌نفره ست می‌کنن) اعمال کنی، نتیجه‌ش برعکس
    // میشه: GC مکررتر و لگ بیشتر، دقیقاً همون چیزی که کاربر ازش شکایت داشت. برای همین این‌جا
    // بر اساس RAM واقعی که خود کاربر ست کرده، سطح تنظیمات رو انتخاب می‌کنیم.
    const heapMB = Number(settings.ramMax) || 2048;
    jvmArgs.push(
      '-XX:+UseG1GC', '-XX:+ParallelRefProcEnabled', '-XX:+DisableExplicitGC',
      '-XX:+PerfDisableSharedMem', '-XX:MaxTenuringThreshold=1'
    );
    if (heapMB >= 6144) {
      // فقط روی heapهای بزرگ ریزتنظیم‌های کامل Aikar's Flags اعمال می‌شن.
      jvmArgs.push(
        '-XX:MaxGCPauseMillis=200', '-XX:+UnlockExperimentalVMOptions',
        '-XX:G1NewSizePercent=30', '-XX:G1MaxNewSizePercent=40',
        '-XX:G1HeapRegionSize=8M', '-XX:G1ReservePercent=20',
        '-XX:G1HeapWastePercent=5', '-XX:G1MixedGCCountTarget=4',
        '-XX:InitiatingHeapOccupancyPercent=15', '-XX:G1MixedGCLiveThresholdPercent=90',
        '-XX:G1RSetUpdatingPauseTimePercent=5', '-XX:SurvivorRatio=32'
      );
    } else if (heapMB >= 3072) {
      // heap متوسط: region کوچیک‌تر و درصدهای معتدل‌تر، بدون ریزتنظیم‌های سنگین سرور.
      jvmArgs.push('-XX:MaxGCPauseMillis=120', '-XX:G1HeapRegionSize=4M', '-XX:G1ReservePercent=15');
    } else {
      // heap کوچیک: فقط یه هدف مکث ساده؛ هر ریزتنظیم بیشتری اینجا به ضرره.
      jvmArgs.push('-XX:MaxGCPauseMillis=100');
    }
  }

  if (versionJson.arguments) {
    for (const a of versionJson.arguments.jvm || []) {
      if (typeof a === 'string') jvmArgs.push(substitute(a, map));
      else if (a.rules && evaluateRules(a.rules, features)) {
        const vals = Array.isArray(a.value) ? a.value : [a.value];
        vals.forEach((v) => jvmArgs.push(substitute(v, map)));
      }
    }
    jvmArgs.push('-cp', classpath.join(path.delimiter));
    jvmArgs.push(versionJson.mainClass);

    for (const a of versionJson.arguments.game || []) {
      if (typeof a === 'string') gameArgs.push(substitute(a, map));
      else if (a.rules && evaluateRules(a.rules, features)) {
        const vals = Array.isArray(a.value) ? a.value : [a.value];
        vals.forEach((v) => gameArgs.push(substitute(v, map)));
      }
    }
  } else {
    // فرمت قدیمی (پیش از 1.13) — quickPlay در این نسخه‌ها پشتیبانی نمی‌شه
    jvmArgs.push('-cp', classpath.join(path.delimiter));
    jvmArgs.push(versionJson.mainClass);
    const legacyArgs = (versionJson.minecraftArguments || '').split(' ').filter(Boolean);
    legacyArgs.forEach((a) => gameArgs.push(substitute(a, map)));
  }

  // آرگومان‌های اختصاصی کاربر (تنظیمات پیشرفته) — قبل از mainClass برای JVM، انتهای لیست برای بازی
  const customJvm = parseArgString(settings.customJvmArgs);
  const customGame = parseArgString(settings.customGameArgs);
  if (customJvm.length) {
    const mainClassIdx = jvmArgs.indexOf(versionJson.mainClass);
    if (mainClassIdx >= 0) jvmArgs.splice(mainClassIdx, 0, ...customJvm);
    else jvmArgs.push(...customJvm);
  }
  gameArgs.push(...customGame);

  return [...jvmArgs, ...gameArgs];
}

// یه رشته‌ی آرگومان (که کاربر توی تنظیمات پیشرفته می‌نویسه) رو با احترام به فاصله‌های داخل
// گیومه تبدیل به آرایه می‌کنه، مثلاً: -Dfoo="bar baz" -Dqux=1  →  ['-Dfoo=bar baz', '-Dqux=1']
function parseArgString(str) {
  if (!str || !str.trim()) return [];
  const out = [];
  const re = /"([^"]*)"|(\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) out.push(m[1] !== undefined ? m[1] : m[2]);
  return out;
}

function findJavaPath(settings, mcDir) {
  if (settings.javaPath && fs.existsSync(settings.javaPath)) return settings.javaPath;
  // تلاش برای پیدا کردن جاوای داخلی که خود ماینکرافت نصب کرده
  const runtimeDir = path.join(mcDir, 'runtime');
  if (fs.existsSync(runtimeDir)) {
    const exeName = process.platform === 'win32' ? 'javaw.exe' : 'java';
    const stack = [runtimeDir];
    while (stack.length) {
      const dir = stack.pop();
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { continue; }
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name === exeName) return full;
      }
    }
  }
  return 'java'; // فرض بر اینه که در PATH سیستم موجوده
}

// اگه برای نسخه‌ی موردنظر یه جاوای سازگار به‌صورت خودکار دانلود شده باشه، همون رو در اولویت بذار
function pickJavaForLaunch(settings, mcDir, requiredMajor) {
  if (settings.javaPath && fs.existsSync(settings.javaPath)) return settings.javaPath;
  if (requiredMajor && settings.autoJavaMap && settings.autoJavaMap[requiredMajor]) {
    const autoPath = settings.autoJavaMap[requiredMajor];
    if (fs.existsSync(autoPath)) return autoPath;
  }
  return findJavaPath(settings, mcDir);
}

// ---------- پنجره‌ی اصلی ----------
let mainWindow;
let tray = null;
let isQuitting = false;
let activeProcess = null;
let launchStartTime = null;
let sessionCommittedSeconds = 0;
let sessionVersionId = null;
let xpTickTimer = null;

// ارسال امن به رندرر: اگه پنجره بسته/destroy شده باشه (مثلاً کاربر closeToTray رو خاموش کرده
// و پنجره رو بسته درحالی‌که بازی هنوز داره اجرا می‌شه)، این جلوی کرش کل برنامه رو می‌گیره.
function safeSend(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0d0d0d',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile('index.html');

  mainWindow.on('close', (e) => {
    if (!isQuitting && appData.settings.closeToTray) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => { mainWindow = null; });
}

function showOrCreateWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
  } else {
    createWindow();
  }
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray-icon.png'));
  tray = new Tray(icon);
  tray.setToolTip('PH Launcher');
  rebuildTrayMenu();
  tray.on('click', () => {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible()) mainWindow.hide();
    else showOrCreateWindow();
  });
}

function rebuildTrayMenu() {
  if (!tray) return;
  const items = [
    { label: 'View Launcher', click: () => { showOrCreateWindow(); } }
  ];

  // اجرای سریع از تری، بدون باز کردن پنجره — قابلیتی که با رسیدن به رنک «نگهبان» باز می‌شه
  if (isFeatureUnlocked('trayQuickLaunch') && appData.settings.lastVersion && !activeProcess) {
    items.push({ type: 'separator' });
    items.push({
      label: `Fast launch: ${appData.settings.lastVersion}`,
      click: async () => {
        const mcDir = appData.settings.mcDir;
        let account = appData.accounts.find((a) => a.id === appData.settings.activeAccountId);
        if (!account) { ensureDefaultAccount(); account = appData.accounts.find((a) => a.id === appData.settings.activeAccountId); }
        performLaunch({ mcDir, gameDir: mcDir, versionId: appData.settings.lastVersion, account });
      }
    });
  }

  items.push({ type: 'separator' });
  items.push({ label: 'Exit', click: () => { isQuitting = true; app.quit(); } });

  tray.setContextMenu(Menu.buildFromTemplate(items));
}

// ---------- کشف دنیاهای «Open to LAN» توی شبکه‌ی محلی ----------
// وقتی کسی توی بازی روی "Open to LAN" بزنه، خود ماینکرافت هر ۱.۵ ثانیه یه پیام multicast
// شامل [MOTD]...[/MOTD][AD]port[/AD] به آدرس استاندارد 224.0.2.60:4445 می‌فرسته.
const lanGames = new Map(); // key: "address:port" -> { motd, address, port, lastSeen }
let lanSocket = null;

function startLanDiscovery() {
  if (!appData.settings.lanDiscoveryEnabled) return;
  try {
    const dgram = require('dgram');
    lanSocket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    lanSocket.on('error', (err) => { console.warn('LAN discovery error:', err.message); });
    lanSocket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf-8');
      const match = text.match(/\[MOTD\](.*?)\[\/MOTD\]\[AD\](\d+)\[\/AD\]/);
      if (!match) return;
      const key = `${rinfo.address}:${match[2]}`;
      lanGames.set(key, { motd: match[1], address: rinfo.address, port: parseInt(match[2], 10), lastSeen: Date.now() });
    });
    lanSocket.on('listening', () => {
      try { lanSocket.addMembership('224.0.2.60'); } catch (e) { /* ممکنه شبکه اجازه نده، بی‌خیالش می‌شیم */ }
    });
    lanSocket.bind(4445);
  } catch (e) {
    console.warn('LAN discovery could not start:', e.message);
  }
}

// هر بازی‌ای که بیش از ۵ ثانیه پیامی نفرستاده باشه (یعنی احتمالاً بسته شده) از لیست حذف می‌شه
setInterval(() => {
  const now = Date.now();
  for (const [key, game] of lanGames) {
    if (now - game.lastSeen > 5000) lanGames.delete(key);
  }
}, 3000);

// ---------- پروتکل اختصاصی ph-launcher:// (اتصال از سایت/دیسکورد مستقیم به لانچر) ----------
// مثال: ph-launcher://connect?address=play.example.com:25565
//       ph-launcher://launch?version=1.20.1
if (!app.isDefaultProtocolClient('ph-launcher')) {
  app.setAsDefaultProtocolClient('ph-launcher');
}

function parseProtocolUrl(raw) {
  try {
    const u = new URL(raw);
    const action = u.hostname; // ph-launcher://connect?... -> hostname = "connect"
    const params = Object.fromEntries(u.searchParams);
    return { action, params };
  } catch (e) {
    return null;
  }
}

function handleProtocolUrl(raw) {
  const parsed = parseProtocolUrl(raw);
  if (!parsed) return;
  if (mainWindow && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  safeSend('protocol:action', parsed);
}

const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', (event, argv) => {
    const urlArg = argv.find((a) => a.startsWith('ph-launcher://'));
    if (urlArg) handleProtocolUrl(urlArg);
    else if (mainWindow && !mainWindow.isDestroyed()) { mainWindow.show(); mainWindow.focus(); }
  });
}
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleProtocolUrl(url);
});

app.whenReady().then(() => {
  setTimeout(() => { syncLeaderboard(false).catch(() => {}); }, 8000);
  createWindow();
  createTray();
  startLanDiscovery();
  initDiscordRpc();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });

  // اگه خود لانچر با یه لینک پروتکل باز شده باشه (مثلاً روی ویندوز/لینوکس)
  const startupUrlArg = process.argv.find((a) => a.startsWith('ph-launcher://'));
  if (startupUrlArg) setTimeout(() => handleProtocolUrl(startupUrlArg), 1000);

  // چک زمان‌بندی‌شده‌ی بکاپ خودکار (هر ۳۰ دقیقه بررسی می‌کنه که زمانش رسیده یا نه)
  setInterval(() => {
    const s = appData.settings;
    if (!s.autoBackupEnabled || !s.mcDir) return;
    const intervalMs = (s.autoBackupIntervalHours || 2) * 3600 * 1000;
    if (Date.now() - (s.lastAutoBackupAt || 0) >= intervalMs) {
      try {
        performBackup(path.join(s.mcDir, 'saves'), path.join(s.mcDir, 'ph-backups'));
        saveData(appData);
      } catch (e) { console.warn('scheduled backup failed', e.message); }
    }
  }, 30 * 60 * 1000);
});

app.on('before-quit', () => { isQuitting = true; });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});


// ===================== لیدربورد (اتصال به هاست PHP/MySQL مثل InfinityFree) =====================
// همه‌ی درخواست‌ها از پروسه‌ی اصلی (main) زده می‌شن تا مشکل CORS نداشته باشیم و بتونیم
// چالش ضدبات InfinityFree رو هم هندل کنیم.
//
// عمداً آدرس و کلید API این‌جا توی کد هاردکد شدن (نه توی تنظیمات لانچر)، چون قراره همه‌ی
// کسایی که این لانچر رو استفاده می‌کنن به یه لیدربورد مشترک وصل بشن، بدون اینکه لازم باشه
// خودشون آدرس/کلید رو ببینن یا دستکاری کنن. راهنمای کامل فعال‌سازی توی
// leaderboard-server/README-LEADERBOARD.md هست.
const LEADERBOARD_URL = 'https://phstudio.ir/leaderboard/api.php';
const LEADERBOARD_KEY = '8b5959db2ecf352505cf02c1524dcc9e793147dae09a5efb';

let lbCookie = '';
let lbSyncing = false;
let lbLastSync = 0;

function lbBaseUrl(rawUrl) {
  let u = String(rawUrl || '').trim();
  if (!/^https?:\/\//i.test(u)) return null;
  if (!/\.php(\?|$)/i.test(u)) u = u.replace(/\/+$/, '') + '/api.php';
  return u;
}

function lbRawRequest(urlStr, method, bodyStr) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(new Error('bad_url')); }
    const lib = u.protocol === 'http:' ? http : https;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (PH-Launcher/2.0) AppleWebKit/537.36 Chrome/120 Safari/537.36',
      'Accept': 'application/json, text/plain, */*'
    };
    if (lbCookie) headers['Cookie'] = lbCookie;
    if (bodyStr) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = Buffer.byteLength(bodyStr);
    }
    const req = lib.request({
      hostname: u.hostname, port: u.port || undefined, path: u.pathname + u.search, method, headers, timeout: 15000
    }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { data += c; if (data.length > 2e6) req.destroy(new Error('too_large')); });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text: data }));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

// InfinityFree برای درخواست‌های بدون کوکی یه صفحه‌ی چالش JavaScript (AES) برمی‌گردونه.
// این تابع همون چالش رو حل می‌کنه و کوکی __test رو می‌سازه.
function lbSolveChallenge(html) {
  const m = html.match(/toNumbers\("([0-9a-f]+)"\)\s*,\s*b\s*=\s*toNumbers\("([0-9a-f]+)"\)\s*,\s*c\s*=\s*toNumbers\("([0-9a-f]+)"\)/i);
  if (!m) return null;
  try {
    const key = Buffer.from(m[1], 'hex');
    const iv = Buffer.from(m[2], 'hex');
    const data = Buffer.from(m[3], 'hex');
    const d = crypto.createDecipheriv('aes-128-cbc', key, iv);
    d.setAutoPadding(false);
    const out = Buffer.concat([d.update(data), d.final()]);
    return '__test=' + out.toString('hex');
  } catch (e) {
    return null;
  }
}

function lbLooksLikeChallenge(text) {
  return /slowAES|toNumbers\(/.test(text || '');
}

// urlBase: آدرس api.php ؛ query: آبجکت پارامترهای GET ؛ body: آبجکت JSON (فقط برای POST)
async function lbCall(urlBase, key, action, query, body) {
  const base = lbBaseUrl(urlBase);
  if (!base) return { ok: false, error: 'bad_url' };
  const method = body ? 'POST' : 'GET';
  const q = new URLSearchParams(Object.assign({ action }, query || {}));
  if (!body) q.set('key', key);
  const payload = body ? JSON.stringify(Object.assign({ key }, body)) : null;
  const sep = base.includes('?') ? '&' : '?';

  let extra = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    let res;
    try {
      res = await lbRawRequest(base + sep + q.toString() + extra, method, payload);
    } catch (e) {
      return { ok: false, error: 'network', detail: e.message };
    }
    if (lbLooksLikeChallenge(res.text)) {
      const cookie = lbSolveChallenge(res.text);
      if (!cookie) return { ok: false, error: 'host_challenge' };
      lbCookie = cookie;
      extra = '&i=1';
      continue;
    }
    let json;
    try { json = JSON.parse(res.text); } catch (e) {
      return { ok: false, error: 'bad_response', status: res.status };
    }
    if (json && typeof json === 'object') return json;
    return { ok: false, error: 'bad_response', status: res.status };
  }
  return { ok: false, error: 'host_challenge' };
}

function lbSanitizeName(name) {
  return String(name || '').replace(/[^A-Za-z0-9_]/g, '').slice(0, 16);
}

function lbActiveUsername() {
  const acc = appData.accounts.find((a) => a.id === appData.settings.activeAccountId) || appData.accounts[0];
  return acc ? lbSanitizeName(acc.username) : '';
}

function lbEnsureToken() {
  if (!/^[a-f0-9]{64}$/.test(appData.settings.leaderboardToken || '')) {
    appData.settings.leaderboardToken = crypto.randomBytes(32).toString('hex');
    saveData(appData);
  }
  return appData.settings.leaderboardToken;
}

function lbConfigured() {
  return !!(lbBaseUrl(LEADERBOARD_URL) && LEADERBOARD_KEY);
}

async function syncLeaderboard(force) {
  if (!lbConfigured()) return { ok: false, error: 'not_configured' };
  if (lbSyncing) return { ok: true, throttled: true };
  if (!force && Date.now() - lbLastSync < 30000) return { ok: true, throttled: true };
  const username = lbActiveUsername();
  if (username.length < 3) return { ok: false, error: 'bad_username' };

  lbSyncing = true;
  try {
    const snap = getFullRankSnapshot();
    const times = appData.achievementTimes || {};
    const body = {
      token: lbEnsureToken(),
      username,
      playtime: Math.floor(appData.rank.totalPlaySeconds || 0),
      level: snap.level,
      xp: snap.xp,
      rank: snap.rankKey,
      launches: (appData.stats && appData.stats.launchCount) || 0,
      achievements: appData.achievementsUnlocked.map((id) => ({ id, at: times[id] || Date.now() }))
    };
    const res = await lbCall(LEADERBOARD_URL, LEADERBOARD_KEY, 'submit', {}, body);
    if (res && res.ok) lbLastSync = Date.now();
    return res;
  } finally {
    lbSyncing = false;
  }
}

ipcMain.handle('leaderboard:sync', async () => syncLeaderboard(true));

ipcMain.handle('leaderboard:fetch', async (e, sort) => {
  if (!lbConfigured()) return { ok: false, error: 'not_configured' };
  const safeSort = ['playtime', 'achievements', 'level'].includes(sort) ? sort : 'playtime';
  const syncRes = await syncLeaderboard(false).catch(() => null); // تلاش برای آپدیت آمار خودت؛ شکستش جلوی نمایش رو نمی‌گیره
  const res = await lbCall(LEADERBOARD_URL, LEADERBOARD_KEY, 'leaderboard', { sort: safeSort, limit: '50' }, null);
  if (res && res.ok) res.me = lbActiveUsername();
  if (res && res.ok && syncRes && !syncRes.ok) res.syncError = syncRes.error;
  return res;
});

ipcMain.handle('leaderboard:player', async (e, name) => {
  if (!lbConfigured()) return { ok: false, error: 'not_configured' };
  return lbCall(LEADERBOARD_URL, LEADERBOARD_KEY, 'player', { name: lbSanitizeName(name) }, null);
});

ipcMain.handle('leaderboard:achievements', async () => {
  if (!lbConfigured()) return { ok: false, error: 'not_configured' };
  return lbCall(LEADERBOARD_URL, LEADERBOARD_KEY, 'achievements', {}, null);
});

// ---------- IPC ----------
ipcMain.handle('settings:get', () => appData.settings);

ipcMain.handle('settings:save', (e, newSettings) => {
  appData.settings = Object.assign({}, appData.settings, newSettings);
  saveData(appData);
  return appData.settings;
});

ipcMain.handle('settings:browse-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('settings:auto-detect-mcdir', () => {
  const detected = autoDetectMcDir();
  return { ok: !!detected, path: detected };
});

ipcMain.handle('lan:list', () => Array.from(lanGames.values()));

ipcMain.handle('settings:browse-java', async () => {
  const filters = process.platform === 'win32' ? [{ name: 'Java', extensions: ['exe'] }] : undefined;
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openFile'], filters });
  if (result.canceled || !result.filePaths.length) return null;
  return result.filePaths[0];
});

ipcMain.handle('versions:scan', () => {
  const mcDir = appData.settings.mcDir;
  if (!mcDir || !fs.existsSync(mcDir)) return { ok: false, error: 'پوشه‌ی ماینکرافت معتبر نیست.' };
  const versionsDir = path.join(mcDir, 'versions');
  if (!fs.existsSync(versionsDir)) return { ok: false, error: 'پوشه‌ی versions پیدا نشد.' };

  const list = [];
  for (const name of fs.readdirSync(versionsDir)) {
    const dirPath = path.join(versionsDir, name);
    if (!fs.statSync(dirPath).isDirectory()) continue;
    const jsonPath = findVersionJsonPath(mcDir, name);
    if (!jsonPath) continue;
    try {
      const json = readJSON(jsonPath);
      list.push({
        id: name,
        type: json.type || 'unknown',
        isModded: !!json.inheritsFrom,
        favorite: appData.settings.favorites.includes(name)
      });
    } catch (e) {
      // فایل json خراب رو رد کن
    }
  }
  list.sort((a, b) => {
    if (a.favorite !== b.favorite) return a.favorite ? -1 : 1;
    return a.id.localeCompare(b.id);
  });
  return { ok: true, versions: list };
});

ipcMain.handle('versions:toggle-favorite', (e, id) => {
  const favs = appData.settings.favorites;
  const idx = favs.indexOf(id);
  if (idx >= 0) favs.splice(idx, 1); else favs.push(id);
  saveData(appData);
  return favs;
});

// ---------- سیستم Instance (هر نسخه پوشه‌ی دنیا/ماد/ریسورس‌پک جدا از بقیه داشته باشه) ----------
const INSTANCES_DIR = path.join(DATA_DIR, 'instances');

function instanceDir(instanceId) {
  return path.join(INSTANCES_DIR, instanceId);
}

ipcMain.handle('instances:list', () => appData.instances);

ipcMain.handle('instances:create', (e, name, versionId) => {
  const clean = (name || '').trim();
  if (!clean) return { ok: false, error: 'اسم نمونه (Instance) خالیه.' };
  if (!versionId) return { ok: false, error: 'نسخه‌ای انتخاب نشده.' };
  const id = 'inst-' + crypto.randomBytes(6).toString('hex');
  const dir = instanceDir(id);
  ['mods', 'resourcepacks', 'saves', 'screenshots'].forEach((sub) => fs.mkdirSync(path.join(dir, sub), { recursive: true }));
  const instance = { id, name: clean, versionId, createdAt: Date.now() };
  appData.instances.push(instance);
  appData.stats = appData.stats || { launchCount: 0, versionsPlayed: [], modsInstalledCount: 0, instancesCreated: 0, serversPinged: 0 };
  appData.stats.instancesCreated = (appData.stats.instancesCreated || 0) + 1;
  saveData(appData);
  checkAchievements();
  return { ok: true, instance };
});

ipcMain.handle('instances:delete', (e, id) => {
  appData.instances = appData.instances.filter((i) => i.id !== id);
  const dir = instanceDir(id);
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  saveData(appData);
  return { ok: true };
});

ipcMain.handle('instances:open-folder', (e, id, which) => {
  const dir = instanceDir(id);
  const target = path.join(dir, which || '');
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  shell.openPath(target);
  return { ok: true };
});

ipcMain.handle('instances:launch', async (e, id, serverAddress) => {
  try {
    const instance = appData.instances.find((i) => i.id === id);
    if (!instance) return { ok: false, error: 'نمونه (Instance) پیدا نشد.' };
    const mcDir = appData.settings.mcDir;
    let account = appData.accounts.find((a) => a.id === appData.settings.activeAccountId);
    if (!account) {
      ensureDefaultAccount();
      account = appData.accounts.find((a) => a.id === appData.settings.activeAccountId);
    }
    return performLaunch({
      mcDir,
      gameDir: instanceDir(id),
      versionId: instance.versionId,
      account,
      serverAddress,
      instanceId: id
    });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('rank:get', () => getFullRankSnapshot());

ipcMain.handle('recently-played:list', () => appData.recentlyPlayed || []);

ipcMain.handle('achievements:list', () => {
  return ACHIEVEMENTS.map((a) => ({ id: a.id, icon: a.icon, unlocked: appData.achievementsUnlocked.includes(a.id) }));
});

// ---------- تحلیلگر کرش ----------
function analyzeCrash(gameDir, sinceTimestamp) {
  try {
    const crashDir = path.join(gameDir, 'crash-reports');
    if (!fs.existsSync(crashDir)) return null;
    const files = fs.readdirSync(crashDir)
      .filter((f) => f.endsWith('.txt'))
      .map((f) => ({ f, mtime: fs.statSync(path.join(crashDir, f)).mtimeMs }))
      .filter((x) => x.mtime >= (sinceTimestamp || 0))
      .sort((a, b) => b.mtime - a.mtime);
    if (files.length === 0) return null;
    const reportPath = path.join(crashDir, files[0].f);
    const content = fs.readFileSync(reportPath, 'utf-8');

    const rules = [
      { test: /OutOfMemoryError/i, key: 'oom' },
      { test: /Mixin apply (failed|error)|MixinApplyError/i, key: 'mixin' },
      { test: /UnsupportedClassVersionError/i, key: 'javaVersion' },
      { test: /ClassNotFoundException|NoClassDefFoundError/i, key: 'missingClass' },
      { test: /LWJGL|GLFW|OpenGL/i, key: 'graphics' },
      { test: /DuplicateModsFoundException|duplicate mod/i, key: 'duplicateMod' }
    ];
    let matchedKey = 'generic';
    for (const r of rules) {
      if (r.test.test(content)) { matchedKey = r.key; break; }
    }
    return { key: matchedKey, reportPath };
  } catch (e) {
    return null;
  }
}

// ===================== تقویت‌کننده‌ی بازی: پاک‌سازی کش/فایل‌های اضافی =====================
// این تابع فقط فایل‌های واقعاً غیرضروری (لاگ‌های چرخیده‌ی قدیمی، کرش‌ریپورت‌های قدیمی، کش خود
// لانچر) رو پاک می‌کنه. هیچ‌وقت دست به سیو، ماد، ریسورس‌پک یا فایل‌های ورژن نمی‌زنه.
function runBoosterCleanup(gameDir) {
  try {
    // کش داخلی خود لانچر (الکترون) — چیزی که به خود بازی ربطی نداره ولی روی دیسک/رم جمع می‌شه.
    if (session && session.defaultSession) session.defaultSession.clearCache().catch(() => {});
  } catch (e) { /* بی‌خیال، این فقط یه بهینه‌سازی جانبیه */ }

  try {
    const logsDir = path.join(gameDir, 'logs');
    if (fs.existsSync(logsDir)) {
      for (const f of fs.readdirSync(logsDir)) {
        // فقط لاگ‌های چرخیده و فشرده‌ی قدیمی (مثل 2024-01-01-1.log.gz) — نه لاگ فعلی (latest.log)
        if (f.endsWith('.log.gz')) {
          try { fs.unlinkSync(path.join(logsDir, f)); } catch (e) { /* رد شو */ }
        }
      }
    }
  } catch (e) { /* رد شو */ }

  try {
    const crashDir = path.join(gameDir, 'crash-reports');
    if (fs.existsSync(crashDir)) {
      const files = fs.readdirSync(crashDir)
        .filter((f) => f.endsWith('.txt'))
        .map((f) => ({ f, t: fs.statSync(path.join(crashDir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
      // فقط ۵ تا کرش‌ریپورت آخر رو نگه می‌داریم، بقیه صرفاً حجم اضافه‌ن.
      files.slice(5).forEach(({ f }) => {
        try { fs.unlinkSync(path.join(crashDir, f)); } catch (e) { /* رد شو */ }
      });
    }
  } catch (e) { /* رد شو */ }
}

function performLaunch({ mcDir, gameDir, versionId, account, serverAddress, instanceId }) {
  if (activeProcess) return { ok: false, error: 'یک نسخه در حال اجراست. اول آن را ببندید.' };
  if (!mcDir || !fs.existsSync(mcDir)) return { ok: false, error: 'پوشه‌ی ماینکرافت تنظیم نشده است.' };
  const settings = appData.settings;

  // ثبت توی «اخیراً بازی‌شده» (حداکثر ۵ مورد، جدیدترین اول)
  appData.recentlyPlayed = (appData.recentlyPlayed || []).filter((r) =>
    instanceId ? r.instanceId !== instanceId : (r.versionId !== versionId || r.instanceId)
  );
  appData.recentlyPlayed.unshift({
    versionId,
    instanceId: instanceId || null,
    name: instanceId ? ((appData.instances.find((i) => i.id === instanceId) || {}).name || versionId) : versionId,
    timestamp: Date.now()
  });
  appData.recentlyPlayed = appData.recentlyPlayed.slice(0, 5);
  saveData(appData);

  const versionJson = resolveVersionJson(mcDir, versionId);
  const nativesDir = path.join(mcDir, 'versions', versionId, 'ph-natives');
  const classpath = collectClasspathAndNatives(mcDir, versionJson, nativesDir);

  if (account.activeSkinId) {
    try { applySkinResourcePack(mcDir, account); } catch (err) { console.warn('skin resource pack error', err.message); }
  }

  const jarSourceId = versionJson.__jarSource || versionId;
  const clientJar = findVersionJarPath(mcDir, versionId, jarSourceId);
  if (!clientJar) return { ok: false, error: `فایل jar این نسخه پیدا نشد. مطمئن شو یک فایل .jar داخل پوشه‌ی versions/${versionId} هست.` };
  classpath.push(clientJar);

  fs.mkdirSync(gameDir, { recursive: true });

  if (settings.autoBackupBeforeLaunch) {
    try { performBackup(path.join(gameDir, 'saves'), path.join(gameDir, 'ph-backups')); } catch (e) { console.warn('pre-launch backup failed', e.message); }
  }

  const requiredJavaMajor = versionJson.javaVersion && versionJson.javaVersion.majorVersion;
  const javaPath = pickJavaForLaunch(settings, mcDir, requiredJavaMajor);
  const boosterEnabled = !!(settings.gameBoosterEnabled && isFeatureUnlocked('gameBooster'));
  const args = buildArguments(versionJson, mcDir, gameDir, nativesDir, classpath, settings, account, serverAddress, boosterEnabled);

  if (boosterEnabled) runBoosterCleanup(gameDir);

  const child = spawn(javaPath, args, { cwd: gameDir });
  let launcherPriorityLowered = false;
  if (boosterEnabled) {
    // اولویت پردازش بازی رو کمی بالا می‌بریم تا سیستم‌عامل زمان CPU بیشتری بهش بده. یه تأخیر
    // کوچیک می‌ذاریم چون بلافاصله بعد از spawn روی بعضی سیستم‌عامل‌ها پردازش هنوز کامل توسط
    // زمان‌بند OS شناخته نشده و setPriority ممکنه بی‌اثر یا خطا بده.
    setTimeout(() => {
      try {
        os.setPriority(child.pid, os.constants.priority.PRIORITY_ABOVE_NORMAL);
      } catch (e) {
        console.warn('game booster: process priority elevation failed', e.message);
      }
    }, 150);

    // تمرکز واقعی سیستم روی بازی یعنی خود لانچر هم باید عقب بکشه: اولویت پردازش خود لانچر رو
    // موقتاً پایین می‌آریم تا CPU بیشتری برای جاوا/بازی آزاد بشه، و با بسته‌شدن بازی برش می‌گردونیم.
    try {
      os.setPriority(process.pid, os.constants.priority.PRIORITY_BELOW_NORMAL);
      launcherPriorityLowered = true;
    } catch (e) {
      console.warn('game booster: launcher priority reduction failed', e.message);
    }
  }
  activeProcess = child;
  launchStartTime = Date.now();
  sessionCommittedSeconds = 0;
  sessionVersionId = versionId;
  settings.lastVersion = versionId;

  appData.stats = appData.stats || { launchCount: 0, versionsPlayed: [], modsInstalledCount: 0, instancesCreated: 0, serversPinged: 0 };
  appData.stats.launchCount = (appData.stats.launchCount || 0) + 1;
  if (!appData.stats.versionsPlayed.includes(versionId)) appData.stats.versionsPlayed.push(versionId);
  saveData(appData);
  checkAchievements();

  safeSend('game:status', { running: true, versionId, instanceId: instanceId || null });
  setDiscordActivity(`در حال بازی: ${versionId}`, account.username);
  // تقویت‌کننده صرف‌نظر از تنظیم «مینیمایز موقع اجرا»، پنجره رو مخفی می‌کنه تا رندر پنجره‌ی
  // لانچر (که خودش هم CPU/GPU مصرف می‌کنه) سربار اضافه‌ای روی بازی نذاره.
  if ((settings.minimizeOnLaunch || boosterEnabled) && mainWindow) mainWindow.hide();
  rebuildTrayMenu();

  xpTickTimer = setInterval(() => {
    const totalElapsed = Math.max(0, Math.floor((Date.now() - launchStartTime) / 1000));
    const delta = totalElapsed - sessionCommittedSeconds;
    if (delta > 0) {
      const xpGained = addPlaySeconds(delta, sessionVersionId);
      sessionCommittedSeconds = totalElapsed;
      safeSend('rank:updated', getFullRankSnapshot());
      if (xpGained > 0) safeSend('game:log', `[XP] +${xpGained} XP`);
      checkAchievements();
      rebuildTrayMenu();
    }
  }, 60000);

  child.stdout.on('data', (d) => safeSend('game:log', d.toString()));
  child.stderr.on('data', (d) => safeSend('game:log', d.toString()));
  child.on('error', (err) => {
    if (launcherPriorityLowered) {
      try { os.setPriority(process.pid, os.constants.priority.PRIORITY_NORMAL); } catch (e) { /* رد شو */ }
    }
    safeSend('game:log', 'خطا در اجرای جاوا: ' + err.message);
  });

  child.on('close', (code) => {
    if (xpTickTimer) { clearInterval(xpTickTimer); xpTickTimer = null; }
    if (launcherPriorityLowered) {
      // با بسته‌شدن بازی، اولویت خود لانچر رو به حالت عادی برمی‌گردونیم.
      try { os.setPriority(process.pid, os.constants.priority.PRIORITY_NORMAL); } catch (e) { /* رد شو */ }
    }
    const totalElapsed = Math.max(0, Math.floor((Date.now() - launchStartTime) / 1000));
    const delta = totalElapsed - sessionCommittedSeconds;
    const xpGained = delta > 0 ? addPlaySeconds(delta, sessionVersionId) : 0;
    const launchStartedAt = launchStartTime;
    activeProcess = null;
    launchStartTime = null;
    rebuildTrayMenu();
    clearDiscordActivity();
    if (mainWindow) {
      safeSend('game:status', { running: false, versionId, exitCode: code, elapsedSec: totalElapsed, xpGained });
      safeSend('rank:updated', getFullRankSnapshot());
      if (mainWindow.isVisible() === false) mainWindow.show();
      if (Notification.isSupported()) {
        new Notification({ title: 'PH لانچر', body: `بازی (${versionId}) بسته شد.` }).show();
      }
      if (code !== 0) {
        const analysis = analyzeCrash(gameDir, launchStartedAt);
        if (analysis) safeSend('game:crash-analysis', analysis);
      }
    }
    checkAchievements();
    syncLeaderboard(true).catch(() => {});
  });

  return { ok: true };
}

ipcMain.handle('versions:launch', async (e, versionId, serverAddress) => {
  const settings = appData.settings;
  const mcDir = settings.mcDir;
  try {
    let account = appData.accounts.find((a) => a.id === settings.activeAccountId);
    if (!account) {
      ensureDefaultAccount();
      account = appData.accounts.find((a) => a.id === appData.settings.activeAccountId);
    }
    return performLaunch({ mcDir, gameDir: mcDir, versionId, account, serverAddress });
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('gallery:list', () => {
  const mcDir = appData.settings.mcDir;
  const dir = path.join(mcDir, 'screenshots');
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.(png|jpg|jpeg)$/i.test(f))
    .map((f) => path.join(dir, f));
});

ipcMain.handle('gallery:delete', (e, filePath) => {
  try {
    const mcDir = appData.settings.mcDir;
    const screenshotsDir = path.join(mcDir, 'screenshots');
    // فقط اجازه‌ی حذف فایل‌هایی که واقعاً داخل پوشه‌ی screenshots خودمون هستن
    if (path.dirname(filePath) !== screenshotsDir) return { ok: false, error: 'مسیر نامعتبر.' };
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function performBackup(savesDir, backupsDir) {
  if (!fs.existsSync(savesDir)) return { ok: false, error: 'پوشه‌ی saves پیدا نشد.' };
  if (!fs.existsSync(backupsDir)) fs.mkdirSync(backupsDir, { recursive: true });
  const zip = new AdmZip();
  zip.addLocalFolder(savesDir);
  const fileName = `backup-${new Date().toISOString().replace(/[:.]/g, '-')}.zip`;
  const outPath = path.join(backupsDir, fileName);
  zip.writeZip(outPath);
  appData.settings.lastAutoBackupAt = Date.now();
  return { ok: true, path: outPath };
}

ipcMain.handle('backup:create', () => {
  const mcDir = appData.settings.mcDir;
  return performBackup(path.join(mcDir, 'saves'), path.join(mcDir, 'ph-backups'));
});

// ---------- مدیریت دنیاها ----------
function savesDirFor(instanceId) {
  if (instanceId) return path.join(instanceDir(instanceId), 'saves');
  return path.join(appData.settings.mcDir, 'saves');
}

function dirSizeBytes(dirPath) {
  let total = 0;
  const stack = [dirPath];
  while (stack.length) {
    const cur = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(cur, { withFileTypes: true }); } catch (e) { continue; }
    for (const entry of entries) {
      const full = path.join(cur, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else { try { total += fs.statSync(full).size; } catch (e) { /* ignore */ } }
    }
  }
  return total;
}

// ---------- خوندن Seed دنیا (پارس کردن فرمت NBT از level.dat) ----------
function readNBT(buffer) {
  let offset = 0;
  function readByte() { return buffer.readInt8(offset++); }
  function readUByte() { return buffer.readUInt8(offset++); }
  function readShort() { const v = buffer.readInt16BE(offset); offset += 2; return v; }
  function readInt() { const v = buffer.readInt32BE(offset); offset += 4; return v; }
  function readLong() { const v = buffer.readBigInt64BE(offset); offset += 8; return v; }
  function readFloat() { const v = buffer.readFloatBE(offset); offset += 4; return v; }
  function readDouble() { const v = buffer.readDoubleBE(offset); offset += 8; return v; }
  function readString() { const len = readShort(); const s = buffer.toString('utf8', offset, offset + len); offset += len; return s; }
  function readPayload(type) {
    switch (type) {
      case 1: return readByte();
      case 2: return readShort();
      case 3: return readInt();
      case 4: return readLong();
      case 5: return readFloat();
      case 6: return readDouble();
      case 7: { const len = readInt(); const arr = buffer.slice(offset, offset + len); offset += len; return arr; }
      case 8: return readString();
      case 9: { const itemType = readUByte(); const len = readInt(); const arr = []; for (let i = 0; i < len; i++) arr.push(readPayload(itemType)); return arr; }
      case 10: { const obj = {}; while (true) { const t = readUByte(); if (t === 0) break; const name = readString(); obj[name] = readPayload(t); } return obj; }
      case 11: { const len = readInt(); const arr = []; for (let i = 0; i < len; i++) arr.push(readInt()); return arr; }
      case 12: { const len = readInt(); const arr = []; for (let i = 0; i < len; i++) arr.push(readLong()); return arr; }
      default: throw new Error('نوع تگ ناشناخته‌ی NBT: ' + type);
    }
  }
  const rootType = readUByte();
  if (rootType !== 10) throw new Error('ریشه‌ی فایل NBT از نوع compound نیست.');
  const rootName = readString();
  return { name: rootName, value: readPayload(10) };
}

ipcMain.handle('worlds:get-seed', (e, instanceId, worldName) => {
  try {
    const savesDir = savesDirFor(instanceId);
    const levelDatPath = path.join(savesDir, worldName, 'level.dat');
    if (!fs.existsSync(levelDatPath)) return { ok: false, error: 'فایل level.dat پیدا نشد.' };
    const raw = zlib.gunzipSync(fs.readFileSync(levelDatPath));
    const nbt = readNBT(raw);
    const data = nbt.value.Data || {};
    let seed = null;
    if (data.WorldGenSettings && data.WorldGenSettings.Seed !== undefined) seed = data.WorldGenSettings.Seed;
    else if (data.RandomSeed !== undefined) seed = data.RandomSeed;
    if (seed === null) return { ok: false, error: 'Seed توی این دنیا پیدا نشد.' };
    return { ok: true, seed: seed.toString() };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('worlds:list', (e, instanceId) => {
  const savesDir = savesDirFor(instanceId);
  if (!fs.existsSync(savesDir)) return [];
  return fs.readdirSync(savesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => {
      const worldPath = path.join(savesDir, d.name);
      const levelDat = path.join(worldPath, 'level.dat');
      const iconPath = path.join(worldPath, 'icon.png');
      let lastPlayed = 0;
      try { lastPlayed = fs.statSync(fs.existsSync(levelDat) ? levelDat : worldPath).mtimeMs; } catch (e) { /* ignore */ }
      let iconDataUrl = null;
      if (fs.existsSync(iconPath)) {
        try { iconDataUrl = 'data:image/png;base64,' + fs.readFileSync(iconPath).toString('base64'); } catch (e) { /* ignore */ }
      }
      return { name: d.name, lastPlayed, sizeBytes: dirSizeBytes(worldPath), iconDataUrl };
    })
    .sort((a, b) => b.lastPlayed - a.lastPlayed);
});

ipcMain.handle('worlds:rename', (e, instanceId, oldName, newName) => {
  try {
    const savesDir = savesDirFor(instanceId);
    const oldPath = path.join(savesDir, oldName);
    const newPath = path.join(savesDir, newName);
    if (!fs.existsSync(oldPath)) return { ok: false, error: 'دنیا پیدا نشد.' };
    if (fs.existsSync(newPath)) return { ok: false, error: 'دنیایی با این اسم از قبل هست.' };
    fs.renameSync(oldPath, newPath);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('worlds:duplicate', (e, instanceId, name) => {
  const savesDir = savesDirFor(instanceId);
  const srcPath = path.join(savesDir, name);
  if (!fs.existsSync(srcPath)) return { ok: false, error: 'دنیا پیدا نشد.' };
  let copyName = name + ' (کپی)';
  let n = 2;
  while (fs.existsSync(path.join(savesDir, copyName))) { copyName = `${name} (کپی ${n})`; n++; }
  fs.cpSync(srcPath, path.join(savesDir, copyName), { recursive: true });
  return { ok: true, name: copyName };
});

ipcMain.handle('worlds:delete', (e, instanceId, name) => {
  const savesDir = savesDirFor(instanceId);
  const worldPath = path.join(savesDir, name);
  if (fs.existsSync(worldPath)) fs.rmSync(worldPath, { recursive: true, force: true });
  return { ok: true };
});

ipcMain.handle('worlds:open-folder', (e, instanceId, name) => {
  const savesDir = savesDirFor(instanceId);
  const target = name ? path.join(savesDir, name) : savesDir;
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  shell.openPath(target);
  return { ok: true };
});

// ---------- دانلود نسخه از سرور رسمی موژنگ (بدون نیاز به اکانت پرمیوم) ----------
ipcMain.handle('download:manifest', async () => {
  try {
    if (!cachedManifest) cachedManifest = await httpGetJSON(MANIFEST_URL);
    return { ok: true, versions: cachedManifest.versions, latest: cachedManifest.latest };
  } catch (e) {
    return { ok: false, error: 'اتصال به سرور موژنگ ممکن نشد: ' + e.message };
  }
});

ipcMain.handle('download:start', async (e, versionId) => {
  const mcDir = appData.settings.mcDir;
  if (!mcDir) return { ok: false, error: 'اول مسیر ماینکرافت رو توی تنظیمات مشخص کن.' };
  try {
    if (!cachedManifest) cachedManifest = await httpGetJSON(MANIFEST_URL);
    const entry = cachedManifest.versions.find((v) => v.id === versionId);
    if (!entry) return { ok: false, error: 'این نسخه در لیست رسمی پیدا نشد.' };

    const send = (stage, current, total) =>
      safeSend('download:progress', { versionId, stage, current, total });

    send('دریافت اطلاعات نسخه', 0, 1);
    const versionJson = await httpGetJSON(entry.url);

    const versionDir = path.join(mcDir, 'versions', versionId);
    fs.mkdirSync(versionDir, { recursive: true });
    fs.writeFileSync(path.join(versionDir, `${versionId}.json`), JSON.stringify(versionJson, null, 2));

    // جار اصلی بازی — اگه همین یکی شکست بخوره، اصلاً نسخه قابل‌اجرا نمی‌شه، پس خطاش رو مستقیم بالا می‌بریم
    if (versionJson.downloads && versionJson.downloads.client) {
      send('دانلود فایل اصلی بازی', 0, 1);
      await downloadFile(
        versionJson.downloads.client.url,
        path.join(versionDir, `${versionId}.jar`),
        versionJson.downloads.client.size,
        versionJson.downloads.client.sha1
      );
    }

    // کتابخانه‌ها
    const turbo = isFeatureUnlocked('turboDownload');
    const libs = (versionJson.libraries || []).filter((l) => !l.rules || evaluateRules(l.rules));
    send('دانلود کتابخانه‌ها', 0, libs.length);
    const libFailures = await downloadWithConcurrency(libs, async (lib) => {
      if (lib.downloads && lib.downloads.artifact && lib.downloads.artifact.path) {
        await downloadFile(
          lib.downloads.artifact.url,
          path.join(mcDir, 'libraries', lib.downloads.artifact.path),
          lib.downloads.artifact.size,
          lib.downloads.artifact.sha1
        );
      }
      if (lib.downloads && lib.natives) {
        const key = lib.natives[currentOsName()];
        const classifier = key && lib.downloads.classifiers && lib.downloads.classifiers[key];
        if (classifier) {
          await downloadFile(classifier.url, path.join(mcDir, 'libraries', classifier.path), classifier.size, classifier.sha1);
        }
      }
    }, turbo ? 24 : 8, (done, total) => send('دانلود کتابخانه‌ها', done, total));
    // یه کتابخانه‌ی گمشده یعنی بازی بالا نمیاد یا کرش می‌کنه؛ نباید به کاربر «موفق» نشون بدیم.
    if (libFailures.length > 0) {
      return { ok: false, error: `دانلود ${libFailures.length} کتابخانه شکست خورد (مثلاً: ${libFailures[0].error}). اینترنتت رو چک کن و دوباره امتحان کن.` };
    }

    // اسم‌ست‌ها (تصاویر، صداها و...)
    if (versionJson.assetIndex) {
      send('دریافت لیست اسم‌ست‌ها', 0, 1);
      const assetIndex = await httpGetJSON(versionJson.assetIndex.url);
      const indexesDir = path.join(mcDir, 'assets', 'indexes');
      fs.mkdirSync(indexesDir, { recursive: true });
      fs.writeFileSync(path.join(indexesDir, `${versionJson.assetIndex.id}.json`), JSON.stringify(assetIndex));

      const objects = Object.values(assetIndex.objects || {});
      // نکته‌ی مهم: اسم‌ست‌های ماینکرافت content-addressed هستن، یعنی چندین مسیر مجازی مختلف
      // می‌تونن دقیقاً همون hash (همون فایل فیزیکی) رو داشته باشن (مثلاً صداهای تکراری یا فایل‌های
      // خالی). اگه بدون یکتاسازی این‌ها رو با تعداد زیاد هم‌زمان دانلود کنیم، ممکنه دو تا دانلود
      // هم‌زمان دقیقاً روی یه فایل مقصد کار کنن و باعث خطای rename بشن. پس اول یکتاشون می‌کنیم.
      const uniqueObjects = Array.from(new Map(objects.map((o) => [o.hash, o])).values());
      send('دانلود اسم‌ست‌ها', 0, uniqueObjects.length);
      const assetFailures = await downloadWithConcurrency(uniqueObjects, async (obj) => {
        const hash = obj.hash;
        const sub = hash.substring(0, 2);
        const dest = path.join(mcDir, 'assets', 'objects', sub, hash);
        const url = `https://resources.download.minecraft.net/${sub}/${hash}`;
        await downloadFile(url, dest, obj.size, hash);
      }, turbo ? 32 : 16, (done, total) => send('دانلود اسم‌ست‌ها', done, total));
      // چندتا آیکون/صدای گمشده بازی رو کاملاً غیرقابل‌اجرا نمی‌کنه؛ فقط اگه سهم زیادی از کل شکست
      // خورده باشه (مثلاً بیشتر از ۲٪) به‌عنوان شکست واقعی گزارشش می‌کنیم.
      if (assetFailures.length > 0 && assetFailures.length > uniqueObjects.length * 0.02) {
        return { ok: false, error: `دانلود ${assetFailures.length} از ${uniqueObjects.length} اسم‌ست شکست خورد (مثلاً: ${assetFailures[0].error}). اینترنتت رو چک کن و دوباره امتحان کن.` };
      }
    }

    send('پایان', 1, 1);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('java:detect', () => {
  const info = detectJavaVersion(appData.settings.javaPath);
  return info;
});

ipcMain.handle('natives:clear', () => {
  const mcDir = appData.settings.mcDir;
  const versionsDir = path.join(mcDir, 'versions');
  let cleared = 0;
  if (fs.existsSync(versionsDir)) {
    for (const name of fs.readdirSync(versionsDir)) {
      const nativesPath = path.join(versionsDir, name, 'ph-natives');
      if (fs.existsSync(nativesPath)) {
        fs.rmSync(nativesPath, { recursive: true, force: true });
        cleared++;
      }
    }
  }
  return { ok: true, cleared };
});

// ---------- مدیریت مادها (Modrinth API - عمومی، بدون نیاز به اکانت) ----------
const MODRINTH_API = 'https://api.modrinth.com/v2';

function detectLoader(versionJson) {
  const id = (versionJson.id || '').toLowerCase();
  const inherits = (versionJson.inheritsFrom || '').toLowerCase();
  const mainClass = (versionJson.mainClass || '').toLowerCase();
  if (id.includes('fabric') || mainClass.includes('fabric')) return 'fabric';
  if (id.includes('quilt') || mainClass.includes('quilt')) return 'quilt';
  if (id.includes('forge') || mainClass.includes('forge')) return 'forge';
  if (id.includes('neoforge')) return 'neoforge';
  return null;
}

function modsFolderFor(mcDir, instanceId) {
  if (instanceId) return path.join(instanceDir(instanceId), 'mods');
  return path.join(mcDir, 'mods');
}

ipcMain.handle('mods:search', async (e, query, mcVersion, loader) => {
  try {
    const facets = [['project_type:mod']];
    if (mcVersion) facets.push([`versions:${mcVersion}`]);
    if (loader && loader !== 'any') facets.push([`categories:${loader}`]);
    const url = `${MODRINTH_API}/search?query=${encodeURIComponent(query || '')}&facets=${encodeURIComponent(JSON.stringify(facets))}&limit=20`;
    const data = await httpGetJSON(url);
    return {
      ok: true,
      loader,
      results: (data.hits || []).map((h) => ({
        id: h.project_id, title: h.title, description: h.description,
        downloads: h.downloads, iconUrl: h.icon_url, author: h.author
      }))
    };
  } catch (err) {
    return { ok: false, error: 'اتصال به Modrinth ممکن نشد: ' + err.message };
  }
});

// دانلود یه پروژه‌ی خاص از Modrinth + وابستگی‌های required‌اش (به‌صورت بازگشتی، با جلوگیری
// از حلقه‌ی بی‌نهایت و دانلود تکراری با یه Set از پروژه‌های پردازش‌شده).
async function installModWithDependencies(projectId, mcVersion, loader, modsDir, seen, installedList, failures) {
  if (seen.has(projectId)) return;
  seen.add(projectId);

  let versionsUrl = `${MODRINTH_API}/project/${projectId}/version?game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`;
  if (loader && loader !== 'any') versionsUrl += `&loaders=${encodeURIComponent(JSON.stringify([loader]))}`;
  const versions = await httpGetJSON(versionsUrl);
  if (!versions || versions.length === 0) {
    throw new Error(`برای پروژه‌ی ${projectId}، فایل سازگاری با این نسخه/لودر پیدا نشد.`);
  }
  const chosen = versions[0];
  const file = chosen.files.find((f) => f.primary) || chosen.files[0];
  fs.mkdirSync(modsDir, { recursive: true });
  const dest = path.join(modsDir, file.filename);
  await downloadFile(file.url, dest, file.size, file.hashes && file.hashes.sha1);
  installedList.push({ projectId, fileName: file.filename });

  const requiredDeps = (chosen.dependencies || []).filter((d) => d.dependency_type === 'required' && d.project_id);
  for (const dep of requiredDeps) {
    try {
      await installModWithDependencies(dep.project_id, mcVersion, loader, modsDir, seen, installedList, failures);
    } catch (depErr) {
      // قبلاً این‌جا فقط توی کنسول لاگ می‌شد و کاربر هیچ‌وقت نمی‌فهمید یه وابستگی‌ی ضروری نصب
      // نشده — همون چیزی که باعث می‌شد ماد «دانلود بشه» ولی بازی باهاش بالا نیاد. حالا برمی‌گردونیمش.
      console.warn('dependency install failed:', dep.project_id, depErr.message);
      failures.push({ projectId: dep.project_id, error: depErr.message });
    }
  }
}

ipcMain.handle('mods:install', async (e, projectId, mcVersion, loader, instanceId) => {
  try {
    const mcDir = appData.settings.mcDir;
    const modsDir = modsFolderFor(mcDir, instanceId);
    const installedList = [];
    const failures = [];
    await installModWithDependencies(projectId, mcVersion, loader, modsDir, new Set(), installedList, failures);

    appData.stats = appData.stats || { launchCount: 0, versionsPlayed: [], modsInstalledCount: 0, instancesCreated: 0, serversPinged: 0 };
    appData.stats.modsInstalledCount = (appData.stats.modsInstalledCount || 0) + installedList.length;
    saveData(appData);
    checkAchievements();

    return { ok: true, installed: installedList, depFailures: failures };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mods:list', (e, instanceId) => {
  const mcDir = appData.settings.mcDir;
  const modsDir = modsFolderFor(mcDir, instanceId);
  if (!fs.existsSync(modsDir)) return [];
  return fs.readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith('.jar'));
});

ipcMain.handle('mods:remove', (e, fileName, instanceId) => {
  const mcDir = appData.settings.mcDir;
  const modsDir = modsFolderFor(mcDir, instanceId);
  const p = path.join(modsDir, fileName);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return { ok: true };
});

// ---------- آپدیت‌کننده‌ی مادها ----------
ipcMain.handle('mods:check-updates', async (e, mcVersion, loader, instanceId) => {
  try {
    const mcDir = appData.settings.mcDir;
    const modsDir = modsFolderFor(mcDir, instanceId);
    if (!fs.existsSync(modsDir)) return { ok: true, updates: [] };
    const files = fs.readdirSync(modsDir).filter((f) => f.toLowerCase().endsWith('.jar'));
    if (files.length === 0) return { ok: true, updates: [] };

    const hashToFile = {};
    for (const f of files) {
      const buf = fs.readFileSync(path.join(modsDir, f));
      const hash = crypto.createHash('sha1').update(buf).digest('hex');
      hashToFile[hash] = f;
    }

    const lookup = await httpPostJSON(`${MODRINTH_API}/version_files`, { hashes: Object.keys(hashToFile), algorithm: 'sha1' });

    const updates = [];
    for (const [hash, versionObj] of Object.entries(lookup || {})) {
      const fileName = hashToFile[hash];
      if (!fileName || !versionObj) continue;
      let url = `${MODRINTH_API}/project/${versionObj.project_id}/version?game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`;
      if (loader && loader !== 'any') url += `&loaders=${encodeURIComponent(JSON.stringify([loader]))}`;
      try {
        const versions = await httpGetJSON(url);
        if (versions && versions.length > 0 && versions[0].id !== versionObj.id) {
          updates.push({
            fileName,
            projectId: versionObj.project_id,
            title: versionObj.name || fileName,
            currentVersionId: versionObj.id,
            latestVersionId: versions[0].id,
            latestVersionName: versions[0].name
          });
        }
      } catch (e3) { /* این ماد رو رد کن، بقیه رو چک کن */ }
    }
    return { ok: true, updates };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('mods:apply-update', async (e, fileName, projectId, latestVersionId, instanceId) => {
  try {
    const mcDir = appData.settings.mcDir;
    const modsDir = modsFolderFor(mcDir, instanceId);
    const versionInfo = await httpGetJSON(`${MODRINTH_API}/project/${projectId}/version/${latestVersionId}`);
    const file = versionInfo.files.find((f) => f.primary) || versionInfo.files[0];
    const oldPath = path.join(modsDir, fileName);
    if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    const dest = path.join(modsDir, file.filename);
    await downloadFile(file.url, dest, file.size, file.hashes && file.hashes.sha1);
    return { ok: true, fileName: file.filename };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// یه شورتکات: از روی یه نسخه‌ی نصب‌شده، نسخه‌ی بازی + لودرش رو حدس می‌زنه (برای دکمه‌ی
// «پر کردن از نسخه‌ی انتخاب‌شده» توی بخش مادها) — کاربر همچنان می‌تونه بعدش دستی عوضش کنه.
ipcMain.handle('mods:suggest-target', (e, versionId) => {
  try {
    const mcDir = appData.settings.mcDir;
    const vj = resolveVersionJson(mcDir, versionId);
    return { ok: true, mcVersion: vj.__ownId, loader: detectLoader(vj) || 'any' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- نصب با درگ‌اند‌دراپ ----------
// وقتی کاربر یه فایل رو مستقیم روی پنجره‌ی لانچر می‌کشه و رها می‌کنه.
ipcMain.handle('files:install-dropped', async (e, filePath, kind, instanceId) => {
  try {
    const mcDir = appData.settings.mcDir;
    if (!mcDir || !fs.existsSync(mcDir)) return { ok: false, error: 'اول مسیر ماینکرافت رو توی تنظیمات مشخص کن.' };
    if (!fs.existsSync(filePath)) return { ok: false, error: 'فایل پیدا نشد.' };

    if (kind === 'modpack') {
      return await performModpackImport(filePath);
    }

    const fileName = path.basename(filePath);
    let targetDir;
    if (kind === 'mod') targetDir = modsFolderFor(mcDir, instanceId);
    else if (kind === 'shader') targetDir = contentFolderFor(mcDir, instanceId, 'shader');
    else targetDir = contentFolderFor(mcDir, instanceId, 'resourcepack'); // پیش‌فرض: ریسورس‌پک

    fs.mkdirSync(targetDir, { recursive: true });
    fs.copyFileSync(filePath, path.join(targetDir, fileName));
    return { ok: true, fileName, kind };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- ریسورس‌پک و شیدر (همون Modrinth، برای project_type های دیگه) ----------
function contentFolderFor(mcDir, instanceId, projectType) {
  const sub = projectType === 'shader' ? 'shaderpacks' : 'resourcepacks';
  if (instanceId) return path.join(instanceDir(instanceId), sub);
  return path.join(mcDir, sub);
}

ipcMain.handle('content:search', async (e, query, versionId, projectType) => {
  try {
    const mcDir = appData.settings.mcDir;
    let mcVersion = null;
    if (versionId) {
      try { mcVersion = resolveVersionJson(mcDir, versionId).__ownId; } catch (e2) { /* ignore */ }
    }
    const facets = [[`project_type:${projectType}`]];
    if (mcVersion) facets.push([`versions:${mcVersion}`]);
    const url = `${MODRINTH_API}/search?query=${encodeURIComponent(query || '')}&facets=${encodeURIComponent(JSON.stringify(facets))}&limit=20`;
    const data = await httpGetJSON(url);
    return {
      ok: true,
      results: (data.hits || []).map((h) => ({
        id: h.project_id, title: h.title, description: h.description,
        downloads: h.downloads, iconUrl: h.icon_url, author: h.author
      }))
    };
  } catch (err) {
    return { ok: false, error: 'اتصال به Modrinth ممکن نشد: ' + err.message };
  }
});

ipcMain.handle('content:install', async (e, projectId, versionId, projectType, instanceId) => {
  try {
    const mcDir = appData.settings.mcDir;
    let mcVersion = versionId;
    if (versionId) {
      try { mcVersion = resolveVersionJson(mcDir, versionId).__ownId; } catch (e2) { /* ignore */ }
    }
    const versionsUrl = `${MODRINTH_API}/project/${projectId}/version?game_versions=${encodeURIComponent(JSON.stringify([mcVersion]))}`;
    const versions = await httpGetJSON(versionsUrl);
    if (!versions || versions.length === 0) {
      return { ok: false, error: 'برای این نسخه، فایل سازگاری پیدا نشد.' };
    }
    const file = versions[0].files.find((f) => f.primary) || versions[0].files[0];
    const targetDir = contentFolderFor(mcDir, instanceId, projectType);
    fs.mkdirSync(targetDir, { recursive: true });
    const dest = path.join(targetDir, file.filename);
    await downloadFile(file.url, dest, file.size, file.hashes && file.hashes.sha1);
    return { ok: true, fileName: file.filename };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('content:list', (e, projectType, instanceId) => {
  const mcDir = appData.settings.mcDir;
  const dir = contentFolderFor(mcDir, instanceId, projectType);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.zip'));
});

ipcMain.handle('content:remove', (e, fileName, projectType, instanceId) => {
  const mcDir = appData.settings.mcDir;
  const dir = contentFolderFor(mcDir, instanceId, projectType);
  const p = path.join(dir, fileName);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  return { ok: true };
});

// ---------- وارد کردن Modpack (فرمت استاندارد .mrpack از Modrinth) ----------
async function performModpackImport(mrpackPath) {
  const mcDir = appData.settings.mcDir;
  if (!mcDir || !fs.existsSync(mcDir)) return { ok: false, error: 'اول مسیر ماینکرافت رو توی تنظیمات مشخص کن.' };

  try {
    const zip = new AdmZip(mrpackPath);
    const indexEntry = zip.getEntry('modrinth.index.json');
    if (!indexEntry) return { ok: false, error: 'فایل modrinth.index.json داخل mrpack پیدا نشد.' };
    const manifest = JSON.parse(zip.readAsText(indexEntry));

    const mcVersion = manifest.dependencies && manifest.dependencies.minecraft;
    const loaderKeys = { 'fabric-loader': 'fabric', 'forge': 'forge', 'quilt-loader': 'quilt', 'neoforge': 'neoforge' };
    let loaderName = null;
    for (const k of Object.keys(loaderKeys)) {
      if (manifest.dependencies && manifest.dependencies[k]) { loaderName = loaderKeys[k]; break; }
    }

    // دنبال یه نسخه‌ی نصب‌شده‌ی سازگار (وانیلا یا لودردار) با همین شماره نسخه بگرد
    const versionsDir = path.join(mcDir, 'versions');
    let matchedVersionId = null;
    if (fs.existsSync(versionsDir)) {
      for (const name of fs.readdirSync(versionsDir)) {
        if (!name.includes(mcVersion)) continue;
        if (loaderName && !name.toLowerCase().includes(loaderName)) continue;
        if (!loaderName && name !== mcVersion) continue;
        matchedVersionId = name;
        break;
      }
    }
    if (!matchedVersionId) {
      return {
        ok: false,
        error: loaderName
          ? `اول باید نسخه‌ی ${loaderName} برای ماینکرافت ${mcVersion} رو نصب کنی (این مادپک بهش نیاز داره)، بعد دوباره ایمپورت کن.`
          : `نسخه‌ی ماینکرافت ${mcVersion} نصب نشده. اول از تب دانلود نصبش کن.`
      };
    }

    const id = 'inst-' + crypto.randomBytes(6).toString('hex');
    const dir = instanceDir(id);
    ['mods', 'resourcepacks', 'shaderpacks', 'saves', 'screenshots'].forEach((sub) => fs.mkdirSync(path.join(dir, sub), { recursive: true }));

    const files = manifest.files || [];
    safeSend('modpack:import-progress', { stage: 'دانلود فایل‌های مادپک', current: 0, total: files.length });
    const fileFailures = await downloadWithConcurrency(files, async (f) => {
      if (f.env && f.env.client === 'unsupported') return;
      const dest = path.join(dir, f.path);
      const url = (f.downloads || [])[0];
      if (!url) return;
      await downloadFile(url, dest, f.fileSize, f.hashes && f.hashes.sha1);
    }, 8, (done, total) => safeSend('modpack:import-progress', { stage: 'دانلود فایل‌های مادپک', current: done, total }));
    // instance رو با وجود شکست‌های جزئی هم می‌سازیم (بخش زیادیش سالمه)، ولی صادقانه به کاربر می‌گیم
    // چندتا فایل کم افتاده — قبلاً این شکست‌ها کاملاً بی‌صدا گم می‌شدن.
    const modpackWarning = fileFailures.length > 0
      ? `${fileFailures.length} از ${files.length} فایل مادپک دانلود نشدن (مثلاً: ${fileFailures[0].error}). می‌تونی بعداً دوباره امتحان کنی.`
      : null;

    // کپی پوشه‌ی overrides مستقیم داخل پوشه‌ی instance
    const entries = zip.getEntries();
    for (const entry of entries) {
      if (entry.entryName.startsWith('overrides/') && !entry.isDirectory) {
        const rel = entry.entryName.slice('overrides/'.length);
        const dest = path.join(dir, rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.writeFileSync(dest, zip.readFile(entry));
      }
    }

    const instance = { id, name: manifest.name || 'Modpack', versionId: matchedVersionId, createdAt: Date.now() };
    appData.instances.push(instance);
    appData.stats.instancesCreated = (appData.stats.instancesCreated || 0) + 1;
    saveData(appData);
    checkAchievements();

    return { ok: true, instance, warning: modpackWarning };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

ipcMain.handle('modpack:import', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Modrinth Modpack', extensions: ['mrpack'] }]
  });
  if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
  return performModpackImport(result.filePaths[0]);
});

// ---------- پینگ زنده‌ی سرور (پروتکل Server List Ping خود ماینکرافت) ----------
function writeVarInt(value) {
  const bytes = [];
  do {
    let temp = value & 0b01111111;
    value >>>= 7;
    if (value !== 0) temp |= 0b10000000;
    bytes.push(temp);
  } while (value !== 0);
  return Buffer.from(bytes);
}

function writeString(str) {
  const strBuf = Buffer.from(str, 'utf-8');
  return Buffer.concat([writeVarInt(strBuf.length), strBuf]);
}

function pingMinecraftServer(host, port) {
  return new Promise((resolve, reject) => {
    const net = require('net');
    const socket = new net.Socket();
    const timeout = setTimeout(() => { socket.destroy(); reject(new Error('timeout')); }, 5000);
    let buffer = Buffer.alloc(0);
    const startTime = Date.now();

    socket.connect(port, host, () => {
      const handshake = Buffer.concat([
        writeVarInt(0x00), writeVarInt(760), writeString(host), Buffer.from([(port >> 8) & 0xff, port & 0xff]), writeVarInt(1)
      ]);
      const handshakePacket = Buffer.concat([writeVarInt(handshake.length), handshake]);
      const statusRequest = Buffer.concat([writeVarInt(1), writeVarInt(0x00)]);
      socket.write(Buffer.concat([handshakePacket, statusRequest]));
    });

    socket.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
      try {
        let offset = 0;
        const readVarInt = () => {
          let value = 0, shift = 0, byte;
          do {
            byte = buffer[offset++];
            value |= (byte & 0x7f) << shift;
            shift += 7;
          } while (byte & 0x80);
          return value;
        };
        const packetLength = readVarInt();
        if (buffer.length < offset + packetLength) return; // هنوز کامل نرسیده
        readVarInt(); // packet id
        const jsonLength = readVarInt();
        const jsonStr = buffer.slice(offset, offset + jsonLength).toString('utf-8');
        const parsed = JSON.parse(jsonStr);
        clearTimeout(timeout);
        socket.destroy();
        resolve({
          online: true,
          ping: Date.now() - startTime,
          motd: typeof parsed.description === 'string' ? parsed.description : (parsed.description && parsed.description.text) || '',
          players: parsed.players || { online: 0, max: 0 },
          version: parsed.version && parsed.version.name,
          favicon: parsed.favicon || null
        });
      } catch (e) { /* هنوز داده کامل نرسیده، صبر کن */ }
    });

    socket.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });
}

ipcMain.handle('servers:ping', async (e, address) => {
  try {
    let host = address, port = 25565;
    if (address.includes(':')) {
      const parts = address.split(':');
      host = parts[0];
      port = parseInt(parts[1], 10) || 25565;
    }
    const result = await pingMinecraftServer(host, port);
    appData.stats = appData.stats || { launchCount: 0, versionsPlayed: [], modsInstalledCount: 0, instancesCreated: 0, serversPinged: 0 };
    appData.stats.serversPinged = (appData.stats.serversPinged || 0) + 1;
    saveData(appData);
    checkAchievements();
    return { ok: true, ...result };
  } catch (err) {
    return { ok: false, online: false, error: err.message };
  }
});

// ---------- دانلود خودکار جاوای سازگار (Adoptium/Eclipse Temurin - رسمی و رایگان) ----------
function adoptiumOsName() {
  const p = process.platform;
  if (p === 'win32') return 'windows';
  if (p === 'darwin') return 'mac';
  return 'linux';
}
function adoptiumArch() {
  const a = os.arch();
  if (a === 'x64') return 'x64';
  if (a === 'arm64') return 'aarch64';
  return 'x64';
}

ipcMain.handle('java:required-version', (e, versionId) => {
  try {
    const mcDir = appData.settings.mcDir;
    const vj = resolveVersionJson(mcDir, versionId);
    return { ok: true, major: (vj.javaVersion && vj.javaVersion.majorVersion) || 8 };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('java:auto-install', async (e, majorVersion) => {
  try {
    const send = (stage, current, total) => safeSend('java:install-progress', { stage, current, total });
    send('دریافت اطلاعات نسخه‌ی جاوا', 0, 1);

    const osName = adoptiumOsName();
    const arch = adoptiumArch();
    const ext = osName === 'windows' ? 'zip' : 'tar.gz';
    const url = `https://api.adoptium.net/v3/binary/latest/${majorVersion}/ga/${osName}/${arch}/jre/hotspot/normal/eclipse?project=jdk`;

    const jreRoot = path.join(DATA_DIR, 'jre', String(majorVersion));
    fs.mkdirSync(jreRoot, { recursive: true });
    const archivePath = path.join(jreRoot, `jre.${ext}`);

    send('دانلود جاوا', 0, 1);
    await downloadFile(url, archivePath);

    send('استخراج فایل‌ها', 0, 1);
    if (ext === 'zip') {
      const zip = new AdmZip(archivePath);
      zip.extractAllTo(jreRoot, true);
    } else {
      const tar = require('tar');
      await tar.extract({ file: archivePath, cwd: jreRoot });
    }
    fs.unlinkSync(archivePath);

    // پیدا کردن اجرایی جاوا داخل پوشه‌ی استخراج‌شده
    const exeName = osName === 'windows' ? 'java.exe' : 'java';
    let javaExec = null;
    const stack = [jreRoot];
    while (stack.length) {
      const dir = stack.pop();
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) stack.push(full);
        else if (entry.name === exeName && full.includes(path.join('bin', ''))) { javaExec = full; break; }
      }
      if (javaExec) break;
    }
    if (!javaExec) return { ok: false, error: 'فایل اجرایی جاوا بعد از استخراج پیدا نشد.' };

    appData.settings.autoJavaMap = appData.settings.autoJavaMap || {};
    appData.settings.autoJavaMap[majorVersion] = javaExec;
    saveData(appData);

    send('پایان', 1, 1);
    return { ok: true, javaPath: javaExec, major: majorVersion };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- اکانت‌ها ----------
ipcMain.handle('accounts:list', () => ({
  accounts: appData.accounts.map(sanitizeAccount),
  activeAccountId: appData.settings.activeAccountId
}));

ipcMain.handle('accounts:add-offline', (e, username) => {
  const clean = (username || '').trim();
  if (!clean) return { ok: false, error: 'نام کاربری خالیه.' };
  const account = { id: 'off-' + crypto.randomBytes(6).toString('hex'), type: 'offline', username: clean, uuid: offlineUUID(clean), skins: [], activeSkinId: null };
  appData.accounts.push(account);
  if (!appData.settings.activeAccountId) appData.settings.activeAccountId = account.id;
  saveData(appData);
  return { ok: true, account: sanitizeAccount(account) };
});

ipcMain.handle('accounts:remove', (e, id) => {
  const account = appData.accounts.find((a) => a.id === id);
  if (account) removeAllSkinsForAccount(appData.settings.mcDir, account);
  appData.accounts = appData.accounts.filter((a) => a.id !== id);
  if (appData.settings.activeAccountId === id) {
    appData.settings.activeAccountId = appData.accounts.length ? appData.accounts[0].id : null;
  }
  saveData(appData);
  return { ok: true };
});

ipcMain.handle('accounts:set-active', (e, id) => {
  appData.settings.activeAccountId = id;
  saveData(appData);
  return { ok: true };
});

// ---------- سرورهای مورد علاقه (برای اتصال سریع به سرورهایی که پرمیوم نمی‌خوان) ----------
ipcMain.handle('servers:list', () => appData.settings.servers);

ipcMain.handle('servers:add', (e, { name, address }) => {
  if (!address) return { ok: false, error: 'آدرس سرور خالیه.' };
  appData.settings.servers.push({ id: crypto.randomBytes(6).toString('hex'), name: name || address, address });
  saveData(appData);
  return { ok: true, servers: appData.settings.servers };
});

ipcMain.handle('servers:remove', (e, id) => {
  appData.settings.servers = appData.settings.servers.filter((s) => s.id !== id);
  saveData(appData);
  return { ok: true, servers: appData.settings.servers };
});

ipcMain.handle('folder:open', (e, which) => {
  const mcDir = appData.settings.mcDir;
  const map = {
    mods: path.join(mcDir, 'mods'),
    resourcepacks: path.join(mcDir, 'resourcepacks'),
    saves: path.join(mcDir, 'saves'),
    screenshots: path.join(mcDir, 'screenshots'),
    backups: path.join(mcDir, 'ph-backups')
  };
  const target = map[which];
  if (!target) return { ok: false };
  if (!fs.existsSync(target)) fs.mkdirSync(target, { recursive: true });
  shell.openPath(target);
  return { ok: true };
});

// ---------- اسکین آفلاین ----------
// روش کار: چون بازی در حالت آفلاین اسکین رو از سرور موژنگ نمی‌گیره، لانچر یک ریسورس‌پک محلی
// می‌سازه که تکسچر پیش‌فرض استیو/الکس رو با عکس آپلودی جایگزین می‌کنه و به‌صورت خودکار در
// options.txt فعالش می‌کنه. این یعنی این اسکین برای همین کلاینت روی هر پلیری که تکسچر پیش‌فرض
// داره نمایش داده می‌شه (دقیقاً مثل خود بازی که به همه‌ی پلیرهای بدون اسکین یه ظاهر پیش‌فرض می‌ده).

const SKINS_DIR = path.join(DATA_DIR, 'skins');

function skinFilePath(accountId, skinId) {
  return path.join(SKINS_DIR, `${accountId}-${skinId}.png`);
}

function packDirFor(mcDir, accountId) {
  return path.join(mcDir, 'resourcepacks', `PH-CustomSkin-${accountId}`);
}

function readOptionsResourcePacks(mcDir) {
  const optPath = path.join(mcDir, 'options.txt');
  let lines = [];
  if (fs.existsSync(optPath)) lines = fs.readFileSync(optPath, 'utf-8').split('\n');
  let arr = ['vanilla'];
  const idx = lines.findIndex((l) => l.startsWith('resourcePacks:'));
  if (idx >= 0) {
    try { arr = JSON.parse(lines[idx].slice('resourcePacks:'.length)); } catch (e) { arr = ['vanilla']; }
  }
  return { optPath, lines, idx, arr: Array.isArray(arr) ? arr : ['vanilla'] };
}

function writeOptionsResourcePacks(mcDir, { optPath, lines, idx, arr }) {
  const newLine = 'resourcePacks:' + JSON.stringify(arr);
  if (idx >= 0) lines[idx] = newLine;
  else lines.push(newLine);
  fs.writeFileSync(optPath, lines.join('\n'));
}

function applySkinResourcePack(mcDir, account) {
  if (!mcDir || !fs.existsSync(mcDir)) return;
  const packDir = packDirFor(mcDir, account.id);

  if (!account.activeSkinId) {
    if (fs.existsSync(packDir)) fs.rmSync(packDir, { recursive: true, force: true });
    const opt = readOptionsResourcePacks(mcDir);
    opt.arr = opt.arr.filter((p) => p !== `file/PH-CustomSkin-${account.id}`);
    writeOptionsResourcePacks(mcDir, opt);
    return;
  }

  const skinPath = skinFilePath(account.id, account.activeSkinId);
  if (!fs.existsSync(skinPath)) return;
  const bytes = fs.readFileSync(skinPath);

  const targets = [
    'assets/minecraft/textures/entity/steve.png',
    'assets/minecraft/textures/entity/alex.png',
    'assets/minecraft/textures/entity/player/wide/steve.png',
    'assets/minecraft/textures/entity/player/slim/alex.png'
  ];
  for (const rel of targets) {
    const full = path.join(packDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, bytes);
  }
  fs.writeFileSync(path.join(packDir, 'pack.mcmeta'), JSON.stringify({
    pack: { pack_format: 15, description: 'PH Launcher - Custom Skin' }
  }, null, 2));

  const opt = readOptionsResourcePacks(mcDir);
  opt.arr = opt.arr.filter((p) => !p.startsWith(`file/PH-CustomSkin-${account.id}`));
  opt.arr.push(`file/PH-CustomSkin-${account.id}`);
  writeOptionsResourcePacks(mcDir, opt);
}

function removeAllSkinsForAccount(mcDir, account) {
  for (const s of account.skins || []) {
    const p = skinFilePath(account.id, s.id);
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }
  account.activeSkinId = null;
  if (mcDir) applySkinResourcePack(mcDir, account);
}

ipcMain.handle('accounts:upload-skin', async (e, accountId, name, model) => {
  try {
    const account = appData.accounts.find((a) => a.id === accountId);
    if (!account) return { ok: false, error: 'اکانت پیدا نشد.' };
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'Skin PNG', extensions: ['png'] }]
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };
    const filePath = result.filePaths[0];

    const img = nativeImage.createFromPath(filePath);
    const size = img.getSize();
    if (!((size.width === 64 && size.height === 64) || (size.width === 64 && size.height === 32))) {
      return { ok: false, error: `ابعاد عکس باید ۶۴×۶۴ یا ۶۴×۳۲ باشه (فایل انتخابی: ${size.width}×${size.height}).` };
    }

    if (!fs.existsSync(SKINS_DIR)) fs.mkdirSync(SKINS_DIR, { recursive: true });
    const skinId = crypto.randomBytes(5).toString('hex');
    fs.copyFileSync(filePath, skinFilePath(accountId, skinId));

    account.skins = account.skins || [];
    account.skins.push({ id: skinId, name: (name || 'Skin ' + (account.skins.length + 1)), model: model === 'slim' ? 'slim' : 'classic' });
    account.activeSkinId = skinId;
    upsertAccount(account);

    if (appData.settings.mcDir) applySkinResourcePack(appData.settings.mcDir, account);
    return { ok: true, account: sanitizeAccount(account) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('accounts:set-active-skin', (e, accountId, skinId) => {
  const account = appData.accounts.find((a) => a.id === accountId);
  if (!account) return { ok: false, error: 'اکانت پیدا نشد.' };
  account.activeSkinId = skinId || null;
  upsertAccount(account);
  if (appData.settings.mcDir) applySkinResourcePack(appData.settings.mcDir, account);
  return { ok: true, account: sanitizeAccount(account) };
});

ipcMain.handle('accounts:remove-skin', (e, accountId, skinId) => {
  const account = appData.accounts.find((a) => a.id === accountId);
  if (!account) return { ok: false, error: 'اکانت پیدا نشد.' };
  const p = skinFilePath(accountId, skinId);
  if (fs.existsSync(p)) fs.unlinkSync(p);
  account.skins = (account.skins || []).filter((s) => s.id !== skinId);
  if (account.activeSkinId === skinId) {
    account.activeSkinId = account.skins.length ? account.skins[0].id : null;
  }
  upsertAccount(account);
  if (appData.settings.mcDir) applySkinResourcePack(appData.settings.mcDir, account);
  return { ok: true, account: sanitizeAccount(account) };
});

ipcMain.handle('skins:get-offline-default', (e, versionId) => {
  try {
    const mcDir = appData.settings.mcDir;
    if (!versionId) return { ok: false, error: 'نسخه‌ای انتخاب نشده.' };
    const versionJson = resolveVersionJson(mcDir, versionId);
    const jarSourceId = versionJson.__jarSource || versionId;
    const jarPath = findVersionJarPath(mcDir, versionId, jarSourceId);
    if (!jarPath) return { ok: false, error: 'فایل jar این نسخه پیدا نشد.' };
    const zip = new AdmZip(jarPath);
    const candidates = ['assets/minecraft/textures/entity/steve.png', 'assets/minecraft/textures/entity/alex.png', 'char.png'];
    for (const c of candidates) {
      const entry = zip.getEntry(c);
      if (entry) {
        const buf = zip.readFile(entry);
        return { ok: true, dataUrl: 'data:image/png;base64,' + buf.toString('base64') };
      }
    }
    return { ok: false, error: 'تکسچر پیش‌فرض توی این نسخه پیدا نشد.' };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('skins:get-uploaded-image', (e, accountId, skinId) => {
  try {
    const p = skinFilePath(accountId, skinId);
    if (!fs.existsSync(p)) return { ok: false, error: 'فایل اسکین پیدا نشد.' };
    const buf = fs.readFileSync(p);
    return { ok: true, dataUrl: 'data:image/png;base64,' + buf.toString('base64') };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- اخبار رسمی ماینکرافت ----------
// از همون endpoint رسمی که خود لانچر ماینکرافت برای نمایش اخبار استفاده می‌کنه.
ipcMain.handle('news:fetch', async () => {
  try {
    const data = await httpGetJSON('https://launchercontent.mojang.com/news.json');
    const entries = (data.entries || []).slice(0, 8).map((n) => ({
      title: n.title,
      date: n.date,
      text: n.text,
      image: (n.newsPageImage && n.newsPageImage.url) || (n.playPageImage && n.playPageImage.url) || null,
      link: n.readMoreLink || n.newsLink || null
    }));
    return { ok: true, entries };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('shell:open-external', (e, url) => {
  if (url && /^https?:\/\//.test(url)) shell.openExternal(url);
  return { ok: true };
});

// ---------- چک آپدیت خود لانچر (از روی GitHub Releases) ----------
// این‌جا فقط کافیه "owner/repo" ریپوی گیت‌هابت رو بذاری، مثلاً: 'MrBadcombo/ph-launcher'.
// دیگه هیچ فایل JSON جداگونه‌ای برای نگه‌داشتن شماره‌ی آخرین نسخه لازم نیست — لانچر مستقیم از
// GitHub می‌پرسه «آخرین Release این ریپو چیه؟» پس همین که یه Release جدید روی گیت‌هاب منتشر کنی،
// چک آپدیت خودش خودکار بروزه؛ چیزی برای یادت رفتن نیست. راهنمای کامل: UPDATE-GUIDE.md
// تا وقتی خالیه، این قابلیت هیچ خطایی نمی‌ده، فقط بی‌صدا هیچ‌کاری نمی‌کنه.
const UPDATE_REPO = ''; // مثلا: 'MrBadcombo/ph-launcher'

ipcMain.handle('update:check', async () => {
  if (!UPDATE_REPO) return { ok: false, unset: true };
  try {
    const data = await httpGetJSON(`https://api.github.com/repos/${UPDATE_REPO}/releases/latest`);
    const currentVersion = app.getVersion();
    const latestVersion = String(data.tag_name || '').replace(/^v/i, '');
    if (!latestVersion) return { ok: false, error: 'ریلیزی روی گیت‌هاب پیدا نشد' };
    const hasUpdate = compareVersions(latestVersion, currentVersion) > 0;
    // اگه فایل نصبی مخصوص همین سیستم‌عامل بین پیوست‌های Release پیدا بشه مستقیم بهش لینک می‌دیم؛
    // وگرنه کاربر رو به خود صفحه‌ی Release می‌فرستیم تا خودش فایل درست رو انتخاب کنه.
    const platformExt = process.platform === 'win32' ? '.exe' : process.platform === 'darwin' ? '.dmg' : '.AppImage';
    const asset = (data.assets || []).find((a) => a.name && a.name.endsWith(platformExt));
    const url = (asset && asset.browser_download_url) || data.html_url;
    return { ok: true, hasUpdate, latestVersion, currentVersion, url };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

function compareVersions(a, b) {
  const pa = String(a).split('.').map(Number);
  const pb = String(b).split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0, nb = pb[i] || 0;
    if (na !== nb) return na - nb;
  }
  return 0;
}

// ---------- حالت پرتابل ----------
ipcMain.handle('settings:portable-status', () => ({ isPortable: IS_PORTABLE, portableDir: PORTABLE_DIR }));

ipcMain.handle('settings:enable-portable', () => {
  try {
    if (IS_PORTABLE) return { ok: true, alreadyPortable: true };
    fs.mkdirSync(PORTABLE_DIR, { recursive: true });
    // کپی داده‌های فعلی به پوشه‌ی پرتابل
    const copyIfExists = (src, destName) => {
      const dest = path.join(PORTABLE_DIR, destName);
      if (fs.existsSync(src)) fs.cpSync(src, dest, { recursive: true });
    };
    copyIfExists(DATA_FILE, 'ph-launcher-data.json');
    copyIfExists(path.join(DATA_DIR, 'skins'), 'skins');
    copyIfExists(path.join(DATA_DIR, 'instances'), 'instances');
    copyIfExists(path.join(DATA_DIR, 'jre'), 'jre');
    return { ok: true, requiresRestart: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('app:restart', () => {
  app.relaunch();
  isQuitting = true;
  app.exit(0);
});

// ---------- پشتیبان‌گیری کامل از خود لانچر (تنظیمات، اکانت‌ها، اسکین‌ها، لیست Instance ها) ----------
// توجه: این فقط تنظیمات لانچر رو export می‌کنه، نه فایل‌های واقعی دنیاها/مادهای داخل هر Instance
// (که می‌تونن خیلی حجیم باشن) — برای اونا از بکاپ‌گیری دنیاها یا حالت پرتابل استفاده کن.
ipcMain.handle('backup:export-launcher', async () => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: `ph-launcher-backup-${new Date().toISOString().slice(0, 10)}.phbackup`,
      filters: [{ name: 'PH Launcher Backup', extensions: ['phbackup'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    const zip = new AdmZip();
    zip.addLocalFile(DATA_FILE, '', 'ph-launcher-data.json');
    if (fs.existsSync(SKINS_DIR)) zip.addLocalFolder(SKINS_DIR, 'skins');
    zip.writeZip(result.filePath);
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('backup:import-launcher', async () => {
  try {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [{ name: 'PH Launcher Backup', extensions: ['phbackup'] }]
    });
    if (result.canceled || !result.filePaths.length) return { ok: false, canceled: true };

    const zip = new AdmZip(result.filePaths[0]);
    const dataEntry = zip.getEntry('ph-launcher-data.json');
    if (!dataEntry) return { ok: false, error: 'فایل بکاپ معتبر نیست.' };
    const imported = JSON.parse(zip.readAsText(dataEntry));

    // با ساختار فعلی merge می‌کنیم تا فیلدهای جدیدی که این نسخه از لانچر اضافه کرده از بین نره
    const d = defaultData();
    appData.settings = Object.assign({}, d.settings, imported.settings || {});
    appData.rank = Object.assign({}, d.rank, imported.rank || {});
    appData.accounts = imported.accounts || [];
    appData.instances = imported.instances || [];
    appData.stats = Object.assign({}, d.stats, imported.stats || {});
    appData.achievementsUnlocked = imported.achievementsUnlocked || [];
    saveData(appData);

    if (!fs.existsSync(SKINS_DIR)) fs.mkdirSync(SKINS_DIR, { recursive: true });
    for (const entry of zip.getEntries()) {
      if (entry.entryName.startsWith('skins/') && !entry.isDirectory) {
        const dest = path.join(SKINS_DIR, entry.entryName.slice('skins/'.length));
        fs.writeFileSync(dest, zip.readFile(entry));
      }
    }

    return { ok: true, requiresRestart: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

// ---------- Discord Rich Presence ----------
// این آدرس رو خودت (سازنده‌ی لانچر) قبل از پابلیش پر کن — از https://discord.com/developers/applications
// یه اپلیکیشن رایگان بساز و Application ID رو اینجا بذار. تا وقتی خالیه، این قابلیت کاملاً بی‌صدا غیرفعال می‌مونه.
const DISCORD_CLIENT_ID = '';
let discordClient = null;
let discordReady = false;

function initDiscordRpc() {
  if (!DISCORD_CLIENT_ID || !appData.settings.discordRpcEnabled) return;
  try {
    const DiscordRPC = require('discord-rpc');
    discordClient = new DiscordRPC.Client({ transport: 'ipc' });
    discordClient.on('ready', () => {
      discordReady = true;
      setDiscordActivity('در حال مرور لانچر');
    });
    discordClient.login({ clientId: DISCORD_CLIENT_ID }).catch((e) => {
      console.warn('Discord RPC login failed (Discord may not be running):', e.message);
    });
  } catch (e) {
    console.warn('discord-rpc module not available:', e.message);
  }
}

function setDiscordActivity(details, state) {
  if (!discordReady || !discordClient) return;
  try {
    discordClient.setActivity({
      details: details || 'PH لانچر',
      state: state || undefined,
      startTimestamp: Date.now(),
      largeImageKey: 'ph_launcher_logo',
      largeImageText: 'PH Launcher',
      instance: false
    }).catch(() => {});
  } catch (e) { /* بی‌صدا نادیده بگیر، دیسکورد ضروری نیست */ }
}

function clearDiscordActivity() {
  if (!discordReady || !discordClient) return;
  try { discordClient.clearActivity().catch(() => {}); } catch (e) { /* ignore */ }
}

ipcMain.handle('discord:toggle', (e, enabled) => {
  appData.settings.discordRpcEnabled = enabled;
  saveData(appData);
  if (enabled && !discordClient) initDiscordRpc();
  if (!enabled) clearDiscordActivity();
  return { ok: true };
});

// ---------- اشتراک‌گذاری کارت رنک (ذخیره یا کپی عکس) ----------
ipcMain.handle('image:save', async (e, dataUrl, suggestedName) => {
  try {
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: suggestedName || 'ph-launcher-rank-card.png',
      filters: [{ name: 'PNG Image', extensions: ['png'] }]
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };
    const base64 = dataUrl.replace(/^data:image\/png;base64,/, '');
    fs.writeFileSync(result.filePath, Buffer.from(base64, 'base64'));
    return { ok: true, path: result.filePath };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('image:copy-to-clipboard', (e, dataUrl) => {
  try {
    const img = nativeImage.createFromDataURL(dataUrl);
    clipboard.writeImage(img);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});
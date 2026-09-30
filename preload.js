const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ph', {
  getSettings: () => ipcRenderer.invoke('settings:get'),
  saveSettings: (s) => ipcRenderer.invoke('settings:save', s),
  browseFolder: () => ipcRenderer.invoke('settings:browse-folder'),
  browseJava: () => ipcRenderer.invoke('settings:browse-java'),
  autoDetectMcDir: () => ipcRenderer.invoke('settings:auto-detect-mcdir'),

  scanVersions: () => ipcRenderer.invoke('versions:scan'),
  toggleFavorite: (id) => ipcRenderer.invoke('versions:toggle-favorite', id),
  launchVersion: (id, serverAddress) => ipcRenderer.invoke('versions:launch', id, serverAddress),

  getRank: () => ipcRenderer.invoke('rank:get'),
  listRecentlyPlayed: () => ipcRenderer.invoke('recently-played:list'),

  listGallery: () => ipcRenderer.invoke('gallery:list'),
  deleteScreenshot: (filePath) => ipcRenderer.invoke('gallery:delete', filePath),
  createBackup: () => ipcRenderer.invoke('backup:create'),
  openFolder: (which) => ipcRenderer.invoke('folder:open', which),

  getManifest: () => ipcRenderer.invoke('download:manifest'),
  downloadVersion: (id) => ipcRenderer.invoke('download:start', id),
  detectJava: () => ipcRenderer.invoke('java:detect'),
  clearNatives: () => ipcRenderer.invoke('natives:clear'),
  getRequiredJavaVersion: (versionId) => ipcRenderer.invoke('java:required-version', versionId),
  autoInstallJava: (major) => ipcRenderer.invoke('java:auto-install', major),
  onJavaInstallProgress: (cb) => ipcRenderer.on('java:install-progress', (e, data) => cb(data)),

  listAchievements: () => ipcRenderer.invoke('achievements:list'),
  onAchievementUnlocked: (cb) => ipcRenderer.on('achievements:unlocked', (e, data) => cb(data)),

  listInstances: () => ipcRenderer.invoke('instances:list'),
  createInstance: (name, versionId) => ipcRenderer.invoke('instances:create', name, versionId),
  deleteInstance: (id) => ipcRenderer.invoke('instances:delete', id),
  launchInstance: (id, serverAddress) => ipcRenderer.invoke('instances:launch', id, serverAddress),
  openInstanceFolder: (id, which) => ipcRenderer.invoke('instances:open-folder', id, which),

  searchMods: (query, mcVersion, loader) => ipcRenderer.invoke('mods:search', query, mcVersion, loader),
  installMod: (projectId, mcVersion, loader, instanceId) => ipcRenderer.invoke('mods:install', projectId, mcVersion, loader, instanceId),
  listMods: (instanceId) => ipcRenderer.invoke('mods:list', instanceId),
  removeMod: (fileName, instanceId) => ipcRenderer.invoke('mods:remove', fileName, instanceId),
  checkModUpdates: (mcVersion, loader, instanceId) => ipcRenderer.invoke('mods:check-updates', mcVersion, loader, instanceId),
  applyModUpdate: (fileName, projectId, latestVersionId, instanceId) => ipcRenderer.invoke('mods:apply-update', fileName, projectId, latestVersionId, instanceId),
  suggestModTarget: (versionId) => ipcRenderer.invoke('mods:suggest-target', versionId),

  pingServer: (address) => ipcRenderer.invoke('servers:ping', address),

  listAccounts: () => ipcRenderer.invoke('accounts:list'),
  addOfflineAccount: (username) => ipcRenderer.invoke('accounts:add-offline', username),
  removeAccount: (id) => ipcRenderer.invoke('accounts:remove', id),
  setActiveAccount: (id) => ipcRenderer.invoke('accounts:set-active', id),

  uploadSkin: (accountId, name, model) => ipcRenderer.invoke('accounts:upload-skin', accountId, name, model),
  setActiveSkin: (accountId, skinId) => ipcRenderer.invoke('accounts:set-active-skin', accountId, skinId),
  removeSkin: (accountId, skinId) => ipcRenderer.invoke('accounts:remove-skin', accountId, skinId),
  getOfflineSkin: (versionId) => ipcRenderer.invoke('skins:get-offline-default', versionId),
  getUploadedSkinImage: (accountId, skinId) => ipcRenderer.invoke('skins:get-uploaded-image', accountId, skinId),

  listServers: () => ipcRenderer.invoke('servers:list'),
  addServer: (name, address) => ipcRenderer.invoke('servers:add', { name, address }),
  removeServer: (id) => ipcRenderer.invoke('servers:remove', id),

  searchContent: (query, versionId, projectType) => ipcRenderer.invoke('content:search', query, versionId, projectType),
  installContent: (projectId, versionId, projectType, instanceId) => ipcRenderer.invoke('content:install', projectId, versionId, projectType, instanceId),
  listContent: (projectType, instanceId) => ipcRenderer.invoke('content:list', projectType, instanceId),
  removeContent: (fileName, projectType, instanceId) => ipcRenderer.invoke('content:remove', fileName, projectType, instanceId),

  importModpack: () => ipcRenderer.invoke('modpack:import'),
  onModpackImportProgress: (cb) => ipcRenderer.on('modpack:import-progress', (e, data) => cb(data)),

  installDroppedFile: (filePath, kind, instanceId) => ipcRenderer.invoke('files:install-dropped', filePath, kind, instanceId),

  listLanGames: () => ipcRenderer.invoke('lan:list'),

  listWorlds: (instanceId) => ipcRenderer.invoke('worlds:list', instanceId),
  getWorldSeed: (instanceId, worldName) => ipcRenderer.invoke('worlds:get-seed', instanceId, worldName),
  renameWorld: (instanceId, oldName, newName) => ipcRenderer.invoke('worlds:rename', instanceId, oldName, newName),
  duplicateWorld: (instanceId, name) => ipcRenderer.invoke('worlds:duplicate', instanceId, name),
  deleteWorld: (instanceId, name) => ipcRenderer.invoke('worlds:delete', instanceId, name),
  openWorldFolder: (instanceId, name) => ipcRenderer.invoke('worlds:open-folder', instanceId, name),

  leaderboardSync: () => ipcRenderer.invoke('leaderboard:sync'),
  leaderboardFetch: (sort) => ipcRenderer.invoke('leaderboard:fetch', sort),
  leaderboardPlayer: (name) => ipcRenderer.invoke('leaderboard:player', name),
  leaderboardAchievements: () => ipcRenderer.invoke('leaderboard:achievements'),

  fetchNews: () => ipcRenderer.invoke('news:fetch'),
  openExternal: (url) => ipcRenderer.invoke('shell:open-external', url),

  checkUpdate: () => ipcRenderer.invoke('update:check'),

  getPortableStatus: () => ipcRenderer.invoke('settings:portable-status'),
  enablePortable: () => ipcRenderer.invoke('settings:enable-portable'),
  restartApp: () => ipcRenderer.invoke('app:restart'),

  exportLauncherBackup: () => ipcRenderer.invoke('backup:export-launcher'),
  importLauncherBackup: () => ipcRenderer.invoke('backup:import-launcher'),

  toggleDiscordRpc: (enabled) => ipcRenderer.invoke('discord:toggle', enabled),

  saveImage: (dataUrl, suggestedName) => ipcRenderer.invoke('image:save', dataUrl, suggestedName),
  copyImageToClipboard: (dataUrl) => ipcRenderer.invoke('image:copy-to-clipboard', dataUrl),

  onGameStatus: (cb) => ipcRenderer.on('game:status', (e, data) => cb(data)),
  onGameLog: (cb) => ipcRenderer.on('game:log', (e, data) => cb(data)),
  onRankUpdated: (cb) => ipcRenderer.on('rank:updated', (e, data) => cb(data)),
  onDownloadProgress: (cb) => ipcRenderer.on('download:progress', (e, data) => cb(data)),
  onCrashAnalysis: (cb) => ipcRenderer.on('game:crash-analysis', (e, data) => cb(data)),
  onProtocolAction: (cb) => ipcRenderer.on('protocol:action', (e, data) => cb(data))
});

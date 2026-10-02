importScripts("core.js", "storage.js", "backup.js");

const backedUpStorageKeys = new Set([
  globalThis.SiteCommandPaletteCore.COMMANDS_STORAGE_KEY,
  globalThis.SiteCommandPaletteCore.SITES_STORAGE_KEY,
  globalThis.SiteCommandPaletteCore.SETTINGS_STORAGE_KEY,
  globalThis.SiteCommandPaletteCore.STORAGE_SCHEMA_VERSION_KEY
]);
let backupQueue = Promise.resolve();
const { BACKUP_STATUS_KEY, refreshBackupStatus } = globalThis.SiteCommandPaletteBackup;

// A retained directory handle does not imply that Chrome retained its permission.
backupQueue = backupQueue.then(refreshBackupStatus).catch(reportBackupError);
chrome.runtime.onStartup.addListener(checkBackupAccess);

chrome.runtime.onInstalled.addListener(() => {
  globalThis.SiteCommandPaletteStorage.loadStorage().catch((error) => {
    console.error("Site Command Palette storage migration failed:", error);
  });
  checkBackupAccess();
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "check-backup-access") checkBackupAccess();
  if (message?.type === "open-options") chrome.runtime.openOptionsPage();
  if (message?.type === "open-tab") {
    const url = globalThis.SiteCommandPaletteCore.normalizeUrl(message.url);
    if (url) chrome.tabs.create({ url });
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (changes[BACKUP_STATUS_KEY]) {
    updateBackupBadge(changes[BACKUP_STATUS_KEY].newValue).catch(console.error);
  }
  if (!Object.keys(changes).some((key) => backedUpStorageKeys.has(key))) return;

  backupQueue = backupQueue
    .then(runAutomaticBackup)
    .catch(reportBackupError);
});

function checkBackupAccess() {
  backupQueue = backupQueue.then(refreshBackupStatus).catch(reportBackupError);
}

async function reportBackupError(error) {
  console.error("Site Command Palette backup failed:", error);
  await chrome.storage.local.set({ [BACKUP_STATUS_KEY]: {
    status: "error", message: error instanceof Error ? error.message : String(error),
    checkedAt: new Date().toISOString()
  } });
}

async function updateBackupBadge(state) {
  const failed = ["permission-required", "error"].includes(state?.status);
  await chrome.action.setBadgeText({ text: failed ? "!" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: "#b91c1c" });
  await chrome.action.setTitle({ title: failed
    ? "Site Command Palette — backups paused; open Settings"
    : "Site Command Palette" });
}

async function runAutomaticBackup() {
  const data = await globalThis.SiteCommandPaletteStorage.loadStorage();
  await globalThis.SiteCommandPaletteBackup.writeBackup(data);
}

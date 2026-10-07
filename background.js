importScripts("core.js", "storage.js", "backup.js");

const backedUpStorageKeys = new Set([
  globalThis.SiteCommandPaletteCore.COMMANDS_STORAGE_KEY,
  globalThis.SiteCommandPaletteCore.SITES_STORAGE_KEY,
  globalThis.SiteCommandPaletteCore.SETTINGS_STORAGE_KEY,
  globalThis.SiteCommandPaletteCore.STORAGE_SCHEMA_VERSION_KEY
]);
let backupQueue = Promise.resolve();
const { BACKUP_STATUS_KEY, refreshBackupStatus } = globalThis.SiteCommandPaletteBackup;
const { HISTORY_ENABLED_STORAGE_KEY, historySearchPrefix, normalizeHostname, normalizeUrl } =
  globalThis.SiteCommandPaletteCore;

refreshHistoryAccess().catch(console.error);
chrome.permissions.onAdded.addListener(handleHistoryPermissionChange);
chrome.permissions.onRemoved.addListener(handleHistoryPermissionChange);

// A retained directory handle does not imply that Chrome retained its permission.
backupQueue = backupQueue.then(refreshBackupStatus).catch(reportBackupError);
chrome.runtime.onStartup.addListener(checkBackupAccess);

chrome.runtime.onInstalled.addListener(() => {
  globalThis.SiteCommandPaletteStorage.loadStorage().catch((error) => {
    console.error("Site Command Palette storage migration failed:", error);
  });
  checkBackupAccess();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "search-history") {
    searchHistory(message, sender).then(sendResponse).catch((error) => {
      sendResponse({ candidates: [], error: error.message });
    });
    return true;
  }
  if (message?.type === "check-backup-access") checkBackupAccess();
  if (message?.type === "open-options") chrome.runtime.openOptionsPage();
  if (message?.type === "open-tab") {
    const url = globalThis.SiteCommandPaletteCore.normalizeUrl(message.url);
    if (url) chrome.tabs.create({ url });
  }
});

function handleHistoryPermissionChange(change) {
  if (change.permissions?.includes("history")) refreshHistoryAccess().catch(console.error);
}

async function refreshHistoryAccess() {
  const enabled = await chrome.permissions.contains({ permissions: ["history"] });
  await chrome.storage.local.set({ [HISTORY_ENABLED_STORAGE_KEY]: enabled });
  return enabled;
}

async function searchHistory(message, sender) {
  const query = typeof message.query === "string" ? message.query.trim().slice(0, 200) : "";
  if (!query || query.startsWith("/")) return { candidates: [] };
  // Incognito palettes must not expose the regular profile's history.
  const hostname = normalizeHostname(sender.url);
  if (!sender.tab || sender.tab.incognito || !hostname ||
      !(await chrome.permissions.contains({ permissions: ["history"] }))) {
    return { candidates: [] };
  }
  const prefix = historySearchPrefix(query);
  if (!prefix) return { candidates: [] };
  // Chromium treats maxResults: 0 as unlimited. Local refinements need the
  // complete prefix set, including entries outside the ten visible results.
  const items = await chrome.history.search({ text: prefix, startTime: 0, maxResults: 0 });
  // Permission may have been removed while Chrome was searching.
  if (!(await chrome.permissions.contains({ permissions: ["history"] }))) return { candidates: [] };
  return { candidates: items.flatMap((item) => {
    const url = normalizeUrl(item.url);
    return url ? [{ url, title: item.title ?? "" }] : [];
  }) };
}

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

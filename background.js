importScripts("core.js", "storage.js", "backup.js");

const backedUpStorageKeys = new Set([
  globalThis.SiteCommandPaletteCore.COMMANDS_STORAGE_KEY,
  globalThis.SiteCommandPaletteCore.SETTINGS_STORAGE_KEY,
  globalThis.SiteCommandPaletteCore.STORAGE_SCHEMA_VERSION_KEY
]);
let backupQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  globalThis.SiteCommandPaletteStorage.loadStorage().catch((error) => {
    console.error("Site Command Palette storage migration failed:", error);
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "open-options") chrome.runtime.openOptionsPage();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") return;
  if (!Object.keys(changes).some((key) => backedUpStorageKeys.has(key))) return;

  backupQueue = backupQueue
    .then(runAutomaticBackup)
    .catch((error) => console.error("Site Command Palette backup failed:", error));
});

async function runAutomaticBackup() {
  const data = await globalThis.SiteCommandPaletteStorage.loadStorage();
  await globalThis.SiteCommandPaletteBackup.writeBackup(data);
}

async function initialize() {
  const data = await globalThis.SiteCommandPaletteStorage.loadStorage();
  const { keyBindings } = data.settings;
  const { formatKeyBinding } = globalThis.SiteCommandPaletteCore;
  document.getElementById("primary-shortcut").textContent = keyBindings.togglePrimary === "Backquote"
    ? "Backtick (`)" : formatKeyBinding(keyBindings.togglePrimary);
  const alternate = document.getElementById("alternate-shortcut");
  document.getElementById("alternate-hint").hidden = !keyBindings.toggleAlternate;
  alternate.textContent = keyBindings.toggleAlternate === "Alt+Backquote"
    ? "Alt + Backtick" : formatKeyBinding(keyBindings.toggleAlternate);
  await renderWebsiteAccess(data.settings);
}

async function renderWebsiteAccess(settings) {
  const badge = document.getElementById("website-access");
  const note = document.getElementById("page-access-note");
  try {
    const allSites = await chrome.permissions.contains({ origins: ["http://*/*", "https://*/*"] });
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url ? new URL(tab.url) : null;
    const supported = url && ["http:", "https:"].includes(url.protocol) &&
      url.hostname !== "chromewebstore.google.com" &&
      !(url.hostname === "chrome.google.com" && url.pathname.startsWith("/webstore"));
    const thisSite = supported && await chrome.permissions.contains({
      origins: [`${url.protocol}//${url.hostname}/*`]
    });

    badge.textContent = allSites ? "All sites" : thisSite ? "This site"
      : supported ? "Not enabled here" : "Unavailable here";
    badge.dataset.state = allSites || thisSite ? "allowed" : supported ? "withheld" : "unknown";
    if (!supported) {
      note.textContent = "The palette cannot run on this page.";
      note.hidden = false;
    } else if (globalThis.SiteCommandPaletteCore.isSiteDisabled(settings, url)) {
      note.textContent = "This website is disabled in Settings.";
      note.hidden = false;
    }
  } catch (error) {
    badge.textContent = "Could not check";
    badge.dataset.state = "unknown";
    console.error("Website access check failed:", error);
  }
}

document.getElementById("settings").addEventListener("click", () => chrome.runtime.openOptionsPage());
async function renderBackupWarning() {
  const { backupStatus } = await chrome.storage.local.get("backupStatus");
  const warning = document.getElementById("backup-warning");
  warning.hidden = !["permission-required", "error"].includes(backupStatus?.status);
  warning.textContent = "Automatic backups are paused. Open Settings to reconnect the folder or review the error.";
}
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.backupStatus) renderBackupWarning();
});
chrome.runtime.sendMessage({ type: "check-backup-access" });
renderBackupWarning().catch(console.error);
initialize().catch((error) => console.error("Shortcut reminder failed to load:", error));

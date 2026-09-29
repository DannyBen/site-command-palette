importScripts("core.js", "storage.js");

chrome.runtime.onInstalled.addListener(() => {
  globalThis.SiteCommandPaletteStorage.loadStorage().catch((error) => {
    console.error("Site Command Palette storage migration failed:", error);
  });
});

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === "open-options") chrome.runtime.openOptionsPage();
});

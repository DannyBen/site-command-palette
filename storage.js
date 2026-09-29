(() => {
  const {
    COMMANDS_STORAGE_KEY,
    SITES_STORAGE_KEY,
    SETTINGS_STORAGE_KEY,
    STORAGE_SCHEMA_VERSION_KEY,
    migrateStorage
  } = globalThis.SiteCommandPaletteCore;

  async function loadStorage() {
    const stored = await chrome.storage.local.get([
      STORAGE_SCHEMA_VERSION_KEY,
      COMMANDS_STORAGE_KEY,
      SITES_STORAGE_KEY,
      SETTINGS_STORAGE_KEY
    ]);
    const migration = migrateStorage(stored);

    if (migration.migrated) await chrome.storage.local.set(migration.data);
    return migration.data;
  }

  globalThis.SiteCommandPaletteStorage = Object.freeze({
    COMMANDS_STORAGE_KEY,
    SITES_STORAGE_KEY,
    SETTINGS_STORAGE_KEY,
    STORAGE_SCHEMA_VERSION_KEY,
    loadStorage
  });
})();

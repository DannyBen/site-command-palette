(() => {
  const STORAGE_SCHEMA_VERSION = 1;
  const STORAGE_SCHEMA_VERSION_KEY = "storageSchemaVersion";
  const COMMANDS_STORAGE_KEY = "commandsByHostname";
  const SETTINGS_STORAGE_KEY = "settings";

  function normalizeUrl(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  function fuzzyMatch(query, candidate) {
    if (!query) return { score: 0, indices: [] };

    const needle = query.toLocaleLowerCase();
    const haystack = candidate.toLocaleLowerCase();
    const indices = [];
    let score = 0;
    let needleIndex = 0;
    let previousMatch = -2;

    for (let index = 0; index < haystack.length && needleIndex < needle.length; index += 1) {
      if (haystack[index] !== needle[needleIndex]) continue;

      score += 1;
      if (index === 0 || /[\s/_-]/.test(haystack[index - 1])) score += 4;
      if (index === previousMatch + 1) score += 2;
      previousMatch = index;
      indices.push(index);
      needleIndex += 1;
    }

    if (needleIndex !== needle.length) return null;
    if (haystack.startsWith(needle)) score += 8;
    return { score: score - haystack.length * 0.01, indices };
  }

  function compactUrl(value) {
    const url = new URL(value);
    const path = `${url.pathname}${url.search}${url.hash}` || "/";
    return middleEllipsis(path, 42);
  }

  function middleEllipsis(value, maximumLength) {
    if (value.length <= maximumLength) return value;

    const visibleLength = maximumLength - 1;
    const startLength = Math.ceil(visibleLength / 2);
    const endLength = Math.floor(visibleLength / 2);
    return `${value.slice(0, startLength)}…${value.slice(-endLength)}`;
  }

  function normalizeSettings(value) {
    const storedSettings = value && typeof value === "object" ? value : {};
    const storedSiteThemes = storedSettings.siteThemes;
    const siteThemes = {};

    if (storedSiteThemes && typeof storedSiteThemes === "object") {
      for (const [hostname, theme] of Object.entries(storedSiteThemes)) {
        if (["light", "dark"].includes(theme)) siteThemes[hostname] = theme;
      }
    }

    return {
      version: 1,
      theme: ["light", "dark", "system"].includes(storedSettings.theme)
        ? storedSettings.theme
        : "light",
      siteThemes
    };
  }

  function normalizeCommandsByHostname(value) {
    const storedCommands = value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
    const commandsByHostname = {};

    for (const [hostname, commands] of Object.entries(storedCommands)) {
      if (!hostname || !Array.isArray(commands)) continue;

      commandsByHostname[hostname] = commands
        .map(normalizeCommand)
        .filter(Boolean);
    }

    return commandsByHostname;
  }

  function normalizeCommand(value) {
    if (!value || typeof value !== "object") return null;

    const id = typeof value.id === "string" ? value.id.trim() : "";
    const name = typeof value.name === "string" ? value.name.trim() : "";
    const url = typeof value.url === "string" ? normalizeUrl(value.url) : null;
    if (!id || !name || !url) return null;

    return { id, name, url };
  }

  function migrateStorage(value) {
    const stored = value && typeof value === "object" ? value : {};
    const storedVersion = Number.isInteger(stored[STORAGE_SCHEMA_VERSION_KEY])
      ? stored[STORAGE_SCHEMA_VERSION_KEY]
      : 0;

    if (storedVersion > STORAGE_SCHEMA_VERSION) {
      throw new Error(`Unsupported storage schema version: ${storedVersion}`);
    }

    return {
      migrated: storedVersion < STORAGE_SCHEMA_VERSION,
      previousVersion: storedVersion,
      data: {
        [STORAGE_SCHEMA_VERSION_KEY]: STORAGE_SCHEMA_VERSION,
        [COMMANDS_STORAGE_KEY]: normalizeCommandsByHostname(stored[COMMANDS_STORAGE_KEY]),
        [SETTINGS_STORAGE_KEY]: normalizeSettings(stored[SETTINGS_STORAGE_KEY])
      }
    };
  }

  function resolveTheme(settings, hostname, prefersDark = false) {
    const selectedTheme = settings.siteThemes[hostname] ?? settings.theme;
    if (selectedTheme === "system") return prefersDark ? "dark" : "light";
    return selectedTheme;
  }

  const api = Object.freeze({
    COMMANDS_STORAGE_KEY,
    SETTINGS_STORAGE_KEY,
    STORAGE_SCHEMA_VERSION,
    STORAGE_SCHEMA_VERSION_KEY,
    compactUrl,
    fuzzyMatch,
    migrateStorage,
    middleEllipsis,
    normalizeCommandsByHostname,
    normalizeSettings,
    normalizeUrl,
    resolveTheme
  });

  globalThis.SiteCommandPaletteCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

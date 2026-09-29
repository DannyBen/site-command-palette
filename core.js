(() => {
  const STORAGE_SCHEMA_VERSION = 1;
  const STORAGE_SCHEMA_VERSION_KEY = "storageSchemaVersion";
  const COMMANDS_STORAGE_KEY = "commandsByHostname";
  const SETTINGS_STORAGE_KEY = "settings";
  const DEFAULT_KEY_BINDINGS = Object.freeze({
    togglePrimary: "Backquote",
    toggleAlternate: "Alt+Backquote",
    add: "Alt+KeyA",
    edit: "Alt+KeyE",
    remove: "Alt+KeyX"
  });
  const MODIFIER_CODES = new Set([
    "AltLeft",
    "AltRight",
    "ControlLeft",
    "ControlRight",
    "MetaLeft",
    "MetaRight",
    "ShiftLeft",
    "ShiftRight"
  ]);
  const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"];

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

  function formatBackupDate(value) {
    const date = new Date(value);
    if (Number.isNaN(date.valueOf())) return "Unknown date";

    const formattedDate = new Intl.DateTimeFormat("en-US", {
      year: "numeric",
      month: "long",
      day: "numeric"
    }).format(date);
    const formattedTime = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23"
    }).format(date);
    return `${formattedDate} at ${formattedTime}`;
  }

  function normalizeKeyBinding(value) {
    if (typeof value !== "string" || !value) return null;

    const parts = value.split("+");
    const code = parts.pop();
    if (!code || MODIFIER_CODES.has(code) || !/^[A-Za-z][A-Za-z0-9]*$/.test(code)) return null;
    if (new Set(parts).size !== parts.length || parts.some((part) => !MODIFIERS.includes(part))) {
      return null;
    }

    return [...MODIFIERS.filter((modifier) => parts.includes(modifier)), code].join("+");
  }

  function normalizeKeyBindings(value) {
    const storedBindings = value && typeof value === "object" ? value : {};
    const bindings = {};

    for (const [name, defaultBinding] of Object.entries(DEFAULT_KEY_BINDINGS)) {
      const storedBinding = normalizeKeyBinding(storedBindings[name]);
      bindings[name] = name === "toggleAlternate" && storedBindings[name] === null
        ? null
        : storedBinding ?? defaultBinding;
    }

    return bindings;
  }

  function keyBindingFromEvent(event) {
    if (!event?.code || MODIFIER_CODES.has(event.code)) return null;

    return [
      event.ctrlKey ? "Ctrl" : null,
      event.altKey ? "Alt" : null,
      event.shiftKey ? "Shift" : null,
      event.metaKey ? "Meta" : null,
      event.code
    ].filter(Boolean).join("+");
  }

  function matchesKeyBinding(event, binding) {
    return Boolean(binding) && keyBindingFromEvent(event) === binding;
  }

  function keyBindingHasModifier(binding) {
    return typeof binding === "string" && binding.includes("+");
  }

  function formatKeyBinding(binding) {
    if (!binding) return "Not set";

    const labels = {
      Backquote: "`",
      Backslash: "\\",
      BracketLeft: "[",
      BracketRight: "]",
      Comma: ",",
      Equal: "=",
      Minus: "-",
      Period: ".",
      Quote: "'",
      Semicolon: ";",
      Slash: "/",
      Space: "Space"
    };

    return binding.split("+").map((part) => {
      if (/^Key[A-Z]$/.test(part)) return part.slice(3);
      if (/^Digit\d$/.test(part)) return part.slice(5);
      return labels[part] ?? part;
    }).join(" + ");
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
      siteThemes,
      keyBindings: normalizeKeyBindings(storedSettings.keyBindings)
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
    DEFAULT_KEY_BINDINGS,
    SETTINGS_STORAGE_KEY,
    STORAGE_SCHEMA_VERSION,
    STORAGE_SCHEMA_VERSION_KEY,
    compactUrl,
    formatBackupDate,
    formatKeyBinding,
    fuzzyMatch,
    keyBindingFromEvent,
    keyBindingHasModifier,
    matchesKeyBinding,
    migrateStorage,
    middleEllipsis,
    normalizeCommandsByHostname,
    normalizeKeyBinding,
    normalizeKeyBindings,
    normalizeSettings,
    normalizeUrl,
    resolveTheme
  });

  globalThis.SiteCommandPaletteCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

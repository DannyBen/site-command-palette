(() => {
  const STORAGE_SCHEMA_VERSION = 3;
  const STORAGE_SCHEMA_VERSION_KEY = "storageSchemaVersion";
  const COMMANDS_STORAGE_KEY = "commandsByHostname";
  const SITES_STORAGE_KEY = "sitesByHostname";
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

  function siteIdentity(value) {
    try {
      const url = new URL(value?.href ?? value);
      if (!["http:", "https:"].includes(url.protocol)) return null;
      return url.hostname.toLocaleLowerCase().replace(/^www\./, "");
    } catch {
      return null;
    }
  }

  function suggestSiteName(urlValue, title = "") {
    const titleParts = String(title)
      .split(/\s+(?:[-|·—–])\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    const titleCandidate = titleParts.at(-1);
    if (titleCandidate && titleCandidate.length <= 48 && !titleCandidate.includes("@")) {
      return titleCandidate;
    }

    const hostname = siteIdentity(urlValue);
    return hostname ? humanizeRoutePart(hostname.split(".")[0]) : "Site";
  }

  function suggestPageName(urlValue) {
    try {
      const url = new URL(urlValue);
      const hashParts = url.hash
        .replace(/^#\/?/, "")
        .split(/[/?&=]+/)
        .filter(Boolean);
      const pathParts = url.pathname.split("/").filter(Boolean);
      const routePart = hashParts.findLast((part) => !/^\d+$/.test(part)) ??
        pathParts.findLast((part) => !/^\d+$/.test(part));
      return routePart ? humanizeRoutePart(routePart) : "Home";
    } catch {
      return "Page";
    }
  }

  function humanizeRoutePart(value) {
    let decoded = value;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      // Keep the encoded value when it cannot be decoded.
    }

    return decoded
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[-_+]+/g, " ")
      .replace(/\b\p{L}/gu, (character) => character.toLocaleUpperCase());
  }

  function normalizeScope(value) {
    if (typeof value !== "string") return null;

    let scope = value.trim().toLocaleLowerCase();
    scope = scope.replace(/^https?:\/\//, "").replace(/^\/\//, "");
    scope = scope.split(/[?#]/, 1)[0];
    if (!scope || /\s/.test(scope)) return null;

    const slashIndex = scope.indexOf("/");
    const hostname = slashIndex === -1 ? scope : scope.slice(0, slashIndex);
    let pathname = slashIndex === -1 ? "" : scope.slice(slashIndex);

    if (!hostname || !/^[a-z0-9*.-]+$/.test(hostname)) return null;
    if (hostname !== "*" && (hostname.startsWith(".") || hostname.endsWith("."))) return null;
    if (pathname === "/") pathname = "";

    return `${hostname}${pathname}`;
  }

  function commandNameKey(value) {
    return typeof value === "string"
      ? value.trim().replace(/\s+/g, " ").toLocaleLowerCase()
      : "";
  }

  function scopeMatches(scopeValue, locationValue) {
    const scope = normalizeScope(scopeValue);
    if (!scope) return false;

    let hostname;
    let pathname;

    try {
      const location = typeof locationValue === "string" && !locationValue.includes("://")
        ? new URL(`https://${locationValue}`)
        : new URL(locationValue.href ?? locationValue);
      hostname = location.hostname.toLocaleLowerCase();
      pathname = location.pathname;
    } catch {
      return false;
    }

    const slashIndex = scope.indexOf("/");
    const hostnamePattern = slashIndex === -1 ? scope : scope.slice(0, slashIndex);
    const pathnamePattern = slashIndex === -1 ? null : scope.slice(slashIndex);

    return globMatches(hostnamePattern, hostname) &&
      (pathnamePattern === null || globMatches(pathnamePattern, pathname));
  }

  function globMatches(pattern, value) {
    const expression = pattern
      .split("*")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*");
    return new RegExp(`^${expression}$`).test(value);
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

  function urlMatchesPage(urlValue, locationValue) {
    const locationUrl = locationValue?.href ?? locationValue;
    const url = normalizeUrl(urlValue);
    return url !== null && url === normalizeUrl(locationUrl);
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

  function normalizeCommandsByScope(value) {
    const storedCommands = value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
    const commandsByScope = {};
    const normalizedEntries = [];
    const usedIds = new Set();

    for (const [storedScope, commands] of Object.entries(storedCommands)) {
      const scope = normalizeScope(storedScope);
      if (!scope || !Array.isArray(commands)) continue;

      const normalizedCommands = commands
        .map(normalizeCommand)
        .filter(Boolean);
      normalizedEntries.push([scope, normalizedCommands]);
    }

    const reservedIds = new Set(normalizedEntries.flatMap(([, commands]) => (
      commands.map((command) => command.id)
    )));

    for (const [scope, commands] of normalizedEntries) {
      const repairedCommands = commands.map((command) => {
        let id = command.id;
        let suffix = 2;
        if (usedIds.has(id)) {
          do {
            id = `${command.id}-${suffix}`;
            suffix += 1;
          } while (usedIds.has(id) || reservedIds.has(id));
        }
        usedIds.add(id);
        return { ...command, id };
      });
      commandsByScope[scope] = [...(commandsByScope[scope] ?? []), ...repairedCommands];
    }

    return commandsByScope;
  }

  function normalizeCommand(value) {
    if (!value || typeof value !== "object") return null;

    const id = typeof value.id === "string" ? value.id.trim() : "";
    const pageValue = typeof value.page === "string" ? value.page : value.name;
    const page = typeof pageValue === "string" ? pageValue.trim() : "";
    const url = typeof value.url === "string" ? normalizeUrl(value.url) : null;
    if (!id || !page || !url) return null;

    return { id, page, url };
  }

  function normalizeSites(value) {
    const storedSites = value && typeof value === "object" && !Array.isArray(value)
      ? value
      : {};
    const sites = {};

    for (const [storedHostname, storedSite] of Object.entries(storedSites)) {
      const hostname = siteIdentity(`https://${storedHostname}`);
      const nameValue = typeof storedSite === "string" ? storedSite : storedSite?.name;
      const name = typeof nameValue === "string" ? nameValue.trim() : "";
      if (hostname && name) sites[hostname] = { name };
    }

    return sites;
  }

  function siteNameForUrl(sites, urlValue, title = "") {
    const hostname = siteIdentity(urlValue);
    return sites[hostname]?.name ?? suggestSiteName(urlValue, title);
  }

  function findCommandNameConflict(commandsByScope, scope, page, url, excludedId = null) {
    const pageKey = commandNameKey(page);
    const hostname = siteIdentity(url);
    if (!pageKey || !hostname) return null;

    return (commandsByScope[scope] ?? []).find((command) => (
      command.id !== excludedId &&
      siteIdentity(command.url) === hostname &&
      commandNameKey(command.page) === pageKey
    )) ?? null;
  }

  function resolveCommandsForLocation(commandsByScope, locationValue) {
    const matchingCommands = Object.entries(commandsByScope)
      .filter(([scope]) => scopeMatches(scope, locationValue))
      .flatMap(([scope, commands]) => commands.map((command) => ({
        ...command,
        scope,
        specificity: scopeSpecificity(scope)
      })));
    const bestSpecificityByName = new Map();

    for (const command of matchingCommands) {
      const nameKey = `${siteIdentity(command.url)}\0${commandNameKey(command.page)}`;
      const best = bestSpecificityByName.get(nameKey);
      if (!best || compareSpecificity(command.specificity, best) > 0) {
        bestSpecificityByName.set(nameKey, command.specificity);
      }
    }

    return matchingCommands
      .filter((command) => (
        compareSpecificity(command.specificity, bestSpecificityByName.get(
          `${siteIdentity(command.url)}\0${commandNameKey(command.page)}`
        )) === 0
      ))
      .map(({ specificity, ...command }) => command);
  }

  function scopeSpecificity(scope) {
    const slashIndex = scope.indexOf("/");
    const hostname = slashIndex === -1 ? scope : scope.slice(0, slashIndex);
    const hasPath = slashIndex !== -1;
    const hostnameKind = hostname === "*" ? 0 : hostname.includes("*") ? 1 : 2;
    const literalLength = scope.replace(/\*/g, "").length;
    const wildcardCount = (scope.match(/\*/g) ?? []).length;
    return [Number(hasPath), hostnameKind, literalLength, -wildcardCount];
  }

  function compareSpecificity(left, right) {
    for (let index = 0; index < left.length; index += 1) {
      if (left[index] !== right[index]) return left[index] - right[index];
    }
    return 0;
  }

  function migrateStorage(value) {
    const stored = value && typeof value === "object" ? value : {};
    const storedVersion = Number.isInteger(stored[STORAGE_SCHEMA_VERSION_KEY])
      ? stored[STORAGE_SCHEMA_VERSION_KEY]
      : 0;

    if (storedVersion > STORAGE_SCHEMA_VERSION) {
      throw new Error(`Unsupported storage schema version: ${storedVersion}`);
    }

    const commandsByScope = normalizeCommandsByScope(stored[COMMANDS_STORAGE_KEY]);
    const sites = normalizeSites(stored[SITES_STORAGE_KEY]);
    for (const commands of Object.values(commandsByScope)) {
      for (const command of commands) {
        const hostname = siteIdentity(command.url);
        if (hostname && !sites[hostname]) {
          sites[hostname] = { name: suggestSiteName(command.url) };
        }
      }
    }

    return {
      migrated: storedVersion < STORAGE_SCHEMA_VERSION,
      previousVersion: storedVersion,
      data: {
        [STORAGE_SCHEMA_VERSION_KEY]: STORAGE_SCHEMA_VERSION,
        [COMMANDS_STORAGE_KEY]: commandsByScope,
        [SITES_STORAGE_KEY]: sites,
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
    SITES_STORAGE_KEY,
    STORAGE_SCHEMA_VERSION,
    STORAGE_SCHEMA_VERSION_KEY,
    commandNameKey,
    findCommandNameConflict,
    formatBackupDate,
    formatKeyBinding,
    fuzzyMatch,
    keyBindingFromEvent,
    keyBindingHasModifier,
    matchesKeyBinding,
    migrateStorage,
    middleEllipsis,
    normalizeCommandsByScope,
    normalizeKeyBinding,
    normalizeKeyBindings,
    normalizeSettings,
    normalizeSites,
    normalizeScope,
    normalizeUrl,
    resolveTheme,
    resolveCommandsForLocation,
    siteIdentity,
    siteNameForUrl,
    suggestPageName,
    suggestSiteName,
    scopeMatches,
    urlMatchesPage
  });

  globalThis.SiteCommandPaletteCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

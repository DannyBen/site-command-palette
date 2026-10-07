(() => {
  const STORAGE_SCHEMA_VERSION = 3;
  const STORAGE_SCHEMA_VERSION_KEY = "storageSchemaVersion";
  const COMMANDS_STORAGE_KEY = "commandsByHostname";
  const SITES_STORAGE_KEY = "sitesByHostname";
  const SETTINGS_STORAGE_KEY = "settings";
  const HISTORY_ENABLED_STORAGE_KEY = "historyEnabled";
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

  function normalizeHostname(value) {
    const input = typeof value === "string" ? value.trim() : "";
    if (!input) return null;

    try {
      const url = new URL(input.includes("://") ? input : `https://${input}`);
      if (!["http:", "https:"].includes(url.protocol) || url.hostname.includes("*")) return null;
      return url.hostname.toLocaleLowerCase();
    } catch {
      return null;
    }
  }

  function historySearchPrefix(query) {
    const input = query.trim().toLocaleLowerCase();
    return input.length < 3 ? "" : input.slice(0, 3);
  }

  function rankHistory(items, { query = "", hostname = null, excludedUrls = [], limit = 10 } = {}) {
    query = query.trim();
    if (!query) return [];
    const excluded = new Set(excludedUrls.map(normalizeUrl));
    const needle = query.toLocaleLowerCase();
    const compactQuery = query.replace(/\s+/g, "");
    const matchHistory = (candidate) => fuzzyMatch(
      candidate.toLocaleLowerCase().includes(needle) ? query : compactQuery,
      candidate
    );
    const seen = new Set();
    return items.flatMap((item) => {
      const url = normalizeUrl(item.url);
      if (!url || excluded.has(url) || seen.has(url)) return [];
      const host = new URL(url).hostname;
      if (hostname && host !== hostname) return [];
      seen.add(url);
      const name = item.title?.trim() || url;
      const urlMatch = matchHistory(url);
      const titleMatch = urlMatch ? null : matchHistory(name);
      if (!urlMatch && !titleMatch) return [];
      const candidate = (urlMatch ? url : name).toLocaleLowerCase();
      const exact = candidate.includes(needle) || candidate.includes(compactQuery.toLocaleLowerCase());
      const quality = (urlMatch ? 2 : 0) + (exact ? 1 : 0);
      return [{
        type: "history", id: `history:${url}`, name, url, detail: url,
        quality, score: (urlMatch ?? titleMatch).score, urlMatch
      }];
    }).sort((left, right) => right.quality - left.quality || right.score - left.score ||
      left.url.length - right.url.length || left.url.localeCompare(right.url))
      .slice(0, limit).map((item) => ({
        ...item,
        match: matchHistory(item.name) ?? { score: 0, indices: [] },
        detailIndices: item.urlMatch?.indices ?? []
      }));
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
    // Continuing a run outweighs jumping to a new word's start (+4).
    const consecutiveBonus = 5;
    const gapPenalty = 1;
    const startPenalty = 0.5;
    let exactState = null;
    let exactIndex = haystack.indexOf(needle);

    while (exactIndex !== -1) {
      const indices = Array.from(
        { length: needle.length },
        (_, index) => exactIndex + index
      );
      const wordStartBonus = exactIndex === 0 || /[\s/_-]/.test(haystack[exactIndex - 1])
        ? 4
        : 0;
      exactState = betterFuzzyState(exactState, {
        score: needle.length + wordStartBonus + (needle.length - 1) * consecutiveBonus -
          exactIndex * startPenalty,
        indices
      });
      exactIndex = haystack.indexOf(needle, exactIndex + 1);
    }

    if (exactState) {
      const prefixBonus = exactState.indices[0] === 0 ? 8 : 0;
      return {
        score: exactState.score + prefixBonus - haystack.length * 0.01,
        indices: exactState.indices
      };
    }

    let previousStates = Array(haystack.length).fill(null);

    for (let needleIndex = 0; needleIndex < needle.length; needleIndex += 1) {
      const currentStates = Array(haystack.length).fill(null);
      let bestSeparatedState = null;

      for (let index = 0; index < haystack.length; index += 1) {
        if (index >= 2 && previousStates[index - 2]) {
          const state = previousStates[index - 2];
          // Account for each predecessor's position so extending the gap costs
          // one point per skipped character without rescanning all predecessors.
          bestSeparatedState = betterFuzzyState(
            bestSeparatedState,
            { score: state.score + (index - 2) * gapPenalty, indices: state.indices }
          );
        }
        if (haystack[index] !== needle[needleIndex]) continue;

        let characterScore = 1;
        if (index === 0 || /[\s/_-]/.test(haystack[index - 1])) characterScore += 4;

        if (needleIndex === 0) {
          currentStates[index] = { score: characterScore - index * startPenalty, indices: [index] };
          continue;
        }

        const consecutiveState = index > 0 && previousStates[index - 1]
          ? {
              score: previousStates[index - 1].score + characterScore + consecutiveBonus,
              indices: [...previousStates[index - 1].indices, index]
            }
          : null;
        const separatedState = bestSeparatedState
          ? {
              score: bestSeparatedState.score + characterScore - (index - 1) * gapPenalty,
              indices: [...bestSeparatedState.indices, index]
            }
          : null;
        currentStates[index] = betterFuzzyState(consecutiveState, separatedState);
      }

      previousStates = currentStates;
    }

    const bestState = previousStates.reduce(betterFuzzyState, null);
    if (!bestState) return null;

    return {
      score: bestState.score - haystack.length * 0.01,
      indices: bestState.indices
    };
  }

  function betterFuzzyState(left, right) {
    if (!left) return right;
    if (!right) return left;
    if (left.score !== right.score) return left.score > right.score ? left : right;

    for (let index = 0; index < left.indices.length; index += 1) {
      if (left.indices[index] !== right.indices[index]) {
        return left.indices[index] < right.indices[index] ? left : right;
      }
    }
    return left;
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
    const disabledHostnames = [...new Set(
      (Array.isArray(storedSettings.disabledHostnames) ? storedSettings.disabledHostnames : [])
        .map(normalizeHostname)
        .filter(Boolean)
    )];

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
      disabledHostnames,
      historyResultLimit: [3, 5, 10, 15, 20].includes(storedSettings.historyResultLimit)
        ? storedSettings.historyResultLimit
        : 10,
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

  function siteNameForUrl(sites, urlValue) {
    const hostname = siteIdentity(urlValue);
    return sites[hostname]?.name ?? hostname ?? "Site";
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

  function isCommandExternal(command, locationValue) {
    if (siteIdentity(command.url) === siteIdentity(locationValue)) return false;
    const scope = normalizeScope(command.scope);
    return !scope || scope === "*" || !scopeMatches(scope, locationValue);
  }

  function resolveAllCommands(commandsByScope) {
    return Object.entries(commandsByScope)
      .flatMap(([scope, commands]) => commands.map((command) => ({ ...command, scope })));
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

  function isSiteDisabled(settings, locationValue) {
    const hostname = normalizeHostname(locationValue?.href ?? locationValue);
    return hostname !== null && settings.disabledHostnames.includes(hostname);
  }

  const api = Object.freeze({
    COMMANDS_STORAGE_KEY,
    DEFAULT_KEY_BINDINGS,
    HISTORY_ENABLED_STORAGE_KEY,
    SETTINGS_STORAGE_KEY,
    SITES_STORAGE_KEY,
    STORAGE_SCHEMA_VERSION,
    STORAGE_SCHEMA_VERSION_KEY,
    commandNameKey,
    findCommandNameConflict,
    formatBackupDate,
    formatKeyBinding,
    fuzzyMatch,
    historySearchPrefix,
    keyBindingFromEvent,
    keyBindingHasModifier,
    isSiteDisabled,
    isCommandExternal,
    matchesKeyBinding,
    migrateStorage,
    middleEllipsis,
    normalizeCommandsByScope,
    normalizeHostname,
    normalizeKeyBinding,
    normalizeKeyBindings,
    normalizeSettings,
    normalizeSites,
    normalizeScope,
    normalizeUrl,
    resolveAllCommands,
    rankHistory,
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

(() => {
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
      theme: storedSettings.theme === "dark" ? "dark" : "light",
      siteThemes
    };
  }

  const api = Object.freeze({
    compactUrl,
    fuzzyMatch,
    middleEllipsis,
    normalizeSettings,
    normalizeUrl
  });

  globalThis.SiteCommandPaletteCore = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

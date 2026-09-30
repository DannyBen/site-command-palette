const test = require("node:test");
const assert = require("node:assert/strict");

const {
  COMMANDS_STORAGE_KEY,
  DEFAULT_KEY_BINDINGS,
  SITES_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
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
  normalizeScope,
  normalizeSettings,
  normalizeSites,
  normalizeUrl,
  resolveCommandsForLocation,
  resolveTheme,
  scopeMatches,
  siteIdentity,
  siteNameForUrl,
  suggestPageName,
  suggestSiteName,
  urlMatchesPage
} = require("../core.js");

test("normalizeUrl accepts HTTP URLs and rejects unsafe protocols", () => {
  assert.equal(normalizeUrl("https://example.com/docs"), "https://example.com/docs");
  assert.equal(normalizeUrl("http://example.com"), "http://example.com/");
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("not a URL"), null);
});

test("normalizeScope keeps compact hostname and path glob patterns", () => {
  assert.equal(normalizeScope(" GitHub.COM "), "github.com");
  assert.equal(normalizeScope("https://pages.github.com/dannyben/*"), "pages.github.com/dannyben/*");
  assert.equal(normalizeScope("*"), "*");
  assert.equal(normalizeScope("https://github.com/?tab=repositories"), "github.com");
  assert.equal(normalizeScope("not a scope"), null);
});

test("scopeMatches uses whole-value glob semantics", () => {
  assert.equal(scopeMatches("github.com", "https://github.com/openai"), true);
  assert.equal(scopeMatches("github.com", "https://docs.github.com"), false);
  assert.equal(scopeMatches("*.google.com", "https://mail.google.com/inbox"), true);
  assert.equal(scopeMatches("*.google.com", "https://google.com"), false);
  assert.equal(scopeMatches("*google.com", "https://google.com"), true);
  assert.equal(scopeMatches("*google.com", "https://mail.google.com"), true);
  assert.equal(scopeMatches("*google.com", "https://notgoogle.com"), true);
  assert.equal(scopeMatches("pages.github.com/dannyben/*", "https://pages.github.com/dannyben/project"), true);
  assert.equal(scopeMatches("pages.github.com/dannyben/*", "https://pages.github.com/other/project"), false);
  assert.equal(scopeMatches("*", "https://example.com/anything"), true);
});

test("normalizeCommandsByScope preserves exact, global, and wildcard collections", () => {
  assert.deepEqual(normalizeCommandsByScope({
    "EXAMPLE.COM": [{ id: "one", name: "One", url: "https://example.com/one" }],
    "*.example.com": [{ id: "two", name: "Two", url: "https://docs.example.com/two" }],
    "*": [{ id: "three", name: "Three", url: "https://elsewhere.test/three" }]
  }), {
    "example.com": [{ id: "one", page: "One", url: "https://example.com/one" }],
    "*.example.com": [{ id: "two", page: "Two", url: "https://docs.example.com/two" }],
    "*": [{ id: "three", page: "Three", url: "https://elsewhere.test/three" }]
  });
});

test("normalizeCommandsByScope repairs duplicate command IDs", () => {
  assert.deepEqual(normalizeCommandsByScope({
    "example.com": [
      { id: "duplicate", name: "One", url: "https://example.com/one" },
      { id: "duplicate", name: "Two", url: "https://example.com/two" },
      { id: "duplicate-2", name: "Three", url: "https://example.com/three" }
    ]
  }), {
    "example.com": [
      { id: "duplicate", page: "One", url: "https://example.com/one" },
      { id: "duplicate-3", page: "Two", url: "https://example.com/two" },
      { id: "duplicate-2", page: "Three", url: "https://example.com/three" }
    ]
  });
});

test("command names compare without case or repeated whitespace", () => {
  assert.equal(commandNameKey("  GitHub   Issues "), "github issues");
  assert.equal(commandNameKey(null), "");
});

test("findCommandNameConflict checks page names within one destination site and scope", () => {
  const commandsByScope = {
    "example.com": [
      { id: "one", page: "Issues", url: "https://github.com/issues" },
      { id: "two", page: "Issues", url: "https://gitlab.com/issues" }
    ],
    "*": [
      { id: "three", page: "Issues", url: "https://github.com/" }
    ]
  };

  assert.equal(
    findCommandNameConflict(
      commandsByScope,
      "example.com",
      " issues ",
      "https://github.com/pulls"
    ).id,
    "one"
  );
  assert.equal(
    findCommandNameConflict(
      commandsByScope,
      "example.com",
      "Issues",
      "https://github.com/issues",
      "one"
    ),
    null
  );
  assert.equal(
    findCommandNameConflict(
      commandsByScope,
      "other.example",
      "Issues",
      "https://github.com/issues"
    ),
    null
  );
});

test("resolveCommandsForLocation applies the most specific named override", () => {
  const commands = resolveCommandsForLocation({
    "*": [
      { id: "global", page: "Home", url: "https://github.com/" },
      { id: "alias", page: "Source hosting", url: "https://github.com/" }
    ],
    "github.com": [
      { id: "site", page: "Home", url: "https://github.com/openai" }
    ],
    "github.com/openai/*": [
      { id: "path", page: "Home", url: "https://github.com/openai/issues" }
    ]
  }, "https://github.com/openai/project");

  assert.deepEqual(commands.map(({ id }) => id), ["alias", "path"]);
});

test("resolveCommandsForLocation preserves ambiguous equal-specificity commands", () => {
  const commands = resolveCommandsForLocation({
    "*hub.com": [{ id: "one", page: "Home", url: "https://github.com/one" }],
    "github.*": [{ id: "two", page: "home", url: "https://github.com/two" }]
  }, "https://github.com/");

  assert.deepEqual(commands.map(({ id }) => id), ["one", "two"]);
});

test("fuzzyMatch returns matched character indices", () => {
  const match = fuzzyMatch("bsh", "Bashly");

  assert.deepEqual(match.indices, [0, 2, 3]);
  assert.equal(fuzzyMatch("xyz", "Bashly"), null);
  assert.ok(fuzzyMatch("bash", "Bashly").score > fuzzyMatch("bsh", "Bashly").score);
});

test("fuzzyMatch selects the strongest character sequence", () => {
  assert.deepEqual(
    fuzzyMatch("bash", "Github › Bashly").indices,
    [9, 10, 11, 12]
  );
  assert.deepEqual(
    fuzzyMatch("bash", "Bashly › Home").indices,
    [0, 1, 2, 3]
  );
  assert.deepEqual(
    fuzzyMatch("gitbash", "Github › Bashly").indices,
    [0, 1, 2, 9, 10, 11, 12]
  );
  assert.deepEqual(
    fuzzyMatch("gireba", "Github › Repo › Bashly").indices,
    [0, 1, 9, 10, 16, 17]
  );
});

test("middleEllipsis preserves both ends at the requested length", () => {
  assert.equal(middleEllipsis("short", 10), "short");

  const compact = middleEllipsis("abcdefghijklmnopqrstuvwxyz", 12);
  assert.equal(compact.length, 12);
  assert.match(compact, /^abcdef…vwxyz$/);
});

test("site identities use normalized destination hostnames", () => {
  assert.equal(siteIdentity("https://www.github.com/openai"), "github.com");
  assert.equal(siteIdentity("https://mail.google.com/#inbox"), "mail.google.com");
  assert.equal(siteIdentity("javascript:alert(1)"), null);
});

test("site and page names are suggested from titles and SPA routes", () => {
  const gmail = "https://mail.google.com/mail/u/0/#inbox";

  assert.equal(suggestSiteName(gmail, "Inbox - person@gmail.com - Gmail"), "Gmail");
  assert.equal(suggestSiteName("https://github.com/"), "Github");
  assert.equal(suggestPageName(gmail), "Inbox");
  assert.equal(suggestPageName("https://github.com/openai/codex"), "Codex");
  assert.equal(suggestPageName("https://github.com/"), "Home");
});

test("site names are shared by destination identity", () => {
  const sites = normalizeSites({
    "MAIL.GOOGLE.COM": { name: " Gmail " },
    "invalid host": { name: "Invalid" },
    "empty.example": { name: "" }
  });

  assert.deepEqual(sites, { "mail.google.com": { name: "Gmail" } });
  assert.equal(
    siteNameForUrl(sites, "https://mail.google.com/mail/u/0/#spam"),
    "Gmail"
  );
});

test("urlMatchesPage compares normalized HTTP URLs exactly", () => {
  assert.equal(
    urlMatchesPage("https://example.com", "https://example.com/"),
    true
  );
  assert.equal(
    urlMatchesPage("https://example.com/page", { href: "https://example.com/page" }),
    true
  );
  assert.equal(
    urlMatchesPage("https://example.com/page#one", "https://example.com/page#two"),
    false
  );
  assert.equal(urlMatchesPage("not a URL", "https://example.com/"), false);
});

test("formatBackupDate uses an unambiguous long date and 24-hour time", () => {
  const formatted = formatBackupDate("2026-09-09T12:34:00Z");

  assert.match(formatted, /^September 9, 2026 at \d{2}:\d{2}$/);
  assert.equal(formatBackupDate("not a date"), "Unknown date");
});

test("key bindings normalize, display, and match keyboard events", () => {
  const event = {
    code: "KeyK",
    ctrlKey: true,
    altKey: false,
    shiftKey: true,
    metaKey: false
  };

  assert.equal(keyBindingFromEvent(event), "Ctrl+Shift+KeyK");
  assert.equal(formatKeyBinding("Ctrl+Shift+KeyK"), "Ctrl + Shift + K");
  assert.equal(matchesKeyBinding(event, "Ctrl+Shift+KeyK"), true);
  assert.equal(matchesKeyBinding(event, "Alt+KeyK"), false);
  assert.equal(keyBindingHasModifier("Alt+Backquote"), true);
  assert.equal(keyBindingHasModifier("Backquote"), false);
});

test("normalizeSettings supplies defaults and discards invalid values", () => {
  assert.deepEqual(normalizeSettings(), {
    version: 1,
    theme: "light",
    siteThemes: {},
    keyBindings: { ...DEFAULT_KEY_BINDINGS }
  });
  assert.deepEqual(
    normalizeSettings({
      theme: "dark",
      siteThemes: {
        "dark.example": "dark",
        "light.example": "light",
        "invalid.example": "blue"
      },
      keyBindings: {
        toggleAlternate: null,
        add: "Ctrl+Shift+KeyK",
        edit: "invalid shortcut"
      }
    }),
    {
      version: 1,
      theme: "dark",
      siteThemes: {
        "dark.example": "dark",
        "light.example": "light"
      },
      keyBindings: {
        ...DEFAULT_KEY_BINDINGS,
        toggleAlternate: null,
        add: "Ctrl+Shift+KeyK"
      }
    }
  );

  assert.equal(normalizeSettings({ theme: "system" }).theme, "system");
});

test("resolveTheme gives site overrides precedence and resolves System", () => {
  const settings = normalizeSettings({
    theme: "system",
    siteThemes: { "light.example": "light" }
  });

  assert.equal(resolveTheme(settings, "dark.example", true), "dark");
  assert.equal(resolveTheme(settings, "dark.example", false), "light");
  assert.equal(resolveTheme(settings, "light.example", true), "light");
});

test("migrateStorage upgrades legacy data and normalizes saved commands", () => {
  const migration = migrateStorage({
    commandsByHostname: {
      "example.com": [
        { id: " command-1 ", name: " Documentation ", url: "https://example.com/docs" },
        { id: "unsafe", name: "Unsafe", url: "javascript:alert(1)" },
        { id: "missing-name", name: "", url: "https://example.com" }
      ],
      invalid: "not a command list"
    },
    settings: {
      theme: "dark",
      siteThemes: { "example.com": "light" }
    }
  });

  assert.equal(migration.migrated, true);
  assert.equal(migration.previousVersion, 0);
  assert.equal(migration.data[STORAGE_SCHEMA_VERSION_KEY], 3);
  assert.deepEqual(migration.data[COMMANDS_STORAGE_KEY], {
    "example.com": [
      { id: "command-1", page: "Documentation", url: "https://example.com/docs" }
    ]
  });
  assert.deepEqual(migration.data[SITES_STORAGE_KEY], {
    "example.com": { name: "Example" }
  });
  assert.deepEqual(migration.data[SETTINGS_STORAGE_KEY], {
    version: 1,
    theme: "dark",
    siteThemes: { "example.com": "light" },
    keyBindings: { ...DEFAULT_KEY_BINDINGS }
  });
});

test("migrateStorage leaves the current schema current and rejects future data", () => {
  const previous = migrateStorage({
    storageSchemaVersion: 1,
    commandsByHostname: {},
    settings: {}
  });
  const current = migrateStorage({
    storageSchemaVersion: 3,
    commandsByHostname: {},
    sitesByHostname: {},
    settings: { theme: "light", siteThemes: {} }
  });

  assert.equal(previous.migrated, true);
  assert.equal(previous.previousVersion, 1);
  assert.equal(previous.data.storageSchemaVersion, 3);
  assert.equal(current.migrated, false);
  assert.throws(
    () => migrateStorage({ storageSchemaVersion: 4 }),
    /Unsupported storage schema version: 4/
  );
});

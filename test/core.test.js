const test = require("node:test");
const assert = require("node:assert/strict");

const {
  COMMANDS_STORAGE_KEY,
  DEFAULT_KEY_BINDINGS,
  SETTINGS_STORAGE_KEY,
  STORAGE_SCHEMA_VERSION_KEY,
  commandHint,
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
  normalizeUrl,
  resolveCommandsForLocation,
  resolveTheme,
  scopeMatches
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
    "example.com": [{ id: "one", name: "One", url: "https://example.com/one" }],
    "*.example.com": [{ id: "two", name: "Two", url: "https://docs.example.com/two" }],
    "*": [{ id: "three", name: "Three", url: "https://elsewhere.test/three" }]
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
      { id: "duplicate", name: "One", url: "https://example.com/one" },
      { id: "duplicate-3", name: "Two", url: "https://example.com/two" },
      { id: "duplicate-2", name: "Three", url: "https://example.com/three" }
    ]
  });
});

test("command names compare without case or repeated whitespace", () => {
  assert.equal(commandNameKey("  GitHub   Issues "), "github issues");
  assert.equal(commandNameKey(null), "");
});

test("findCommandNameConflict checks one scope and can exclude an edited command", () => {
  const commandsByScope = {
    "example.com": [
      { id: "one", name: "GitHub Issues", url: "https://github.com/issues" }
    ],
    "*": [
      { id: "two", name: "GitHub Issues", url: "https://github.com/" }
    ]
  };

  assert.equal(
    findCommandNameConflict(commandsByScope, "example.com", "github   issues").id,
    "one"
  );
  assert.equal(findCommandNameConflict(commandsByScope, "example.com", "GitHub Issues", "one"), null);
  assert.equal(findCommandNameConflict(commandsByScope, "other.example", "GitHub Issues"), null);
});

test("resolveCommandsForLocation applies the most specific named override", () => {
  const commands = resolveCommandsForLocation({
    "*": [
      { id: "global", name: "GitHub", url: "https://github.com/" },
      { id: "alias", name: "Source hosting", url: "https://github.com/" }
    ],
    "github.com": [
      { id: "site", name: "github", url: "https://github.com/openai" }
    ],
    "github.com/openai/*": [
      { id: "path", name: "GitHub", url: "https://github.com/openai/issues" }
    ]
  }, "https://github.com/openai/project");

  assert.deepEqual(commands.map(({ id }) => id), ["alias", "path"]);
});

test("resolveCommandsForLocation preserves ambiguous equal-specificity commands", () => {
  const commands = resolveCommandsForLocation({
    "*hub.com": [{ id: "one", name: "GitHub", url: "https://github.com/one" }],
    "github.*": [{ id: "two", name: "github", url: "https://github.com/two" }]
  }, "https://github.com/");

  assert.deepEqual(commands.map(({ id }) => id), ["one", "two"]);
});

test("fuzzyMatch returns matched character indices", () => {
  const match = fuzzyMatch("bsh", "Bashly");

  assert.deepEqual(match.indices, [0, 2, 3]);
  assert.equal(fuzzyMatch("xyz", "Bashly"), null);
  assert.ok(fuzzyMatch("bash", "Bashly").score > fuzzyMatch("bsh", "Bashly").score);
});

test("middleEllipsis preserves both ends at the requested length", () => {
  assert.equal(middleEllipsis("short", 10), "short");

  const compact = middleEllipsis("abcdefghijklmnopqrstuvwxyz", 12);
  assert.equal(compact.length, 12);
  assert.match(compact, /^abcdef…vwxyz$/);
});

test("commandHint uses hostnames for global and wildcard commands", () => {
  const location = "https://example.com/current";

  assert.equal(commandHint("https://github.com/", "*", location), "github.com");
  assert.equal(
    commandHint("https://www.github.com/openai", "*.github.com", location),
    "github.com"
  );
});

test("commandHint uses paths for same-site commands and a hostname for the root", () => {
  const location = "https://github.com/openai/project";

  assert.equal(
    commandHint("https://github.com/issues?state=open#mine", "github.com", location),
    "/issues"
  );
  assert.equal(commandHint("https://github.com/", "github.com", location), "github.com");
  assert.equal(
    commandHint("https://github.com/openai/project", "github.com/openai/*", location),
    "/openai/project"
  );
});

test("commandHint uses the destination hostname for cross-site commands", () => {
  assert.equal(
    commandHint(
      "https://docs.github.com/en/get-started",
      "github.com",
      "https://github.com/openai"
    ),
    "docs.github.com"
  );
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
  assert.equal(migration.data[STORAGE_SCHEMA_VERSION_KEY], 2);
  assert.deepEqual(migration.data[COMMANDS_STORAGE_KEY], {
    "example.com": [
      { id: "command-1", name: "Documentation", url: "https://example.com/docs" }
    ]
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
    storageSchemaVersion: 2,
    commandsByHostname: {},
    settings: { theme: "light", siteThemes: {} }
  });

  assert.equal(previous.migrated, true);
  assert.equal(previous.previousVersion, 1);
  assert.equal(previous.data.storageSchemaVersion, 2);
  assert.equal(current.migrated, false);
  assert.throws(
    () => migrateStorage({ storageSchemaVersion: 3 }),
    /Unsupported storage schema version: 3/
  );
});

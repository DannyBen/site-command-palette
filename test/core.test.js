const test = require("node:test");
const assert = require("node:assert/strict");

const {
  COMMANDS_STORAGE_KEY,
  SETTINGS_STORAGE_KEY,
  STORAGE_SCHEMA_VERSION_KEY,
  compactUrl,
  formatBackupDate,
  fuzzyMatch,
  migrateStorage,
  middleEllipsis,
  normalizeSettings,
  normalizeUrl,
  resolveTheme
} = require("../core.js");

test("normalizeUrl accepts HTTP URLs and rejects unsafe protocols", () => {
  assert.equal(normalizeUrl("https://example.com/docs"), "https://example.com/docs");
  assert.equal(normalizeUrl("http://example.com"), "http://example.com/");
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("not a URL"), null);
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

test("compactUrl removes the origin and retains route information", () => {
  assert.equal(
    compactUrl("https://example.com/path/to/page?mode=edit#section"),
    "/path/to/page?mode=edit#section"
  );

  const compact = compactUrl(`https://example.com/${"segment/".repeat(10)}`);
  assert.equal(compact.length, 42);
  assert.ok(compact.includes("…"));
  assert.ok(!compact.includes("example.com"));
});

test("formatBackupDate uses an unambiguous long date and 24-hour time", () => {
  const formatted = formatBackupDate("2026-09-09T12:34:00Z");

  assert.match(formatted, /^September 9, 2026 at \d{2}:\d{2}$/);
  assert.equal(formatBackupDate("not a date"), "Unknown date");
});

test("normalizeSettings supplies defaults and discards invalid themes", () => {
  assert.deepEqual(normalizeSettings(), { version: 1, theme: "light", siteThemes: {} });
  assert.deepEqual(
    normalizeSettings({
      theme: "dark",
      siteThemes: {
        "dark.example": "dark",
        "light.example": "light",
        "invalid.example": "blue"
      }
    }),
    {
      version: 1,
      theme: "dark",
      siteThemes: {
        "dark.example": "dark",
        "light.example": "light"
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
  assert.equal(migration.data[STORAGE_SCHEMA_VERSION_KEY], 1);
  assert.deepEqual(migration.data[COMMANDS_STORAGE_KEY], {
    "example.com": [
      { id: "command-1", name: "Documentation", url: "https://example.com/docs" }
    ]
  });
  assert.deepEqual(migration.data[SETTINGS_STORAGE_KEY], {
    version: 1,
    theme: "dark",
    siteThemes: { "example.com": "light" }
  });
});

test("migrateStorage leaves the current schema current and rejects future data", () => {
  const current = migrateStorage({
    storageSchemaVersion: 1,
    commandsByHostname: {},
    settings: { theme: "light", siteThemes: {} }
  });

  assert.equal(current.migrated, false);
  assert.throws(
    () => migrateStorage({ storageSchemaVersion: 2 }),
    /Unsupported storage schema version: 2/
  );
});

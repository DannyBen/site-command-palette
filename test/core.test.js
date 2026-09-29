const test = require("node:test");
const assert = require("node:assert/strict");

const {
  compactUrl,
  fuzzyMatch,
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

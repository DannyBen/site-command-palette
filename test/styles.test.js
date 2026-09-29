const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const stylesheets = ["options.css", "palette.css"].map((filename) => ({
  filename,
  source: fs.readFileSync(path.join(__dirname, "..", filename), "utf8")
}));

test("stylesheet color literals are defined as reusable tokens", () => {
  const colorLiteral = /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i;

  for (const { filename, source } of stylesheets) {
    source.split("\n").forEach((line, index) => {
      if (!colorLiteral.test(line)) return;

      assert.match(
        line.trim(),
        /^--[a-z0-9-]+:/,
        `${filename}:${index + 1} contains a color outside the theme tokens`
      );
    });
  }
});

test("palette and settings share one accent and state color system", () => {
  const sharedTokens = [
    "text-color",
    "muted-text-color",
    "accent-color",
    "accent-hover-color",
    "accent-background-color",
    "accent-text-color",
    "focus-ring-color",
    "danger-color",
    "danger-background-color",
    "border-color"
  ];
  const [options, palette] = stylesheets;

  for (const token of sharedTokens) {
    assert.deepEqual(
      tokenValues(palette.source, token),
      tokenValues(options.source, token),
      `${token} should match in ${palette.filename} and ${options.filename}`
    );
  }
});

function tokenValues(source, token) {
  const pattern = new RegExp(`--${token}:\\s*([^;]+);`, "g");
  return [...source.matchAll(pattern)].map((match) => match[1].trim());
}

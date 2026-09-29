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

test("palette and settings share action, interaction, and state colors", () => {
  const sharedTokens = [
    "text-color",
    "muted-text-color",
    "accent-color",
    "accent-hover-color",
    "accent-text-color",
    "interaction-color",
    "text-selection-background-color",
    "focus-ring-color",
    "action-focus-ring-color",
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

test("action colors stay distinct from selection and focus colors", () => {
  for (const { filename, source } of stylesheets) {
    const accents = tokenValues(source, "accent-color");
    const interactions = tokenValues(source, "interaction-color");
    const selections = tokenValues(source, "text-selection-background-color");
    const focusRings = tokenValues(source, "focus-ring-color");
    const actionFocusRings = tokenValues(source, "action-focus-ring-color");

    for (let index = 0; index < accents.length; index += 1) {
      assert.notEqual(
        interactions[index],
        accents[index],
        `${filename} focus should not use green`
      );
      assert.notEqual(
        selections[index],
        accents[index],
        `${filename} selection should not use green`
      );
      assert.notEqual(
        focusRings[index],
        actionFocusRings[index],
        `${filename} fields and action buttons should use different focus rings`
      );
    }
  }
});

test("palette uses separate text and list selection colors", () => {
  const palette = stylesheets.find(({ filename }) => filename === "palette.css");
  const textSelections = tokenValues(palette.source, "text-selection-background-color");
  const listSelections = tokenValues(palette.source, "list-selection-background-color");

  assert.equal(textSelections.length, 2);
  assert.equal(listSelections.length, 2);
  assert.notDeepEqual(textSelections, listSelections);
});

function tokenValues(source, token) {
  const pattern = new RegExp(`--${token}:\\s*([^;]+);`, "g");
  return [...source.matchAll(pattern)].map((match) => match[1].trim());
}

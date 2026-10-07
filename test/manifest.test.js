const test = require("node:test");
const assert = require("node:assert/strict");
const { access, readFile } = require("node:fs/promises");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

test("manifest is valid and references existing packaged files", async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "manifest.json"), "utf8"));
  const packageMetadata = JSON.parse(await readFile(path.join(projectRoot, "package.json"), "utf8"));

  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.version, "0.3.1");
  assert.equal(packageMetadata.version, manifest.version);
  assert.ok(manifest.permissions.includes("storage"));
  assert.deepEqual(manifest.permissions, ["storage", "activeTab"]);
  assert.deepEqual(manifest.optional_permissions, ["history"]);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.deepEqual(manifest.content_scripts[0].js, ["core.js", "storage.js", "content.js"]);
  assert.deepEqual(manifest.content_scripts[0].matches, ["http://*/*", "https://*/*"]);
  assert.deepEqual(manifest.icons, {
    16: "support/icons/icon-16.png",
    32: "support/icons/icon-32.png",
    48: "support/icons/icon-48.png",
    128: "support/icons/icon-128.png"
  });

  const referencedFiles = [
    ...manifest.content_scripts.flatMap((entry) => [...(entry.js ?? []), ...(entry.css ?? [])]),
    manifest.action.default_popup, "popup.js", "popup.css",
    ...manifest.web_accessible_resources.flatMap((entry) => entry.resources),
    ...Object.values(manifest.icons),
    manifest.background.service_worker,
    manifest.options_ui.page,
    "options.css",
    "options.js",
    "backup.js",
    "storage.js"
  ];

  await Promise.all(referencedFiles.map((file) => access(path.join(projectRoot, file))));
});

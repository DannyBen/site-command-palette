const test = require("node:test");
const assert = require("node:assert/strict");
const { access, readFile } = require("node:fs/promises");
const path = require("node:path");

const projectRoot = path.resolve(__dirname, "..");

test("manifest is valid and references existing packaged files", async () => {
  const manifest = JSON.parse(await readFile(path.join(projectRoot, "manifest.json"), "utf8"));

  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.permissions.includes("storage"));
  assert.deepEqual(manifest.content_scripts[0].js, ["core.js", "content.js"]);

  const referencedFiles = [
    ...manifest.content_scripts.flatMap((entry) => [...(entry.js ?? []), ...(entry.css ?? [])]),
    ...manifest.web_accessible_resources.flatMap((entry) => entry.resources)
  ];

  await Promise.all(referencedFiles.map((file) => access(path.join(projectRoot, file))));
});

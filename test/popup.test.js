const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const core = require("../core.js");
const source = readFileSync(require.resolve("../popup.js"), "utf8");

async function renderPopup({ url = "https://example.com/page", allSites = false, thisSite = false,
  disabledHostnames = [], backupStatus } = {}) {
  const elements = new Map();
  const queries = [];
  const context = {
    URL,
    console,
    document: {
      getElementById(id) {
        if (!elements.has(id)) elements.set(id, {
          hidden: true, dataset: {}, addEventListener() {}
        });
        return elements.get(id);
      }
    },
    SiteCommandPaletteCore: core,
    SiteCommandPaletteStorage: {
      loadStorage: async () => ({ settings: core.normalizeSettings({ disabledHostnames }) })
    },
    chrome: {
      storage: {
        local: { get: async () => ({ backupStatus }) },
        onChanged: { addListener() {} }
      },
      tabs: { query: async () => [{ url }] },
      permissions: {
        contains: async ({ origins }) => {
          queries.push(Array.from(origins));
          return origins.length === 2 ? allSites : thisSite;
        }
      },
      runtime: { openOptionsPage() {}, sendMessage() {} }
    }
  };
  vm.runInNewContext(source, context);
  await new Promise((resolve) => setImmediate(resolve));
  return { elements, queries };
}

test("popup distinguishes all-site access, site access, and withheld automatic access", async () => {
  for (const [permissions, text, state] of [
    [{ allSites: true, thisSite: true }, "All sites", "allowed"],
    [{ thisSite: true }, "This site", "allowed"],
    [{}, "Not enabled here", "withheld"]
  ]) {
    const { elements, queries } = await renderPopup(permissions);
    assert.equal(elements.get("website-access").textContent, text);
    assert.equal(elements.get("website-access").dataset.state, state);
    assert.deepEqual(queries[1], ["https://example.com/*"]);
    assert.equal(elements.get("page-access-note").hidden, true);
  }
});

test("popup warns when automatic backups need permission or fail", async () => {
  for (const status of ["permission-required", "error", "active", "disabled"]) {
    const { elements } = await renderPopup({ backupStatus: { status } });
    assert.equal(elements.get("backup-warning").hidden, !["permission-required", "error"].includes(status));
  }
});

test("popup explains protected pages and sites disabled in Settings", async () => {
  for (const url of [undefined, "chrome://extensions/", "https://chromewebstore.google.com/detail/a"]) {
    const { elements } = await renderPopup({ url: url ?? "about:blank", allSites: true });
    assert.equal(elements.get("website-access").textContent, "All sites");
    assert.equal(elements.get("page-access-note").textContent, "The palette cannot run on this page.");
    assert.equal(elements.get("page-access-note").hidden, false);
  }
  const { elements } = await renderPopup({ thisSite: true, disabledHostnames: ["example.com"] });
  assert.equal(elements.get("page-access-note").textContent, "This website is disabled in Settings.");
});

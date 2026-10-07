const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { readFileSync } = require("node:fs");
const core = require("../core.js");
const { rankHistory, historySearchPrefix } = core;

const now = Date.UTC(2026, 9, 7);
const page = (url, visits = 1, extra = {}) => ({
  url, title: "Repository", visitCount: visits, lastVisitTime: now, ...extra
});

test("history ranks tighter, shorter URLs without using visit statistics or page titles", () => {
  const root = "https://github.com/dannyben/victor";
  const pulls = `${root}/pulls`;
  const pr = `${root}/pull/42`;
  const items = [page(pr, 100000, { typedCount: 1000, title: "Github Victor" }),
    page(pulls, 5000), page(root, 1, { lastVisitTime: 0, title: "A much longer repository title" })];
  for (const query of ["github victor", "githubvictor", "github/victor"]) {
    assert.deepEqual(rankHistory(items, { query }).map(item => item.url), [root, pulls, pr]);
  }
  assert.deepEqual(rankHistory(items, { query: "github victor pull" }).map(item => item.url), [pulls, pr]);
  assert.equal(rankHistory(items, { query: "github victor pull 42" })[0].url, pr);
});

test("exact URL matches outrank shorter fuzzy URLs, and titles provide a fallback", () => {
  const exact = "https://github.com/dannyben/victor";
  const fuzzy = "https://a.co/v-i-c-t-o-r";
  const title = "https://a.co/z";
  const results = rankHistory([page(fuzzy), page(title, 1, { title: "Victor" }), page(exact)], { query: "victor" });
  assert.deepEqual(results.map(item => item.url), [exact, fuzzy, title]);
  assert.deepEqual(results[2].match.indices, [0, 1, 2, 3, 4, 5]);
  assert.deepEqual(results[2].detailIndices, []);
});

test("history ranks an early Facebook domain match before a shorter deep path match", () => {
  const domain = "https://facebook.com/a-long-page-name";
  const path = "https://a.co/somewhere/facebook";
  assert.deepEqual(rankHistory([page(path), page(domain)], { query: "facebook" }).map(item => item.url),
    [domain, path]);
});

test("history balances tightness and position for joined domain and page searches", () => {
  const expected = [
    "https://gitdan.com/", "https://github.com/danny", "https://something.com/git/dan",
    "https://github.com/something/danny", "https://github.com/something/david/now"
  ];
  const items = [...expected].reverse().map(url => page(url));
  for (const query of ["gitdan", "git dan"]) {
    assert.deepEqual(rankHistory(items, { query }).map(item => item.url), expected);
  }
});

test("partial history queries keep letters together and prefer the shorter repository", () => {
  const root = "https://github.com/dannyben/victor";
  const cli = `${root}-cli`;
  const items = [page(cli), page(root)];
  for (const partial of ["vi", "vic", "vict", "victor"]) {
    for (const separator of [" ", "", "/"]) {
      const results = rankHistory(items, { query: `github${separator}${partial}` });
      assert.deepEqual(results.map(item => item.url), [root, cli]);
      for (const result of results) {
        const expected = Array.from({ length: partial.length }, (_, index) => root.indexOf("victor") + index);
        assert.deepEqual(result.detailIndices.slice(-partial.length), expected);
      }
    }
  }
  assert.deepEqual(rankHistory(items, { query: "github vic cli" }).map(item => item.url), [cli]);
});

test("site history uses the exact hostname and excludes saved, duplicate and unsupported URLs", () => {
  const results = rankHistory([
    page("https://github.com/saved"), page("https://github.com/unsaved"),
    page("https://github.com/unsaved"), page("https://gist.github.com/other"),
    page("https://example.com/?next=github.com"), page("chrome://history/"),
    page("javascript:alert(1)"), page("invalid")
  ], { query: "git", hostname: "github.com", excludedUrls: ["https://github.com/saved"], now });
  assert.deepEqual(results.map(item => item.url), ["https://github.com/unsaved"]);
  assert.equal(results[0].type, "history");
});

test("history has a URL fallback for missing titles and is limited to ten results", () => {
  const results = rankHistory(Array.from({ length: 20 }, (_, index) =>
    page(`https://github.com/${index}`, index, { title: "" })
  ), { query: "git", now });
  assert.equal(results.length, 10);
  assert.equal(results[0].url, "https://github.com/0");
  assert.equal(results[0].name, results[0].url);
});

test("history accepts spaced and joined site/page queries while preserving order", () => {
  const victor = "https://github.com/dannyben/victor";
  const items = [page(victor), page("https://github.com/dannyben/other"),
    page("https://example.com/victor"), page("https://victor.example.com/github")];
  for (const query of ["github victor", "githubvictor", "github/victor", "GITHUB   victor"]) {
    const results = rankHistory(items, { query, now });
    assert.deepEqual(results.map(item => item.url), [victor]);
    assert.equal(results[0].detailIndices.map(index => victor[index]).join("").replace(/\//g, ""),
      "githubvictor");
  }
  assert.equal(rankHistory([page(victor)], { query: "victor github", now }).length, 0);
  assert.equal(rankHistory([page(victor)], { query: "github nonexistent", now }).length, 0);
});

test("history requires three characters and keeps a fixed prefix for joined refinements", () => {
  for (const query of ["", " ", "h", "hi", "  hi  "]) {
    assert.equal(historySearchPrefix(query), "");
  }
  for (const query of ["github", "github danny", "githubdanny", "github/victor", " GITHUB "]) {
    assert.equal(historySearchPrefix(query), "git");
  }
  for (const query of ["dannyben", "dannyben vic", "dannybenvic"]) {
    assert.equal(historySearchPrefix(query), "dan");
  }
  assert.equal(historySearchPrefix("victor github"), "vic");
  assert.equal(historySearchPrefix("amazon"), "ama");
  assert.equal(historySearchPrefix("https://github.com/victor"), "htt");
});

async function worker({ granted = false, items = [], saved = {} } = {}) {
  const listeners = {};
  const searches = [];
  const stored = {};
  const context = {
    SiteCommandPaletteCore: core,
    SiteCommandPaletteStorage: { loadStorage: async () => ({ commandsByHostname: saved }) },
    SiteCommandPaletteBackup: { BACKUP_STATUS_KEY: "backupStatus", refreshBackupStatus: async () => {} },
    importScripts() {}, console,
    chrome: {
      runtime: {
        onMessage: { addListener: fn => { listeners.message = fn; } },
        onStartup: { addListener() {} }, onInstalled: { addListener() {} }
      },
      permissions: {
        contains: async () => granted,
        onAdded: { addListener: fn => { listeners.added = fn; } },
        onRemoved: { addListener: fn => { listeners.removed = fn; } }
      },
      history: { search: async query => { searches.push(query); return items; } },
      storage: {
        local: {
          get: async () => ({ commandsByHostname: saved }),
          set: async values => Object.assign(stored, values)
        },
        onChanged: { addListener() {} }
      }
    }
  };
  vm.runInNewContext(readFileSync(require.resolve("../background.js"), "utf8"), context);
  await new Promise(resolve => setImmediate(resolve));
  return {
    context, stored, searches,
    changeAccess(value) {
      granted = value;
      (value ? listeners.added : listeners.removed)({ permissions: ["history"] });
    },
    search(message = { query: "git" }, sender = { url: "https://github.com/", tab: {} }) {
      return new Promise(resolve => {
        assert.equal(listeners.message({ type: "search-history", ...message }, sender, resolve), true);
      });
    }
  };
}

test("history is never queried without permission or from incognito or extension pages", async () => {
  const script = await worker();
  assert.equal((await script.search()).candidates.length, 0);
  assert.equal(script.searches.length, 0);
  assert.equal(script.stored.historyEnabled, false);
  script.changeAccess(true);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(script.stored.historyEnabled, true);
  await script.search({ query: "git" }, { url: "https://github.com/", tab: { incognito: true } });
  await script.search({ query: "git" }, { url: "chrome-extension://id/options.html", tab: {} });
  await script.search({ query: "/settings" });
  assert.equal(script.searches.length, 0);
  script.changeAccess(false);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(script.stored.historyEnabled, false);
});

test("worker returns the complete prefix candidate set with only URLs and titles", async () => {
  const items = Array.from({ length: 120 }, (_, index) => page(`https://github.com/dannyben/victor/pull/${index}`));
  items.push(page("chrome://history/"));
  const script = await worker({ granted: true, items });
  const results = await script.search({ query: "github victor pull" });
  assert.equal(script.searches[0].text, "git");
  assert.equal(script.searches[0].startTime, 0);
  assert.equal(script.searches[0].maxResults, 0);
  assert.equal(results.candidates.length, 120, "cache must include entries beyond the ten visible results");
  assert.deepEqual(Object.keys(results.candidates[0]), ["url", "title"]);
  assert.equal(rankHistory(results.candidates, { query: "github victor pull 119" })[0].url,
    "https://github.com/dannyben/victor/pull/119");
});

test("searches shorter than three characters never query history", async () => {
  const script = await worker({ granted: true, items: [page("https://github.com/usual")] });
  for (const query of [undefined, "", "   ", "h", "hi", "  hi  "]) {
    assert.equal((await script.search({ query })).candidates.length, 0);
  }
  assert.equal(script.searches.length, 0);
  for (const query of [undefined, "", "   "]) {
    assert.deepEqual(rankHistory([page("https://github.com/usual")], { query }), []);
  }
});

test("fixed-prefix retrieval works on other sites and retains candidates for both scopes", async () => {
  const victor = "https://github.com/dannyben/victor";
  const script = await worker({ granted: true, items: [page(victor), page("https://example.com/victor")] });
  for (const scope of ["site", "all"]) {
    for (const query of ["githubdanny", "github danny", "dannybenvic", "dannyben vic"]) {
      const result = await script.search({ query, scope }, { url: "https://example.com/", tab: {} });
      assert.equal(script.searches.at(-1).text, query.slice(0, 3));
      assert.equal(result.candidates.length, 2);
      const ranked = rankHistory(result.candidates, { query, hostname: scope === "site" ? "example.com" : null });
      assert.deepEqual(ranked.map(item => item.url), scope === "site" ? [] : [victor]);
    }
  }
});

test("permission revoked during a query discards its results", async () => {
  const script = await worker({ granted: true });
  let finish;
  script.context.chrome.history.search = () => new Promise(resolve => { finish = resolve; });
  const pending = script.search();
  await new Promise(resolve => setImmediate(resolve));
  script.changeAccess(false);
  finish([page("https://github.com/private")]);
  assert.equal((await pending).candidates.length, 0);
});

test("history query errors return a recoverable response", async () => {
  const script = await worker({ granted: true });
  script.context.chrome.history.search = async () => { throw new Error("Unavailable"); };
  const response = await script.search();
  assert.equal(response.error, "Unavailable");
  assert.equal(response.candidates.length, 0);
});

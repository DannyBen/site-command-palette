const test = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");
const core = require("../core.js");
const source = readFileSync(require.resolve("../content.js"), "utf8");

async function contentScript() {
  const listeners = new Map();
  const errors = [];
  let removed = false;
  const runtime = { id: "test-extension", getURL: path => `chrome-extension://test/${path}` };
  const storage = {
    local: { get: async () => ({}) },
    onChanged: {
      addListener() {},
      removeListener() { throw new Error("Invalidated API must not be used during cleanup"); }
    }
  };
  const context = {
    setTimeout,
    clearTimeout,
    SiteCommandPaletteCore: core,
    SiteCommandPaletteStorage: {
      COMMANDS_STORAGE_KEY: core.COMMANDS_STORAGE_KEY,
      SITES_STORAGE_KEY: core.SITES_STORAGE_KEY,
      SETTINGS_STORAGE_KEY: core.SETTINGS_STORAGE_KEY,
      loadStorage: async () => core.migrateStorage({}).data
    },
    chrome: { runtime, storage },
    console: { error: (...args) => errors.push(args) },
    location: new URL("https://example.com/"),
    fetch: async () => ({ ok: true, text: async () => "" }),
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
    document: {
      activeElement: null,
      getElementById: () => ({ remove() { removed = true; } }),
      createElement: () => ({ style: { setProperty() {} } })
    },
    window: {
      addEventListener(type, listener) { listeners.set(type, listener); },
      removeEventListener(type) { listeners.delete(type); }
    }
  };
  vm.runInNewContext(source, context);
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(listeners.has("keydown"), "initialization must install the shortcut handler");
  function press() {
    const event = {
      code: "Backquote", key: "`", repeat: false,
      altKey: false, ctrlKey: false, metaKey: false, shiftKey: false,
      composedPath: () => [null],
      preventDefault() { this.prevented = true; },
      stopImmediatePropagation() { this.stopped = true; }
    };
    listeners.get("keydown")?.(event);
    return event;
  }
  return { runtime, listeners, errors, press, isRemoved: () => removed };
}

test("an invalidated content script retires without swallowing the page shortcut", async () => {
  const script = await contentScript();
  script.runtime.id = undefined;
  const event = script.press();
  assert.equal(event.prevented, undefined);
  assert.equal(event.stopped, undefined);
  assert.equal(script.listeners.size, 0);
  assert.equal(script.isRemoved(), true);
  assert.deepEqual(script.errors, []);
});

test("invalidation during icon URL lookup is caught and removes stale listeners", async () => {
  const script = await contentScript();
  script.runtime.getURL = () => { throw new Error("Extension context invalidated."); };
  // Give the shortcut an editable target check without needing a browser DOM.
  // Alt+Backquote works independently of the target's element type.
  const keydown = script.listeners.get("keydown");
  keydown({
    code: "Backquote", key: "`", altKey: true, repeat: false,
    ctrlKey: false, metaKey: false, shiftKey: false,
    preventDefault() {}, stopImmediatePropagation() {}, composedPath: () => [null]
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(script.listeners.size, 0);
  assert.equal(script.isRemoved(), true);
  assert.deepEqual(script.errors, []);
});

test("other opening failures are still reported", async () => {
  const script = await contentScript();
  script.runtime.getURL = () => { throw new Error("Unexpected icon failure"); };
  script.listeners.get("keydown")({
    code: "Backquote", key: "`", altKey: true, repeat: false,
    ctrlKey: false, metaKey: false, shiftKey: false,
    preventDefault() {}, stopImmediatePropagation() {}
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(script.listeners.has("keydown"), true);
  assert.equal(script.errors.length, 1);
  assert.equal(script.errors[0][1].message, "Unexpected icon failure");
});

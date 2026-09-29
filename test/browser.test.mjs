import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const extensionRoot = fileURLToPath(new URL("../", import.meta.url));
const fixture = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Command palette browser test</title>
    <script>
      window.receivedKeys = [];
      window.addEventListener("keydown", (event) => receivedKeys.push(event.key));
    </script>
  </head>
  <body>
    <label>Editable field <input id="editor"></label>
  </body>
</html>`;

test("palette keyboard, theme, and settings flows work in Chromium", { timeout: 45_000 }, async () => {
  const server = http.createServer((request, response) => {
    if (request.url !== "/") {
      response.writeHead(404).end();
      return;
    }

    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    response.end(fixture);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const profile = await mkdtemp(path.join(os.tmpdir(), "site-command-palette-test-"));
  const chromium = await findChromium();
  const address = server.address();
  const browser = spawn(chromium, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-crash-reporter",
    `--user-data-dir=${profile}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--load-extension=${extensionRoot}`,
    `http://127.0.0.1:${address.port}/`
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let browserErrors = "";
  browser.stderr.on("data", (chunk) => {
    browserErrors = `${browserErrors}${chunk}`.slice(-8_000);
  });

  let cdp;
  try {
    const port = await waitForDebuggingPort(profile, browser, () => browserErrors);
    const target = await waitForPageTarget(port);
    cdp = await connectCdp(target.webSocketDebuggerUrl);

    await waitFor(async () => evaluate(cdp, "document.readyState === 'complete'"));

    await openPalette(cdp);

    await press(cdp, "a", "KeyA", 65, 1);
    await cdp.send("Input.insertText", { text: "Duplicate" });
    await activateAccessibleNode(cdp, "button", "Save command");
    await waitFor(async () => !(await hasAccessibleNode(cdp, "heading", "Add command")));

    await press(cdp, "a", "KeyA", 65, 1);
    await cdp.send("Input.insertText", { text: " duplicate " });
    await activateAccessibleNode(cdp, "button", "Save command");
    await waitFor(async () => (
      await accessibleNodeText(cdp, "alert") ===
        "This command already exists in this scope."
    ));
    assert.equal(
      await hasAccessibleNode(cdp, "heading", "Add command"),
      true,
      "a duplicate should leave the add form open"
    );
    await press(cdp, "Escape", "Escape", 27);
    await press(cdp, "x", "KeyX", 88, 1);
    await waitFor(async () => hasAccessibleNode(
      cdp,
      "StaticText",
      "No commands saved for 127.0.0.1."
    ));

    await press(cdp, "`", "Backquote", 192);
    await waitFor(async () => !(await hasPalette(cdp)));

    await evaluate(cdp, "document.getElementById('editor').focus()");
    await press(cdp, "`", "Backquote", 192);
    assert.equal(await hasPalette(cdp), false, "bare backtick should not open from an editable field");

    await press(cdp, "`", "Backquote", 192, 1);
    await waitFor(async () => hasPalette(cdp));

    await press(cdp, "s", "KeyS", 83);
    assert.equal(
      await evaluate(cdp, "window.receivedKeys.includes('s')"),
      false,
      "page shortcuts should not receive palette keystrokes"
    );

    await press(cdp, "`", "Backquote", 192);
    await waitFor(async () => !(await hasPalette(cdp)));
    await press(cdp, "`", "Backquote", 192);
    await waitFor(async () => hasPalette(cdp));
    await press(cdp, "t", "KeyT", 84, 1);
    await press(cdp, "ArrowDown", "ArrowDown", 40);
    await press(cdp, "Enter", "Enter", 13);
    assert.equal(
      await paletteTheme(cdp),
      "light",
      "Alt+T should not trigger the theme command"
    );

    await cdp.send("Input.insertText", { text: "/theme" });
    await press(cdp, "ArrowDown", "ArrowDown", 40);
    await press(cdp, "Enter", "Enter", 13);
    await waitFor(async () => (await paletteTheme(cdp)) === "dark");
    assert.equal(await hasPalette(cdp), true, "theme actions should keep the palette open");

    await press(cdp, "Escape", "Escape", 27);
    assert.equal(await hasPalette(cdp), true, "first Escape should clear the /theme filter");
    await press(cdp, "Escape", "Escape", 27);
    await waitFor(async () => !(await hasPalette(cdp)));

    await press(cdp, "`", "Backquote", 192);
    await waitFor(async () => (await paletteTheme(cdp)) === "dark");

    await cdp.send("Input.insertText", { text: "/settings" });
    await press(cdp, "Enter", "Enter", 13);
    await waitFor(async () => !(await hasPalette(cdp)));

    const optionsTarget = await waitForOptionsTarget(port);
    const optionsCdp = await connectCdp(optionsTarget.webSocketDebuggerUrl);
    try {
      await waitFor(async () => evaluate(
        optionsCdp,
        "document.readyState === 'complete' && Boolean(document.getElementById('global-theme'))"
      ));
      await waitFor(async () => evaluate(
        optionsCdp,
        "document.querySelector('[data-hostname=\"127.0.0.1\"]')?.value === 'dark'"
      ));
      assert.equal(
        await evaluate(optionsCdp, "document.getElementById('global-theme').value"),
        "light"
      );
      assert.equal(
        await evaluate(optionsCdp, "document.getElementById('extension-version').textContent"),
        "· Version 0.1.1"
      );
      assert.equal(
        await evaluate(optionsCdp, "typeof window.showDirectoryPicker"),
        "function",
        "extension settings should have access to the directory picker"
      );
      assert.equal(
        await evaluate(optionsCdp, "typeof window.showOpenFilePicker"),
        "function",
        "extension settings should have access to the backup file picker"
      );
      assert.equal(
        await evaluate(optionsCdp, "document.getElementById('backup-state').textContent"),
        "Not configured"
      );
      assert.equal(
        await evaluate(optionsCdp, "document.getElementById('backup-now').disabled"),
        true
      );
      assert.equal(
        await evaluate(optionsCdp, "document.getElementById('backup-history-limit').value"),
        "10",
        "backup history should default to ten previous versions"
      );
      assert.equal(
        await evaluate(optionsCdp, "document.querySelector('[data-key-binding=\"add\"]').textContent"),
        "Alt + A"
      );
      await evaluate(optionsCdp, `document.querySelector('[data-key-binding="add"]').click()`);
      await press(optionsCdp, "K", "KeyK", 75, 10);
      await waitFor(async () => evaluate(
        optionsCdp,
        `document.querySelector('[data-key-binding="add"]').textContent === 'Ctrl + Shift + K'`
      ));
      await evaluate(optionsCdp, `document.querySelector('[data-key-binding="edit"]').click()`);
      await press(optionsCdp, "K", "KeyK", 75, 10);
      await waitFor(async () => evaluate(
        optionsCdp,
        "document.getElementById('key-binding-message').textContent.includes('already used')"
      ));
      assert.equal(
        await evaluate(optionsCdp, "document.querySelector('[data-key-binding=\"edit\"]').textContent"),
        "Press shortcut…",
        "a conflicting shortcut should not be saved"
      );
      await evaluate(optionsCdp, "document.getElementById('reset-key-bindings').click()");
      await waitFor(async () => evaluate(
        optionsCdp,
        `document.querySelector('[data-key-binding="add"]').textContent === 'Alt + A'`
      ));
      assert.deepEqual(
        await evaluate(optionsCdp, `JSON.stringify({
          h1: getComputedStyle(document.querySelector('h1')).fontSize,
          h2: getComputedStyle(document.getElementById('theme-heading')).fontSize,
          h3: getComputedStyle(document.querySelector('.list-heading h3')).fontSize,
          body: getComputedStyle(document.getElementById('backup-folder')).fontSize,
          compact: getComputedStyle(document.getElementById('backup-now')).fontSize,
          h1Weight: getComputedStyle(document.querySelector('h1')).fontWeight,
          buttonWeight: getComputedStyle(document.getElementById('backup-now')).fontWeight
        })`),
        JSON.stringify({
          h1: "32px",
          h2: "24px",
          h3: "20px",
          body: "16px",
          compact: "14px",
          h1Weight: "400",
          buttonWeight: "500"
        }),
        "settings should use the five-role Primer-inspired type scale"
      );
      assert.deepEqual(
        await evaluate(optionsCdp, `JSON.stringify(
          [...document.querySelector('[data-hostname="127.0.0.1"]').options]
            .map((option) => option.value)
        )`),
        JSON.stringify(["light", "dark"])
      );
      assert.equal(
        await evaluate(optionsCdp, `getComputedStyle(
          document.getElementById('global-theme')
        ).fontWeight === getComputedStyle(
          document.querySelector('[data-hostname="127.0.0.1"]')
        ).fontWeight`),
        true,
        "global and per-site theme values should use the same font weight"
      );

      await evaluate(optionsCdp, `(() => {
        const button = document.querySelector('[data-remove-hostname="127.0.0.1"]');
        button.click();
      })()`);
      await waitFor(async () => evaluate(
        optionsCdp,
        "document.getElementById('empty-overrides').hidden === false"
      ));

      await evaluate(optionsCdp, `(() => {
        const select = document.getElementById('global-theme');
        select.value = 'dark';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await waitFor(async () => evaluate(
        optionsCdp,
        "document.documentElement.dataset.theme === 'dark'"
      ));

      await press(cdp, "`", "Backquote", 192);
      await waitFor(async () => (await paletteTheme(cdp)) === "dark");

      await evaluate(optionsCdp, `(() => {
        const select = document.getElementById('global-theme');
        select.value = 'light';
        select.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await waitFor(async () => (await paletteTheme(cdp)) === "light");
    } finally {
      optionsCdp.close();
    }
  } finally {
    cdp?.close();
    await stopProcess(browser);
    await new Promise((resolve) => server.close(resolve));
    await rm(profile, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 100
    });
  }
});

async function findChromium() {
  const candidates = [
    process.env.CHROMIUM_BIN,
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome"
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known executable.
    }
  }

  throw new Error("Chromium was not found; set CHROMIUM_BIN to its executable path");
}

async function waitForDebuggingPort(profile, browser, errors) {
  const activePortFile = path.join(profile, "DevToolsActivePort");

  return waitFor(async () => {
    if (browser.exitCode !== null) {
      throw new Error(`Chromium exited with ${browser.exitCode}\n${errors()}`);
    }

    try {
      const [port] = (await readFile(activePortFile, "utf8")).split("\n");
      return Number(port) || false;
    } catch {
      return false;
    }
  }, 15_000);
}

async function waitForPageTarget(port) {
  return waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      return targets.find((target) => target.type === "page" && target.url.startsWith("http://127.0.0.1:"));
    } catch {
      return false;
    }
  });
}

async function waitForOptionsTarget(port) {
  return waitFor(async () => {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await response.json();
      return targets.find((target) => (
        target.type === "page" && target.url.startsWith("chrome-extension://") &&
        target.url.endsWith("/options.html")
      ));
    } catch {
      return false;
    }
  });
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;

  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) return;
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  return {
    close: () => socket.close(),
    send(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      return new Promise((resolve, reject) => {
        pending.set(id, (message) => {
          if (message.error) reject(new Error(message.error.message));
          else resolve(message.result);
        });
      });
    }
  };
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", { expression, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function press(cdp, key, code, windowsVirtualKeyCode, modifiers = 0) {
  const params = { key, code, windowsVirtualKeyCode, modifiers };
  await cdp.send("Input.dispatchKeyEvent", { ...params, type: "rawKeyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...params, type: "keyUp" });
}

function hasPalette(cdp) {
  return evaluate(cdp, "Boolean(document.getElementById('site-command-palette-root'))");
}

async function openPalette(cdp, timeout = 15_000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    if (await hasPalette(cdp)) return;
    await press(cdp, "`", "Backquote", 192);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  throw new Error(`Palette did not open within ${timeout}ms`);
}

function paletteTheme(cdp) {
  return evaluate(cdp, "document.getElementById('site-command-palette-root')?.dataset.theme");
}

async function hasAccessibleNode(cdp, role, name) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  return nodes.some((node) => node.role?.value === role && node.name?.value === name);
}

async function activateAccessibleNode(cdp, role, name) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const node = nodes.find((candidate) => (
    candidate.role?.value === role && candidate.name?.value === name
  ));
  assert.ok(node?.backendDOMNodeId, `${role} named “${name}” should be accessible`);

  const { object } = await cdp.send("DOM.resolveNode", {
    backendNodeId: node.backendDOMNodeId
  });
  await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: "function() { this.click(); }"
  });
}

async function accessibleNodeText(cdp, role) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const node = nodes.find((candidate) => candidate.role?.value === role);
  if (!node?.backendDOMNodeId) return null;

  const { object } = await cdp.send("DOM.resolveNode", {
    backendNodeId: node.backendDOMNodeId
  });
  const { result } = await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: "function() { return this.textContent; }",
    returnByValue: true
  });
  return result.value;
}

async function waitFor(callback, timeout = 5_000) {
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    const value = await callback();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Condition was not met within ${timeout}ms`);
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;

  child.kill("SIGTERM");
  await Promise.race([
    once(child, "exit"),
    new Promise((resolve) => setTimeout(resolve, 1_000))
  ]);

  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await once(child, "exit");
  }
}

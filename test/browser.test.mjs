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
<html lang="he" dir="rtl">
  <head>
    <meta charset="utf-8">
    <title>Command palette browser test</title>
    <style>
      html { font-family: serif; }
      div { direction: rtl !important; font-family: serif !important; }
    </style>
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
  const manifest = JSON.parse(
    await readFile(path.join(extensionRoot, "manifest.json"), "utf8")
  );
  let fixtureRequestCount = 0;
  const server = http.createServer((request, response) => {
    if (request.url !== "/") {
      response.writeHead(404).end();
      return;
    }

    fixtureRequestCount += 1;
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
  const pageUrl = `http://127.0.0.1:${address.port}/`;
  const browser = spawn(chromium, [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    "--disable-crash-reporter",
    `--user-data-dir=${profile}`,
    "--remote-debugging-address=127.0.0.1",
    "--remote-debugging-port=0",
    `--disable-extensions-except=${extensionRoot}`,
    `--load-extension=${extensionRoot}`,
    "about:blank"
  ], { stdio: ["ignore", "ignore", "pipe"] });
  let browserErrors = "";
  browser.stderr.on("data", (chunk) => {
    browserErrors = `${browserErrors}${chunk}`.slice(-8_000);
  });

  let cdp;
  try {
    const port = await waitForDebuggingPort(profile, browser, () => browserErrors);
    await waitForExtensionTarget(port, () => browserErrors);
    const target = await waitForPageTarget(port);
    cdp = await connectCdp(target.webSocketDebuggerUrl);

    await cdp.send("Page.navigate", { url: pageUrl });
    await waitFor(async () => evaluate(
      cdp,
      `location.href === ${JSON.stringify(pageUrl)} && document.readyState === 'complete'`
    ));

    await openPalette(cdp);
    assert.equal(
      await hasAccessibleText(cdp, "Actions"),
      true,
      "the footer should advertise slash actions"
    );

    assert.equal(
      await accessibleNodeStyle(cdp, "searchbox", "Search commands", "direction"),
      "ltr",
      "the palette should not inherit the page direction"
    );
    assert.match(
      await accessibleNodeStyle(cdp, "searchbox", "Search commands", "fontFamily"),
      /^system-ui/,
      "the palette should not inherit the page font"
    );

    assert.equal(
      await accessibleNodeDomProperty(cdp, "searchbox", "Search commands", "placeholder"),
      "Search Command palette browser test commands"
    );
    await press(cdp, "Tab", "Tab", 9);
    assert.equal(
      await accessibleNodeFocused(cdp, "searchbox", "Search commands"),
      true,
      "Tab should keep focus on search while changing command scope"
    );
    assert.equal(
      await accessibleNodeDomProperty(cdp, "searchbox", "Search commands", "placeholder"),
      "Search all commands"
    );
    await press(cdp, "`", "Backquote", 192);
    await waitFor(async () => !(await hasPalette(cdp)));
    await openPalette(cdp);
    assert.equal(
      await accessibleNodeDomProperty(cdp, "searchbox", "Search commands", "placeholder"),
      "Search all commands",
      "the selected scope should survive closing and reopening the palette"
    );
    await cdp.send("Page.reload");
    await waitFor(async () => evaluate(cdp, "document.readyState === 'complete'"));
    await openPalette(cdp);
    assert.equal(
      await accessibleNodeDomProperty(cdp, "searchbox", "Search commands", "placeholder"),
      "Search all commands",
      "the selected scope should survive reloading the page"
    );
    await press(cdp, "Tab", "Tab", 9);
    assert.equal(
      await accessibleNodeDomProperty(cdp, "searchbox", "Search commands", "placeholder"),
      "Search Command palette browser test commands"
    );
    const viewportHeight = await evaluate(cdp, "innerHeight");
    const edgeGap = Math.min(72, Math.max(16, viewportHeight * 0.12));
    assert.equal(
      await accessibleNodeStyle(
        cdp,
        "dialog",
        "Site command palette",
        "maxHeight"
      ),
      `${Math.min(720, viewportHeight - edgeGap * 2)}px`,
      "the palette height should respect equal viewport clearances and its desktop cap"
    );

    await evaluate(cdp, "location.hash = 'inbox'");
    await waitFor(async () => !(await hasPalette(cdp)));
    await evaluate(cdp, "history.replaceState(null, '', '/')");
    await openPalette(cdp);

    await press(cdp, "a", "KeyA", 65, 1);
    assert.equal(
      await accessibleNodeFocused(cdp, "textbox", "Page"),
      true,
      "the page field should start focused"
    );
    await press(cdp, "Tab", "Tab", 9);
    assert.equal(
      await accessibleNodeFocused(cdp, "textbox", "URL"),
      true,
      "Tab should retain normal form navigation"
    );
    await focusAccessibleNode(cdp, "textbox", "Page");
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

    await press(cdp, "a", "KeyA", 65, 1);
    await cdp.send("Input.insertText", { text: "Second  >  Detail <things like this>" });
    await activateAccessibleNode(cdp, "button", "Save command");
    await waitFor(async () => (await selectedOptionText(cdp)).includes("Duplicate"));

    assert.match(
      await accessibleNodeChildStyle(
        cdp,
        "button",
        "Edit Command palette browser test › Duplicate",
        ".icon",
        "maskImage"
      ),
      /^url\("chrome-extension:\/\//,
      "row actions should use packaged extension icon assets"
    );
    const editName = "Edit Command palette browser test › Duplicate";
    const removeName = "Remove Command palette browser test › Duplicate";
    await focusAccessibleNode(cdp, "button", editName);
    const editFocusStyle = [
      await accessibleNodeStyle(cdp, "button", editName, "backgroundColor"),
      await accessibleNodeStyle(cdp, "button", editName, "color")
    ];
    await focusAccessibleNode(cdp, "button", removeName);
    const removeFocusStyle = [
      await accessibleNodeStyle(cdp, "button", removeName, "backgroundColor"),
      await accessibleNodeStyle(cdp, "button", removeName, "color")
    ];
    assert.deepEqual(
      removeFocusStyle,
      editFocusStyle,
      "edit and delete should share one focus treatment"
    );
    assert.notEqual(editFocusStyle[0], "rgba(0, 0, 0, 0)");
    await activateAccessibleNode(
      cdp,
      "button",
      editName
    );
    assert.equal(
      await hasAccessibleNode(cdp, "StaticText", "Shared by 2 commands"),
      true,
      "the editor should disclose shared site names inline"
    );
    await setAccessibleInputValue(cdp, "Site", "Fixture");
    await setAccessibleInputValue(cdp, "Page", "Zulu");
    await activateAccessibleNode(cdp, "button", "Update command");
    await waitFor(async () => (
      await selectedOptionText(cdp)
    ).includes("Fixture › Zulu"));
    assert.equal(
      await accessibleNodeDomProperty(cdp, "searchbox", "Search commands", "placeholder"),
      "Search Fixture commands",
      "the search placeholder should follow the shared site name"
    );
    await cdp.send("Input.insertText", { text: "Second" });
    await waitFor(async () => (
      await selectedOptionText(cdp)
    ).includes("Fixture › Second › Detail <things like this>"));
    await press(cdp, "x", "KeyX", 88, 1);
    await waitFor(async () => !(await hasAccessibleNode(
      cdp,
      "StaticText",
      "Fixture › Second › Detail <things like this>"
    )));
    await press(cdp, "Escape", "Escape", 27);
    await waitFor(async () => hasAccessibleNode(cdp, "searchbox", "Search commands"));

    await press(cdp, "a", "KeyA", 65, 1);
    await waitFor(async () => hasAccessibleNode(cdp, "heading", "Add command"));
    await cdp.send("Input.insertText", { text: "External" });
    await setAccessibleInputValue(cdp, "URL", "https://github.com/");
    await activateAccessibleNode(cdp, "button", "Save command");
    await waitFor(async () => hasAccessibleNode(cdp, "separator", "External commands"));
    assert.match(
      await selectedOptionText(cdp),
      /Fixture › Zulu/,
      "the command matching the current page should be selected"
    );
    const fixtureRequestCountBefore = fixtureRequestCount;
    await press(cdp, "Enter", "Enter", 13);
    await waitFor(async () => !(await hasPalette(cdp)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      fixtureRequestCount,
      fixtureRequestCountBefore,
      "opening the current page command should not reload the page"
    );
    await openPalette(cdp);
    await cdp.send("Input.insertText", { text: "External" });
    await waitFor(async () => (await selectedOptionText(cdp)).includes("Github › External"));
    const pageTargetCountBefore = await pageTargetCount(port);
    await press(cdp, "Enter", "Enter", 13, 2);
    await waitFor(async () => (await pageTargetCount(port)) > pageTargetCountBefore);
    await waitFor(async () => !(await hasPalette(cdp)));
    await openPalette(cdp);
    assert.equal(
      await accessibleNodeClosestStyle(
        cdp,
        "button",
        "Remove Fixture › Zulu",
        ".command-actions",
        "opacity"
      ),
      "1"
    );
    await waitFor(async () => (
      await accessibleNodeClosestStyle(
        cdp,
        "button",
        "Remove Github › External",
        ".command-actions",
        "opacity"
      )
    ) === "0");

    await press(cdp, "x", "KeyX", 88, 1);
    await waitFor(async () => !(await hasAccessibleNode(
      cdp,
      "separator",
      "External commands"
    )));
    await waitFor(async () => (await selectedOptionText(cdp)).includes("Github › External"));
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
    assert.equal(
      await evaluate(cdp, "document.activeElement === document.getElementById('editor')"),
      true,
      "closing the palette should restore focus to the previously focused element"
    );
    await evaluate(cdp, "document.getElementById('editor').blur()");
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
        `· Version ${manifest.version}`
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
      await evaluate(optionsCdp, `(() => {
        URL.createObjectURL = (blob) => {
          blob.text().then((text) => { window.downloadedBackupText = text; });
          return 'blob:manual-backup-test';
        };
        HTMLAnchorElement.prototype.click = function() {
          window.downloadedBackupName = this.download;
        };
        document.getElementById('download-backup').click();
      })()`);
      await waitFor(async () => evaluate(
        optionsCdp,
        "document.getElementById('manual-backup-message').textContent === 'Backup downloaded.' && Boolean(window.downloadedBackupText)"
      ));
      assert.match(
        await evaluate(optionsCdp, "window.downloadedBackupName"),
        /^site-command-palette-backup-\d{4}-\d{2}-\d{2}T.+Z\.json$/
      );
      assert.equal(
        await evaluate(optionsCdp, "JSON.parse(window.downloadedBackupText).format"),
        "site-command-palette-backup"
      );

      await evaluate(optionsCdp, `(() => {
        const backup = JSON.parse(window.downloadedBackupText);
        backup.data.settings.theme = 'dark';
        const transfer = new DataTransfer();
        transfer.items.add(new File(
          [JSON.stringify(backup)],
          'manual-backup.json',
          { type: 'application/json' }
        ));
        const input = document.getElementById('backup-file');
        input.files = transfer.files;
        window.confirm = () => true;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await waitFor(async () => evaluate(
        optionsCdp,
        "document.getElementById('manual-backup-message').textContent === 'Backup restored.' && document.getElementById('global-theme').value === 'dark'"
      ));

      await evaluate(optionsCdp, `(() => {
        const transfer = new DataTransfer();
        transfer.items.add(new File(
          [window.downloadedBackupText],
          'manual-backup.json',
          { type: 'application/json' }
        ));
        const input = document.getElementById('backup-file');
        input.files = transfer.files;
        input.dispatchEvent(new Event('change', { bubbles: true }));
      })()`);
      await waitFor(async () => evaluate(
        optionsCdp,
        "document.getElementById('manual-backup-message').textContent === 'Backup restored.' && document.getElementById('global-theme').value === 'light'"
      ));
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

      await evaluate(optionsCdp, `(() => {
        const input = document.getElementById('disabled-site-input');
        input.value = 'http://127.0.0.1:${address.port}/somewhere';
        document.getElementById('disabled-site-form').requestSubmit();
      })()`);
      await waitFor(async () => evaluate(
        optionsCdp,
        `document.querySelector('[data-remove-disabled-hostname="127.0.0.1"]')?.textContent === 'Remove'`
      ));
      assert.equal(
        await evaluate(optionsCdp, "document.getElementById('disabled-site-count').textContent"),
        "1 site"
      );
      await waitFor(async () => !(await hasPalette(cdp)));
      await press(cdp, "`", "Backquote", 192);
      assert.equal(await hasPalette(cdp), false, "disabled sites should not intercept shortcuts");

      await evaluate(
        optionsCdp,
        `document.querySelector('[data-remove-disabled-hostname="127.0.0.1"]').click()`
      );
      await waitFor(async () => evaluate(
        optionsCdp,
        "document.getElementById('empty-disabled-sites').hidden === false"
      ));
      await cdp.send("Page.reload");
      await waitFor(async () => evaluate(cdp, "document.readyState === 'complete'"));
      await new Promise((resolve) => setTimeout(resolve, 100));
      await openPalette(cdp);
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
      return targets.find((target) => target.type === "page" && target.url === "about:blank");
    } catch {
      return false;
    }
  });
}

async function pageTargetCount(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await response.json();
  return targets.filter((target) => target.type === "page").length;
}

async function waitForExtensionTarget(port, errors) {
  try {
    return await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = await response.json();
        return targets.find((target) => (
          target.type === "service_worker" &&
          target.url.startsWith("chrome-extension://") &&
          target.url.endsWith("/background.js")
        ));
      } catch {
        return false;
      }
    }, 15_000);
  } catch {
    throw new Error(`Extension service worker did not start\n${errors()}`);
  }
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

async function openPalette(cdp) {
  await waitFor(async () => {
    if (await hasPalette(cdp)) return true;
    await press(cdp, "`", "Backquote", 192);
    return hasPalette(cdp);
  });
}

function paletteTheme(cdp) {
  return evaluate(cdp, "document.getElementById('site-command-palette-root')?.dataset.theme");
}

async function hasAccessibleNode(cdp, role, name) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  return nodes.some((node) => node.role?.value === role && node.name?.value === name);
}

async function hasAccessibleText(cdp, text) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  return nodes.some((node) => node.name?.value?.includes(text));
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

async function accessibleNodeFocused(cdp, role, name) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const node = nodes.find((candidate) => (
    candidate.role?.value === role && candidate.name?.value === name
  ));
  assert.ok(node, `${role} named “${name}” should be accessible`);

  return node.properties?.some((property) => (
    property.name === "focused" && property.value?.value === true
  )) ?? false;
}

async function focusAccessibleNode(cdp, role, name) {
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
    functionDeclaration: "function() { this.focus(); }"
  });
}

async function setAccessibleInputValue(cdp, name, value) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const node = nodes.find((candidate) => (
    candidate.role?.value === "textbox" && candidate.name?.value.trim() === name
  ));
  const availableTextboxes = nodes
    .filter((candidate) => candidate.role?.value === "textbox")
    .map((candidate) => candidate.name?.value.trim())
    .filter(Boolean);
  assert.ok(
    node?.backendDOMNodeId,
    `textbox named “${name}” should be accessible; found ${availableTextboxes.join(", ")}`
  );

  const { object } = await cdp.send("DOM.resolveNode", {
    backendNodeId: node.backendDOMNodeId
  });
  await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `function(value) {
      this.value = value;
      this.dispatchEvent(new Event('input', { bubbles: true }));
    }`,
    arguments: [{ value }]
  });
}

async function selectedOptionText(cdp) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const node = nodes.find((candidate) => (
    candidate.role?.value === "option" &&
    candidate.properties?.some((property) => (
      property.name === "selected" && property.value?.value === true
    ))
  ));
  assert.ok(node?.backendDOMNodeId, "a selected option should be accessible");

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

async function accessibleNodeStyle(cdp, role, name, property) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const node = nodes.find((candidate) => (
    candidate.role?.value === role && candidate.name?.value === name
  ));
  assert.ok(node?.backendDOMNodeId, `${role} named “${name}” should be accessible`);

  const { object } = await cdp.send("DOM.resolveNode", {
    backendNodeId: node.backendDOMNodeId
  });
  const { result } = await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: "function(property) { return getComputedStyle(this)[property]; }",
    arguments: [{ value: property }],
    returnByValue: true
  });
  return result.value;
}

async function accessibleNodeClosestStyle(cdp, role, name, selector, property) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const node = nodes.find((candidate) => (
    candidate.role?.value === role && candidate.name?.value === name
  ));
  assert.ok(node?.backendDOMNodeId, `${role} named “${name}” should be accessible`);

  const { object } = await cdp.send("DOM.resolveNode", {
    backendNodeId: node.backendDOMNodeId
  });
  const { result } = await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `function(selector, property) {
      return getComputedStyle(this.closest(selector))[property];
    }`,
    arguments: [{ value: selector }, { value: property }],
    returnByValue: true
  });
  return result.value;
}

async function accessibleNodeChildStyle(cdp, role, name, selector, property) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const node = nodes.find((candidate) => (
    candidate.role?.value === role && candidate.name?.value === name
  ));
  assert.ok(node?.backendDOMNodeId, `${role} named “${name}” should be accessible`);

  const { object } = await cdp.send("DOM.resolveNode", {
    backendNodeId: node.backendDOMNodeId
  });
  const { result } = await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `function(selector, property) {
      return getComputedStyle(this.querySelector(selector))[property];
    }`,
    arguments: [{ value: selector }, { value: property }],
    returnByValue: true
  });
  return result.value;
}

async function accessibleNodeDomProperty(cdp, role, name, property) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const node = nodes.find((candidate) => (
    candidate.role?.value === role && candidate.name?.value === name
  ));
  assert.ok(node?.backendDOMNodeId, `${role} named “${name}” should be accessible`);

  const { object } = await cdp.send("DOM.resolveNode", {
    backendNodeId: node.backendDOMNodeId
  });
  const { result } = await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: "function(property) { return this[property]; }",
    arguments: [{ value: property }],
    returnByValue: true
  });
  return result.value;
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

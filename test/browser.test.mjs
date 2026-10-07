import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
      window.receivedKeyEvents = [];
      for (const type of ["keydown", "keypress", "keyup"]) {
        window.addEventListener(type, (event) => {
          receivedKeyEvents.push({ type, key: event.key });
        });
      }
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
  const extensionId = createHash("sha256")
    .update(Buffer.from(manifest.key, "base64"))
    .digest("hex").slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
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
    const extensionTarget = await waitForExtensionTarget(port, extensionId, () => browserErrors);
    const target = await waitForPageTarget(port);
    cdp = await connectCdp(target.webSocketDebuggerUrl);

    const popupUrl = extensionTarget.url.replace(/background\.js$/, "popup.html");
    await cdp.send("Page.navigate", { url: popupUrl });
    await waitFor(() => evaluate(cdp,
      "document.getElementById('primary-shortcut')?.textContent === 'Backtick (`)' && document.getElementById('alternate-shortcut')?.textContent === 'Alt + Backtick'"
    ));
    assert.equal(await evaluate(cdp, "document.querySelectorAll('button').length"), 1);
    assert.equal(await evaluate(cdp, "document.body.textContent.includes('This can read and change site data')"), true);
    await waitFor(() => evaluate(cdp,
      "document.getElementById('website-access')?.textContent === 'All sites'"
    ));
    assert.equal(await evaluate(cdp, "getComputedStyle(document.body).fontSize"), "15px");

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
      "Search 127.0.0.1 commands"
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
      "Search 127.0.0.1 commands"
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
        "Edit 127.0.0.1 › Duplicate",
        ".icon",
        "maskImage"
      ),
      /^url\("chrome-extension:\/\//,
      "row actions should use packaged extension icon assets"
    );
    const editName = "Edit 127.0.0.1 › Duplicate";
    const removeName = "Remove 127.0.0.1 › Duplicate";
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
    await setAccessibleInputValue(cdp, "Scope", "127.*");
    await activateAccessibleNode(cdp, "button", "Save command");
    await waitFor(async () => hasAccessibleNode(cdp, "button", "Edit github.com › External"));
    assert.equal(
      await hasAccessibleNode(cdp, "separator", "External commands"),
      false,
      "a destination on another host should be internal when its wildcard scope matches"
    );
    await activateAccessibleNode(cdp, "button", "Edit github.com › External");
    await waitFor(async () => hasAccessibleNode(cdp, "heading", "Edit command"));
    await setAccessibleInputValue(cdp, "Scope", "*");
    await activateAccessibleNode(cdp, "button", "Update command");
    await waitFor(async () => hasAccessibleNode(cdp, "separator", "External commands"));
    await press(cdp, "Escape", "Escape", 27);
    await waitFor(async () => !(await hasPalette(cdp)));
    await openPalette(cdp);
    assert.match(
      await selectedOptionText(cdp),
      /Fixture › Zulu/,
      "the command matching the current page should be selected"
    );
    const fixtureRequestCountBefore = fixtureRequestCount;
    await evaluate(cdp, "window.receivedKeyEvents = []");
    await pressEnterWithKeypress(cdp);
    await waitFor(async () => !(await hasPalette(cdp)));
    assert.deepEqual(
      await evaluate(cdp, "window.receivedKeyEvents"), [],
      "Enter closing the current-page command should not trigger page shortcuts"
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(
      fixtureRequestCount,
      fixtureRequestCountBefore,
      "opening the current page command should not reload the page"
    );
    await openPalette(cdp);
    await cdp.send("Input.insertText", { text: "External" });
    await waitFor(async () => (await selectedOptionText(cdp)).includes("github.com › External"));
    const pageTargetCountBefore = await pageTargetCount(port);
    // Releasing Enter in the newly opened tab leaves no keyup in this tab.
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "Enter", code: "Enter",
      windowsVirtualKeyCode: 13, modifiers: 2
    });
    await waitFor(async () => (await pageTargetCount(port)) > pageTargetCountBefore);
    await waitFor(async () => !(await hasPalette(cdp)));
    await cdp.send("Page.bringToFront");
    await evaluate(cdp, "window.receivedKeyEvents = []");
    await pressEnterWithKeypress(cdp);
    assert.deepEqual(
      await evaluate(cdp, "window.receivedKeyEvents"),
      ["keydown", "keypress", "keyup"].map((type) => ({ type, key: "Enter" })),
      "the first Enter after returning from a new tab should reach the page completely"
    );

    await openPalette(cdp);
    await evaluate(cdp, "window.receivedKeyEvents = []");
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27
    });
    await waitFor(async () => !(await hasPalette(cdp)));
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "Escape", code: "Escape",
      windowsVirtualKeyCode: 27, autoRepeat: true
    });
    await cdp.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27
    });
    assert.deepEqual(
      await evaluate(cdp, "window.receivedKeyEvents"), [],
      "the keystroke that closes the palette should not trigger page shortcuts"
    );

    await openPalette(cdp);
    await cdp.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27
    });
    await waitFor(async () => !(await hasPalette(cdp)));
    // A fresh press must work even if the closing Escape's keyup was missed.
    await evaluate(cdp, "window.receivedKeyEvents = []");
    await press(cdp, "Escape", "Escape", 27);
    assert.deepEqual(
      await evaluate(cdp, "window.receivedKeyEvents"),
      ["keydown", "keyup"].map((type) => ({ type, key: "Escape" })),
      "a fresh press should clear any guard left by the closing keystroke"
    );
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
        "Remove github.com › External",
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
    await waitFor(async () => (await selectedOptionText(cdp)).includes("github.com › External"));
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
      await verifyHistoryPermissionControls(optionsCdp);
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
      await verifyBackupPermissionRecovery(optionsCdp, extensionTarget);
      await verifyInvalidatedContentScript(cdp, extensionTarget, port);
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

test("history results use real Chrome history and follow palette scope and navigation", { timeout: 45_000 }, async () => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "palette-history-test-"));
  const testExtension = path.join(workspace, "extension");
  const manifest = JSON.parse(await readFile(path.join(extensionRoot, "manifest.json"), "utf8"));
  // Headless Chrome cannot display the optional-permission confirmation dialog.
  // Grant history in this isolated fixture to exercise the real history API.
  manifest.permissions.push("history");
  delete manifest.optional_permissions;
  const files = new Set([
    "background.js", "core.js", "storage.js", "backup.js", "content.js", "palette.css",
    "popup.html", "popup.js", "popup.css", "options.html", "options.js", "options.css",
    ...Object.values(manifest.icons),
    ...manifest.web_accessible_resources.flatMap(entry => entry.resources)
  ]);
  await mkdir(testExtension);
  for (const file of files) {
    await mkdir(path.dirname(path.join(testExtension, file)), { recursive: true });
    await copyFile(path.join(extensionRoot, file), path.join(testExtension, file));
  }
  await writeFile(path.join(testExtension, "manifest.json"), JSON.stringify(manifest));
  const extensionId = createHash("sha256").update(Buffer.from(manifest.key, "base64"))
    .digest("hex").slice(0, 32).replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/html" }).end(fixture);
  });
  let browser;
  let cdp;
  let worker;
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const portNumber = server.address().port;
    const base = `http://127.0.0.1:${portNumber}`;
    const frequent = `${base}/history/usual`;
    const rare = `${base}/history/rare`;
    const saved = `${base}/history/saved`;
    const global = `http://localhost:${portNumber}/history/global`;
    const victor = "https://github.com/dannyben/victor";
    const deepHistory = `${base}/history/rare/detail/119`;
    const pendingUsual = `${base}/pending/usual`;
    const pendingRare = `${base}/pending/rare`;
    const chromium = await findChromium();
    const profile = path.join(workspace, "profile");
    browser = spawn(chromium, [
      "--headless=new", "--no-sandbox", "--disable-gpu", "--disable-crash-reporter",
      `--user-data-dir=${profile}`, "--remote-debugging-address=127.0.0.1",
      "--remote-debugging-port=0", `--disable-extensions-except=${testExtension}`,
      `--load-extension=${testExtension}`, "about:blank"
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let errors = "";
    browser.stderr.on("data", chunk => { errors = `${errors}${chunk}`.slice(-8000); });
    const port = await waitForDebuggingPort(profile, browser, () => errors);
    const extensionTarget = await waitForExtensionTarget(port, extensionId, () => errors);
    worker = await connectCdp(extensionTarget.webSocketDebuggerUrl);
    await worker.send("Runtime.runIfWaitingForDebugger");
    await waitFor(() => evaluate(worker, "Boolean(globalThis.SiteCommandPaletteCore)"));
    const target = await waitForPageTarget(port);
    cdp = await connectCdp(target.webSocketDebuggerUrl);
    await cdp.send("Page.navigate", { url: `${base}/` });
    await waitFor(() => evaluate(cdp, `location.href === ${JSON.stringify(`${base}/`)} && document.readyState === 'complete'`));
    await evaluateAsync(worker, `(async () => {
      for (let index = 0; index < 15; index++) {
        await chrome.history.addUrl({url: ${JSON.stringify(frequent)}});
      }
      for (const url of ${JSON.stringify([rare, saved, global, victor, `${victor}-cli`, `${victor}/pulls`, `${victor}/pull/42`, pendingUsual, pendingRare])}) {
        await chrome.history.addUrl({url});
      }
      for (let index = 0; index < 120; index++) {
        await chrome.history.addUrl({url: ${JSON.stringify(`${base}/history/rare/detail/`)} + index});
      }
      await chrome.storage.local.set({
        commandsByHostname: {"*": [{id: "saved-history", page: "History saved", url: ${JSON.stringify(saved)}}]},
        sitesByHostname: {"127.0.0.1": {name: "Local"}}, commandScope: "site"
      });
      await refreshHistoryAccess();
      globalThis.historyPrefixQueries = [];
      globalThis.nativeHistorySearch = chrome.history.search;
      chrome.history.search = query => {
        historyPrefixQueries.push(query.text);
        return nativeHistorySearch(query);
      };
    })()`);
    for (const scope of ["site", "all"]) {
      for (const query of ["github vi", "github vic", "github vict", "githubvic", "github/vic", "github victor", "githubvictor", "github/victor", "githubdanny", "dannybenvic"]) {
        const urls = await evaluateAsync(worker, `searchHistory(
          ${JSON.stringify({ query, scope })}, {url: 'https://github.com/', tab: {}}
        ).then(result => SiteCommandPaletteCore.rankHistory(result.candidates, {
          query: ${JSON.stringify(query)}, hostname: ${JSON.stringify(scope === "site" ? "github.com" : null)}
        }).map(item => item.url))`);
        assert.equal(urls[0], victor, `${query} should prefer the repository URL in ${scope} scope`);
      }
    }
    await evaluate(worker, "historyPrefixQueries = []");
    await openPalette(cdp);
    assert.equal(await hasAccessibleNode(cdp, "separator", "Browsing history"), false,
      "opening the palette with blank search should show saved commands only");
    for (const query of ["h", "hi"]) {
      await setHistorySearch(cdp, query);
      assert.equal(await hasAccessibleNode(cdp, "separator", "Browsing history"), false,
        "searches shorter than three characters should show no history");
    }
    assert.deepEqual(await evaluate(worker, "historyPrefixQueries"), []);
    await setHistorySearch(cdp, "his");
    await waitFor(() => hasAccessibleText(cdp, frequent));
    assert.deepEqual(await evaluate(worker, "historyPrefixQueries"), ["his"]);
    const joined = await setHistorySearch(cdp, "historyusual");
    assert.ok(joined.some(text => text.includes(frequent)), "joined text should fuzzy-match the cached candidates");
    const refined = await setHistorySearch(cdp, "history rare detail 119");
    assert.ok(refined.some(text => text.includes(deepHistory)),
      "refinement must immediately find candidates outside the ten original results");
    assert.equal(refined.some(text => text.includes(frequent)), false);
    assert.deepEqual(await evaluate(worker, "historyPrefixQueries"), ["his"],
      "adding words must reuse the complete prefix set without another Chrome query");
    const widened = await setHistorySearch(cdp, "history");
    assert.ok(widened.some(text => text.includes(frequent)), "removing words should also filter immediately");
    await setHistorySearch(cdp, "hi");
    assert.equal(await hasAccessibleNode(cdp, "separator", "Browsing history"), false,
      "deleting below the threshold should immediately hide existing history results");
    const restored = await setHistorySearch(cdp, "history");
    assert.ok(restored.some(text => text.includes(frequent)), "returning to the prefix should reuse cached history");
    assert.deepEqual(await evaluate(worker, "historyPrefixQueries"), ["his"]);

    await press(cdp, "Tab", "Tab", 9);
    for (const query of ["githubdanny", "dannybenvic"]) {
      await setHistorySearch(cdp, query);
      await waitFor(() => hasAccessibleText(cdp, victor));
    }
    assert.deepEqual(await evaluate(worker, "historyPrefixQueries"), ["his", "git", "dan"],
      "joined GitHub searches on another website should retrieve fixed three-character prefixes");
    await press(cdp, "Tab", "Tab", 9);
    assert.equal(await hasAccessibleText(cdp, victor), false, "site scope should exclude the global GitHub result");
    await press(cdp, "Tab", "Tab", 9);
    await waitFor(() => hasAccessibleText(cdp, victor));
    assert.deepEqual(await evaluate(worker, "historyPrefixQueries"), ["his", "git", "dan"],
      "scope toggles should reuse the complete cached candidate set");
    await press(cdp, "Tab", "Tab", 9);

    for (const query of ["127.0.0.1 usual", "127.0.0.1usual", "127.0.0.1/usual"]) {
      await press(cdp, "Escape", "Escape", 27);
      await cdp.send("Input.insertText", { text: query });
      await waitFor(() => hasAccessibleText(cdp, frequent));
      assert.equal((await optionTexts(cdp)).some(text => text.includes(rare)), false,
        "combined site/page queries should exclude other destinations");
    }
    await press(cdp, "Escape", "Escape", 27);
    await cdp.send("Input.insertText", { text: "history" });
    await waitFor(() => hasAccessibleText(cdp, frequent));
    let options = await optionTexts(cdp);
    assert.ok(options[0].includes("History saved"), "saved commands should remain first");
    assert.ok(options[1].includes(rare), "shorter matching URLs should rank ahead of more visited URLs");
    assert.equal(options.filter(text => text.includes(saved)).length, 0, "saved URLs should not recur in history");
    assert.equal(options.some(text => text.includes(global)), false, "site scope excludes other hostnames");
    assert.equal(await hasAccessibleNode(cdp, "separator", "Browsing history"), true);

    const queriesBeforeScopeToggle = await evaluate(worker, "historyPrefixQueries");
    await press(cdp, "Tab", "Tab", 9);
    await waitFor(() => hasAccessibleText(cdp, global));
    assert.equal(await accessibleNodeFocused(cdp, "searchbox", "Search commands"), true);
    assert.equal(await accessibleNodeDomProperty(cdp, "searchbox", "Search commands", "placeholder"),
      "Search all commands and history");
    await press(cdp, "Tab", "Tab", 9);
    await waitFor(async () => (await optionTexts(cdp)).some(text => text.includes(frequent)));
    assert.equal((await optionTexts(cdp)).some(text => text.includes(global)), false);
    assert.deepEqual(await evaluate(worker, "historyPrefixQueries"), queriesBeforeScopeToggle,
      "site/global filtering should not trigger additional history retrieval");

    await press(cdp, "Escape", "Escape", 27);
    assert.equal(await hasAccessibleNode(cdp, "separator", "Browsing history"), false,
      "clearing search should remove history immediately");
    assert.equal((await optionTexts(cdp)).some(text => text.includes(frequent)), false);
    await press(cdp, "Tab", "Tab", 9);
    assert.equal(await hasAccessibleNode(cdp, "separator", "Browsing history"), false,
      "global scope should also show no history when search is blank");
    await press(cdp, "Tab", "Tab", 9);
    await cdp.send("Input.insertText", { text: "history" });
    await waitFor(() => hasAccessibleText(cdp, frequent));

    await evaluate(worker, `globalThis.originalPendingSearch = searchHistory;
      searchHistory = async (message, sender) => {
        const result = await originalPendingSearch(message, sender);
        if (SiteCommandPaletteCore.historySearchPrefix(message.query) === 'pen') {
          await new Promise(resolve => { globalThis.releasePendingSearch = resolve; });
        }
        return result;
      };`);
    await setHistorySearch(cdp, "pending");
    await waitFor(() => evaluate(worker, "typeof releasePendingSearch === 'function'"));
    await setHistorySearch(cdp, "pending usual");
    await evaluate(worker, "releasePendingSearch()");
    await waitFor(() => hasAccessibleText(cdp, pendingUsual));
    assert.equal((await optionTexts(cdp)).some(text => text.includes(pendingRare)), false,
      "a pending prefix response must apply the latest refinement");
    assert.equal(await evaluate(worker, "historyPrefixQueries.filter(prefix => prefix === 'pen').length"), 1);
    await evaluate(worker, "searchHistory = originalPendingSearch");
    await setHistorySearch(cdp, "history");
    await waitFor(() => hasAccessibleText(cdp, frequent));

    // Complete an older response after a newer query to verify stale results are ignored.
    await evaluate(worker, `globalThis.originalHistorySearch = searchHistory;
      searchHistory = async (message, sender) => {
        if (message.query === 'rare') globalThis.oldHistorySearchStarted = true;
        const result = await originalHistorySearch(message, sender);
        if (message.query === 'rare') {
          await new Promise(resolve => setTimeout(resolve, 400));
          globalThis.oldHistorySearchFinished = true;
        }
        return result;
      };`);
    await press(cdp, "Escape", "Escape", 27);
    await cdp.send("Input.insertText", { text: "rare" });
    // Wait for the first query to reach the worker, rather than guessing its debounce timing.
    await waitFor(() => evaluate(worker, "globalThis.oldHistorySearchStarted === true"));
    await press(cdp, "Escape", "Escape", 27);
    await cdp.send("Input.insertText", { text: "usual" });
    await waitFor(() => hasAccessibleText(cdp, frequent));
    await waitFor(() => evaluate(worker, "globalThis.oldHistorySearchFinished === true"));
    assert.equal((await optionTexts(cdp)).some(text => text.includes(rare)), false);
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    assert.equal(nodes.some(node => node.role?.value === "button" && /^(Edit|Remove) /.test(node.name?.value)), false);
    assert.equal(await hasAccessibleText(cdp, "delete"), false, "history rows have no delete shortcut");

    const before = await pageTargetCount(port);
    await press(cdp, "Enter", "Enter", 13, 2);
    await waitFor(async () => (await pageTargetCount(port)) === before + 1);
    await waitFor(async () => !(await hasPalette(cdp)));
    await openPalette(cdp);
    await cdp.send("Input.insertText", { text: "usual" });
    await waitFor(() => hasAccessibleText(cdp, frequent));
    await press(cdp, "Enter", "Enter", 13);
    await waitFor(() => evaluate(cdp, `location.href === ${JSON.stringify(frequent)}`));
  } finally {
    cdp?.close();
    worker?.close();
    if (browser) await stopProcess(browser);
    if (server.listening) await new Promise(resolve => server.close(resolve));
    await rm(workspace, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

async function optionTexts(cdp) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  return nodes.filter(node => node.role?.value === "option").map(node => node.name?.value ?? "");
}

async function setHistorySearch(cdp, query) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const node = nodes.find(node => node.role?.value === "searchbox" && node.name?.value === "Search commands");
  assert.ok(node?.backendDOMNodeId, "palette search must be accessible");
  const { object } = await cdp.send("DOM.resolveNode", { backendNodeId: node.backendDOMNodeId });
  const { result } = await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId, arguments: [{ value: query }], returnByValue: true,
    functionDeclaration: `function(query) {
      this.value = query;
      this.dispatchEvent(new Event('input', {bubbles: true}));
      return [...this.getRootNode().querySelectorAll('.command')].map(row => row.textContent);
    }`
  });
  return result.value;
}

async function verifyHistoryPermissionControls(cdp) {
  // Simulate responses from Chrome's native permission dialog; the separate
  // history fixture exercises actual API access after permission is granted.
  await waitFor(() => evaluate(cdp, "!document.getElementById('toggle-history').disabled"));
  assert.equal(await evaluate(cdp, "document.getElementById('toggle-history').textContent"), "Enable history search");
  assert.equal(await evaluate(cdp, "document.getElementById('history-state').textContent"), "Disabled");
  await evaluate(cdp, `globalThis.originalPermissions = {
      contains: chrome.permissions.contains, request: chrome.permissions.request, remove: chrome.permissions.remove
    };
    globalThis.testHistoryAccess = false;
    chrome.permissions.contains = async permissions => permissions.permissions?.includes('history')
      ? testHistoryAccess : originalPermissions.contains(permissions);
    globalThis.testHistoryRequestCount = 0;
    chrome.permissions.request = () => {
      testHistoryRequestCount++;
      return new Promise(resolve => { globalThis.resolveTestHistoryRequest = resolve; });
    };
    document.getElementById('toggle-history').click();`);
  try {
    assert.equal(await evaluate(cdp, "document.getElementById('toggle-history').disabled"), true);
    await evaluate(cdp, "document.getElementById('toggle-history').click()");
    assert.equal(await evaluate(cdp, "testHistoryRequestCount"), 1,
      "the history control must not submit another request while permission is pending");
    await evaluate(cdp, "resolveTestHistoryRequest(false)");
    await waitFor(() => evaluate(cdp, "document.getElementById('history-message').textContent === 'History access was not granted.'"));
    assert.equal(await evaluate(cdp, "document.getElementById('toggle-history').textContent"), "Enable history search");
    assert.equal(await evaluate(cdp, "document.getElementById('history-state').textContent"), "Disabled");
    await evaluate(cdp, `chrome.permissions.request = async () => { testHistoryAccess = true; return true; };
      document.getElementById('toggle-history').click();`);
    await waitFor(() => evaluate(cdp, "document.getElementById('history-message').textContent === 'Browsing history enabled.'"));
    assert.equal(await evaluate(cdp, "document.getElementById('toggle-history').textContent"), "Disable history search");
    assert.equal(await evaluate(cdp, "document.getElementById('history-state').textContent"), "Enabled");
    assert.equal(await evaluateAsync(cdp, "chrome.storage.local.get('historyEnabled').then(data => data.historyEnabled)"), true);
    await evaluate(cdp, `chrome.permissions.remove = async () => false;
      document.getElementById('toggle-history').click();`);
    await waitFor(() => evaluate(cdp, "document.getElementById('history-message').textContent === 'History access could not be removed.'"));
    assert.equal(await evaluate(cdp, "document.getElementById('toggle-history').textContent"), "Disable history search");
    assert.equal(await evaluate(cdp, "document.getElementById('history-state').textContent"), "Enabled");
    await evaluate(cdp, `chrome.permissions.remove = async () => { testHistoryAccess = false; return true; };
      document.getElementById('toggle-history').click();`);
    await waitFor(() => evaluate(cdp, "document.getElementById('history-message').textContent === 'Browsing history disabled.'"));
    assert.equal(await evaluate(cdp, "document.getElementById('toggle-history').textContent"), "Enable history search");
    assert.equal(await evaluate(cdp, "document.getElementById('history-state').textContent"), "Disabled");
    assert.equal(await evaluateAsync(cdp, "chrome.storage.local.get('historyEnabled').then(data => data.historyEnabled)"), false);
  } finally {
    await evaluate(cdp, "Object.assign(chrome.permissions, originalPermissions)");
  }
}

async function evaluateAsync(cdp, expression) {
  let timer;
  const result = await Promise.race([
    cdp.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error("Asynchronous browser evaluation timed out")), 10_000);
    })
  ]).finally(() => clearTimeout(timer));
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}

async function verifyBackupPermissionRecovery(optionsCdp, extensionTarget) {
  // OPFS exercises actual handles, IndexedDB and history writes. Permission loss
  // is simulated: headless Chromium cannot approve a native folder picker.
  const worker = await connectCdp(extensionTarget.webSocketDebuggerUrl);
  try {
    await waitFor(() => evaluate(worker, "typeof SiteCommandPaletteBackup !== 'undefined'"));
    await evaluateAsync(optionsCdp, `(async () => {
      await SiteCommandPaletteBackup.setBackupDirectory(await navigator.storage.getDirectory());
      await SiteCommandPaletteBackup.writeBackup(await SiteCommandPaletteStorage.loadStorage());
    })()`);
    await waitFor(() => evaluate(optionsCdp,
      "document.getElementById('backup-state').textContent === 'Active'"));
    await evaluateAsync(worker, `(async () => {
      globalThis.originalBackupPermission = FileSystemDirectoryHandle.prototype.queryPermission;
      FileSystemDirectoryHandle.prototype.queryPermission = async () => 'prompt';
      await SiteCommandPaletteBackup.refreshBackupStatus();
    })()`);
    await waitFor(() => evaluate(optionsCdp,
      "document.getElementById('backup-state').textContent === 'Needs permission' && document.getElementById('backup-now').textContent === 'Reconnect folder'"));
    assert.equal(await evaluateAsync(worker, "chrome.action.getBadgeText({})"), "!");
    const previousTheme = await evaluateAsync(worker, `(async () => {
      const state = await SiteCommandPaletteBackup.getBackupState();
      const file = await state.directoryHandle.getFileHandle('site-command-palette-backup.json');
      return JSON.parse(await (await file.getFile()).text()).data.settings.theme;
    })()`);
    const nextTheme = previousTheme === "dark" ? "light" : "dark";
    await evaluateAsync(worker, `(async () => {
      const data = await SiteCommandPaletteStorage.loadStorage();
      await chrome.storage.local.set({settings: {...data.settings, theme: '${nextTheme}'}});
    })()`);
    await waitFor(() => evaluateAsync(worker, `(async () => {
      return Boolean((await SiteCommandPaletteBackup.getBackupState()).lastError);
    })()`));
    assert.equal(await evaluateAsync(worker, `(async () => {
      const state = await SiteCommandPaletteBackup.getBackupState();
      const file = await state.directoryHandle.getFileHandle('site-command-palette-backup.json');
      return JSON.parse(await (await file.getFile()).text()).data.settings.theme;
    })()`), previousTheme, "permission loss must leave the existing backup intact");
    await evaluate(worker,
      "FileSystemDirectoryHandle.prototype.queryPermission = originalBackupPermission");
    // Backup Now/Reconnect retries the latest data and archives the old version.
    await evaluate(optionsCdp, `(() => {
      const query = FileSystemDirectoryHandle.prototype.queryPermission;
      const request = FileSystemDirectoryHandle.prototype.requestPermission;
      FileSystemDirectoryHandle.prototype.queryPermission = async () => 'prompt';
      FileSystemDirectoryHandle.prototype.requestPermission = async () => {
        window.backupPermissionRequested = true;
        FileSystemDirectoryHandle.prototype.queryPermission = query;
        FileSystemDirectoryHandle.prototype.requestPermission = request;
        return 'granted';
      };
    })()`);
    await evaluate(optionsCdp, "document.getElementById('backup-now').click()");
    await waitFor(() => evaluate(optionsCdp,
      "document.getElementById('backup-state').textContent === 'Active' && document.getElementById('backup-message').textContent === 'Backup completed.'"));
    assert.equal(await evaluate(optionsCdp, "window.backupPermissionRequested"), true);
    await waitFor(() => evaluateAsync(worker, `(async () => (await chrome.action.getBadgeText({})) === '')()`));
    const recovered = await evaluateAsync(worker, `(async () => {
      const state = await SiteCommandPaletteBackup.getBackupState();
      const file = await state.directoryHandle.getFileHandle('site-command-palette-backup.json');
      const history = await state.directoryHandle.getDirectoryHandle('site-command-palette-history');
      let hasPrevious = false;
      for await (const [, handle] of history.entries()) {
        const doc = JSON.parse(await (await handle.getFile()).text());
        if (doc.data.settings.theme === '${previousTheme}') hasPrevious = true;
      }
      return {theme: JSON.parse(await (await file.getFile()).text()).data.settings.theme, hasPrevious};
    })()`);
    assert.deepEqual(recovered, {theme: nextTheme, hasPrevious: true});
    // Check failure visibility on page load, before any database change.
    await evaluateAsync(worker, `(async () => {
      FileSystemDirectoryHandle.prototype.queryPermission = async () => 'prompt';
      await SiteCommandPaletteBackup.refreshBackupStatus();
    })()`);
    await optionsCdp.send("Page.reload");
    await waitFor(() => evaluate(optionsCdp,
      "document.getElementById('backup-state')?.textContent === 'Needs permission'"));
    await evaluate(worker,
      "FileSystemDirectoryHandle.prototype.queryPermission = originalBackupPermission");
    await evaluateAsync(optionsCdp, "SiteCommandPaletteBackup.clearBackupDirectory()");
  } finally {
    worker.close();
  }

}

async function verifyInvalidatedContentScript(cdp, extensionTarget, port) {
  const exceptions = [];
  cdp.onEvent(message => {
    if (message.method === "Runtime.exceptionThrown") exceptions.push(message.params);
  });
  await cdp.send("Runtime.enable");
  const worker = await connectCdp(extensionTarget.webSocketDebuggerUrl);
  try {
    await evaluate(worker, "setTimeout(() => chrome.runtime.reload(), 50)");
    await waitFor(async () => {
      const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then(response => response.json());
      return !targets.some(target => target.id === extensionTarget.id);
    });
  } finally {
    worker.close();
  }
  // The page still holds the old script and an open palette after invalidation.
  await evaluate(cdp, "window.receivedKeys = []; window.receivedKeyEvents = []");
  await press(cdp, "`", "Backquote", 192);
  await waitFor(() => evaluate(cdp,
    "!document.getElementById('site-command-palette-root')"));
  assert.equal(await evaluate(cdp, "window.receivedKeys.includes('`')"), true,
    "a stale script must release the triggering shortcut to the page");
  await press(cdp, "`", "Backquote", 192);
  assert.equal(await evaluate(cdp, "window.receivedKeys.length"), 2,
    "stale keyboard handlers must remain removed");
  assert.deepEqual(exceptions, [], "real context invalidation must not produce an uncaught exception");
}

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

async function waitForExtensionTarget(port, extensionId, errors) {
  try {
    return await waitFor(async () => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`);
        const targets = await response.json();
        return targets.find((target) => (
          target.type === "service_worker" &&
          target.url === `chrome-extension://${extensionId}/background.js`
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
  const eventListeners = [];
  let nextId = 1;

  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) {
      for (const listener of eventListeners) listener(message);
      return;
    }
    pending.get(message.id)?.(message);
    pending.delete(message.id);
  });
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  return {
    close: () => socket.close(),
    onEvent: listener => eventListeners.push(listener),
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

async function pressEnterWithKeypress(cdp) {
  const params = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 };
  await cdp.send("Input.dispatchKeyEvent", { ...params, type: "rawKeyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...params, type: "char", text: "\r" });
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
  // The host appears before storage loading, rendering, and search focus finish.
  await waitFor(async () => {
    const { nodes } = await cdp.send("Accessibility.getFullAXTree");
    return nodes.some((node) => (
      node.role?.value === "searchbox" && node.name?.value === "Search commands" &&
      node.properties?.some((property) => (
        property.name === "focused" && property.value?.value === true
      ))
    ));
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
  // The command list is hidden while an asynchronous save is still pending.
  // Let waitFor retry until a selected option is accessible again.
  if (!node?.backendDOMNodeId) return "";

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

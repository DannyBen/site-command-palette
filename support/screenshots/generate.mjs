#!/usr/bin/env node

import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { access, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const supportDirectory = path.dirname(fileURLToPath(import.meta.url));
const extensionRoot = path.resolve(supportDirectory, "../..");
const require = createRequire(import.meta.url);
const core = require(path.join(extensionRoot, "core.js"));
const configPath = path.resolve(process.argv[2] ?? path.join(supportDirectory, "config.json"));
const configDirectory = path.dirname(configPath);
const config = JSON.parse(await readFile(configPath, "utf8"));
const fixture = await readFile(path.join(supportDirectory, "fixture.html"), "utf8");

validateConfig(config);

const outputDirectory = path.resolve(configDirectory, config.outputDirectory);
const paletteCropDirectory = path.resolve(configDirectory, config.paletteCropDirectory);
const server = http.createServer((request, response) => {
  if (request.url === "/favicon.ico") {
    response.writeHead(204).end();
    return;
  }

  response.writeHead(200, {
    "Cache-Control": "no-store",
    "Content-Type": "text/html; charset=utf-8"
  });
  response.end(fixture);
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const fixtureUrl = `http://127.0.0.1:${server.address().port}/`;
const profile = await mkdtemp(path.join(os.tmpdir(), "site-command-palette-screenshots-"));
const captureExtension = config.history?.length
  ? await prepareHistoryExtension(path.join(profile, "extension"))
  : extensionRoot;
const manifest = JSON.parse(await readFile(path.join(captureExtension, "manifest.json"), "utf8"));
const extensionId = createHash("sha256").update(Buffer.from(manifest.key, "base64"))
  .digest("hex").slice(0, 32)
  .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
const chromium = await findChromium();
const browser = spawn(chromium, [
  "--headless=new",
  "--no-sandbox",
  "--disable-gpu",
  "--disable-crash-reporter",
  "--hide-scrollbars",
  `--user-data-dir=${path.join(profile, "chrome")}`,
  "--remote-debugging-address=127.0.0.1",
  "--remote-debugging-port=0",
  `--disable-extensions-except=${captureExtension}`,
  `--load-extension=${captureExtension}`,
  "about:blank"
], {
  env: {
    ...process.env,
    FONTCONFIG_FILE: path.join(supportDirectory, "fonts.conf")
  },
  stdio: ["ignore", "ignore", "pipe"]
});
let browserErrors = "";
browser.stderr.on("data", (chunk) => {
  browserErrors = `${browserErrors}${chunk}`.slice(-8_000);
});

let pageCdp;
let extensionCdp;

try {
  const port = await waitForDebuggingPort(path.join(profile, "chrome"), browser, () => browserErrors);
  const extensionTarget = await waitForExtensionTarget(port, extensionId, () => browserErrors);
  const pageTarget = await waitForPageTarget(port);
  const extensionOrigin = extensionTarget.url.replace(/\/background\.js$/, "");

  extensionCdp = await connectCdp(extensionTarget.webSocketDebuggerUrl);
  pageCdp = await connectCdp(pageTarget.webSocketDebuggerUrl);
  await extensionCdp.send("Runtime.enable");
  await extensionCdp.send("Runtime.runIfWaitingForDebugger");
  await waitFor(() => evaluate(extensionCdp, "Boolean(globalThis.SiteCommandPaletteCore)"));
  await pageCdp.send("Page.enable");
  if (config.history?.length) {
    await seedHistory(pageCdp, config.history);
    await evaluateAsync(extensionCdp, "refreshHistoryAccess()");
    await waitFor(() => evaluateAsync(extensionCdp, `(async () => {
      const items = await chrome.history.search({ text: '', startTime: 0, maxResults: 0 });
      return ${JSON.stringify(config.history)}.every(entry =>
        items.some(item => item.url === entry.url && item.title === entry.title));
    })()`));
  }
  await pageCdp.send("Accessibility.enable");
  await pageCdp.send("Emulation.setDeviceMetricsOverride", {
    width: config.viewport.width,
    height: config.viewport.height,
    deviceScaleFactor: config.viewport.deviceScaleFactor,
    mobile: false
  });
  await pageCdp.send("Emulation.setEmulatedMedia", {
    features: [{ name: "prefers-reduced-motion", value: "reduce" }]
  });
  await mkdir(outputDirectory, { recursive: true });
  await mkdir(paletteCropDirectory, { recursive: true });

  for (const screenshot of config.screenshots) {
    const commands = screenshot.commands ?? config.commands ?? [];
    const storage = buildStorage(screenshot, commands, fixtureUrl);
    await seedStorage(extensionCdp, storage);

    if (screenshot.screen === "settings") {
      await navigate(pageCdp, `${extensionOrigin}/options.html`);
      await waitFor(() => evaluate(
        pageCdp,
        `document.readyState === 'complete' &&
          document.getElementById('extension-version')?.textContent.includes(${JSON.stringify(manifest.version)}) &&
          document.getElementById('global-theme')?.value === ${JSON.stringify(screenshot.theme)}`
      ));
    } else {
      await navigate(pageCdp, `${fixtureUrl}?screenshot=${encodeURIComponent(screenshot.name)}`);
      await waitFor(() => evaluate(pageCdp, "document.readyState === 'complete'"));
      await openPalette(pageCdp);
      await preparePaletteScreen(pageCdp, screenshot);
      if (screenshot.historyResults) {
        await waitFor(() => hasAccessibleNode(pageCdp, "separator", "Browsing history"));
      }
      if (screenshot.screen === "list") {
        await setAccessibleNodeStyle(
          pageCdp,
          "searchbox",
          "Search commands",
          "caretColor",
          "transparent"
        );
      }
    }

    await new Promise((resolve) => setTimeout(resolve, 150));
    const { data } = await pageCdp.send("Page.captureScreenshot", {
      format: "png",
      fromSurface: true,
      captureBeyondViewport: false
    });
    const image = Buffer.from(data, "base64");
    validatePng(image, {
      width: Math.round(config.viewport.width * config.viewport.deviceScaleFactor),
      height: Math.round(config.viewport.height * config.viewport.deviceScaleFactor)
    });
    const outputPath = path.join(outputDirectory, `${screenshot.name}.png`);
    await writeFile(outputPath, image);
    process.stdout.write(`Created ${path.relative(extensionRoot, outputPath)}\n`);

    if (screenshot.paletteCrop) {
      const bounds = await accessibleNodeBounds(
        pageCdp,
        "dialog",
        "Site command palette"
      );
      await isolateAccessibleNode(pageCdp, "dialog", "Site command palette");
      await pageCdp.send("Emulation.setDefaultBackgroundColorOverride", {
        color: { r: 0, g: 0, b: 0, a: 0 }
      });
      const { data: cropData } = await pageCdp.send("Page.captureScreenshot", {
        format: "png",
        fromSurface: true,
        captureBeyondViewport: false,
        clip: { ...bounds, scale: 1 }
      });
      await pageCdp.send("Emulation.setDefaultBackgroundColorOverride");
      const crop = Buffer.from(cropData, "base64");
      validateTransparentPng(crop);
      const cropPath = path.join(paletteCropDirectory, `${screenshot.name}.png`);
      await writeFile(cropPath, crop);
      process.stdout.write(`Created ${path.relative(extensionRoot, cropPath)}\n`);
    }
  }
} finally {
  pageCdp?.close();
  extensionCdp?.close();
  await stopProcess(browser);
  await new Promise((resolve) => server.close(resolve));
  await rm(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}

function validateConfig(value) {
  if (!Number.isInteger(value.viewport?.width) || !Number.isInteger(value.viewport?.height)) {
    throw new Error("viewport width and height must be integers");
  }
  if (!(value.viewport.deviceScaleFactor > 0)) {
    throw new Error("viewport deviceScaleFactor must be positive");
  }
  const captureWidth = Math.round(value.viewport.width * value.viewport.deviceScaleFactor);
  const captureHeight = Math.round(value.viewport.height * value.viewport.deviceScaleFactor);
  if (captureWidth !== 1280 || captureHeight !== 800) {
    throw new Error("the viewport and deviceScaleFactor must produce a 1280x800 Store image");
  }
  if (typeof value.outputDirectory !== "string" || !value.outputDirectory) {
    throw new Error("outputDirectory is required");
  }
  if (typeof value.paletteCropDirectory !== "string" || !value.paletteCropDirectory) {
    throw new Error("paletteCropDirectory is required");
  }
  if (!Array.isArray(value.screenshots) || value.screenshots.length === 0) {
    throw new Error("screenshots must contain at least one entry");
  }
  if (value.history !== undefined && (!Array.isArray(value.history) ||
      value.history.some(entry => !core.normalizeUrl(entry?.url) ||
        typeof entry.title !== "string" || !entry.title.trim()))) {
    throw new Error("history entries require an HTTP or HTTPS url and a nonblank title");
  }

  const names = new Set();
  for (const screenshot of value.screenshots) {
    if (!/^[a-z0-9-]+$/.test(screenshot.name ?? "")) {
      throw new Error("screenshot names may contain lowercase letters, numbers, and hyphens");
    }
    if (names.has(screenshot.name)) throw new Error(`duplicate screenshot name: ${screenshot.name}`);
    names.add(screenshot.name);
    if (!["list", "add", "edit", "settings"].includes(screenshot.screen)) {
      throw new Error(`unsupported screen for ${screenshot.name}`);
    }
    if (!["light", "dark"].includes(screenshot.theme)) {
      throw new Error(`unsupported theme for ${screenshot.name}`);
    }
    if (screenshot.paletteScope && !["site", "all"].includes(screenshot.paletteScope)) {
      throw new Error(`unsupported paletteScope for ${screenshot.name}`);
    }
    if (screenshot.paletteCrop !== undefined && typeof screenshot.paletteCrop !== "boolean") {
      throw new Error(`paletteCrop for ${screenshot.name} must be boolean`);
    }
    if (screenshot.paletteCrop && screenshot.screen !== "list") {
      throw new Error(`paletteCrop requires a list screen for ${screenshot.name}`);
    }
    if (screenshot.historyResults !== undefined && typeof screenshot.historyResults !== "boolean") {
      throw new Error(`historyResults for ${screenshot.name} must be boolean`);
    }
    if (screenshot.historyResults && (screenshot.screen !== "list" ||
        !value.history?.length || !core.historySearchPrefix(screenshot.query ?? ""))) {
      throw new Error(`historyResults requires a list screen, seeded history, and a query of at least three characters for ${screenshot.name}`);
    }
    if (screenshot.form) {
      if (!["add", "edit"].includes(screenshot.screen)) {
        throw new Error(`form values require an add or edit screen for ${screenshot.name}`);
      }
      if (!["site", "page", "url", "scope"].every((field) => (
        typeof screenshot.form[field] === "string" && screenshot.form[field].trim()
      ))) {
        throw new Error(`form values for ${screenshot.name} require site, page, url, and scope`);
      }
      if (screenshot.form.preserveScopePreset !== undefined &&
        typeof screenshot.form.preserveScopePreset !== "boolean") {
        throw new Error(`preserveScopePreset for ${screenshot.name} must be boolean`);
      }
    }
    if (screenshot.focus && (
      !["add", "edit"].includes(screenshot.screen) ||
      !["Site", "Page", "URL", "Scope"].includes(screenshot.focus)
    )) {
      throw new Error(`unsupported focus target for ${screenshot.name}`);
    }
    validateCommands(screenshot.commands ?? value.commands ?? [], screenshot.name);
  }
}

function validateCommands(commands, screenshotName) {
  if (!Array.isArray(commands)) throw new Error(`commands for ${screenshotName} must be an array`);
  for (const command of commands) {
    if (![command.site, command.page, command.url].every((part) => (
      typeof part === "string" && part.trim()
    ))) {
      throw new Error(`every command for ${screenshotName} needs site, page, and url`);
    }
    if (command.scope && command.scope !== "global" && command.scope !== "site" &&
      !core.normalizeScope(command.scope)) {
      throw new Error(`invalid command scope in ${screenshotName}: ${command.scope}`);
    }
  }
}

function buildStorage(screenshot, commands, fixtureBaseUrl) {
  const commandsByScope = {};
  const sitesByHostname = {};

  commands.forEach((configuredCommand, index) => {
    const url = configuredCommand.url.startsWith("fixture:")
      ? new URL(configuredCommand.url.slice("fixture:".length), fixtureBaseUrl).href
      : configuredCommand.url;
    const normalizedUrl = core.normalizeUrl(url);
    if (!normalizedUrl) throw new Error(`invalid command URL: ${configuredCommand.url}`);

    const scope = configuredCommand.scope === "site"
      ? new URL(fixtureBaseUrl).hostname
      : configuredCommand.scope === "global" || !configuredCommand.scope
        ? "*"
        : core.normalizeScope(configuredCommand.scope);
    commandsByScope[scope] ??= [];
    commandsByScope[scope].push({
      id: `screenshot-command-${index + 1}`,
      page: configuredCommand.page.trim(),
      url: normalizedUrl
    });

    const hostname = core.siteIdentity(normalizedUrl);
    const previousName = sitesByHostname[hostname]?.name;
    if (previousName && previousName !== configuredCommand.site.trim()) {
      throw new Error(`commands for ${hostname} use conflicting site names`);
    }
    sitesByHostname[hostname] = { name: configuredCommand.site.trim() };
  });

  const data = core.migrateStorage({
    [core.STORAGE_SCHEMA_VERSION_KEY]: core.STORAGE_SCHEMA_VERSION,
    [core.COMMANDS_STORAGE_KEY]: commandsByScope,
    [core.SITES_STORAGE_KEY]: sitesByHostname,
    [core.SETTINGS_STORAGE_KEY]: { theme: screenshot.theme }
  }).data;

  return {
    ...data,
    [core.HISTORY_ENABLED_STORAGE_KEY]: Boolean(config.history?.length),
    commandScope: screenshot.paletteScope === "all" ? "all" : "site"
  };
}

async function prepareHistoryExtension(directory) {
  const manifest = JSON.parse(await readFile(path.join(extensionRoot, "manifest.json"), "utf8"));
  // Headless Chrome cannot show optional-permission prompts. Grant history only
  // in this temporary copy so screenshots exercise the real API with sample URLs.
  manifest.permissions.push("history");
  manifest.optional_permissions = manifest.optional_permissions.filter(permission => permission !== "history");
  const files = new Set([
    "background.js", "core.js", "storage.js", "backup.js", "content.js", "palette.css",
    "popup.html", "popup.js", "popup.css", "options.html", "options.js", "options.css",
    ...Object.values(manifest.icons),
    ...manifest.web_accessible_resources.flatMap(entry => entry.resources)
  ]);
  await mkdir(directory);
  for (const file of files) {
    const destination = path.join(directory, file);
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(path.join(extensionRoot, file), destination);
  }
  await writeFile(path.join(directory, "manifest.json"), JSON.stringify(manifest));
  return directory;
}

async function seedHistory(cdp, entries) {
  // Fulfill each navigation locally so Chrome records real titles and URLs
  // without contacting the sample sites or loading third-party content.
  await cdp.send("Fetch.enable", { patterns: [{ resourceType: "Document" }] });
  try {
    for (const entry of entries) {
      const paused = cdp.once("Fetch.requestPaused");
      const navigation = cdp.send("Page.navigate", { url: entry.url });
      const request = await paused;
      const title = entry.title.replace(/[&<>]/g, character => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;"
      })[character]);
      await cdp.send("Fetch.fulfillRequest", {
        requestId: request.requestId,
        responseCode: 200,
        responseHeaders: [{ name: "Content-Type", value: "text/html; charset=utf-8" }],
        body: Buffer.from(`<!doctype html><title>${title}</title><link rel="icon" href="data:,">`).toString("base64")
      });
      await navigation;
      await waitFor(() => evaluate(cdp,
        `document.readyState === 'complete' && document.title === ${JSON.stringify(entry.title)}`));
    }
  } finally {
    await cdp.send("Fetch.disable");
  }
}

async function seedStorage(cdp, storage) {
  const expression = `chrome.storage.local.set(${JSON.stringify(storage)})`;
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(
      result.exceptionDetails.exception?.description ?? result.exceptionDetails.text
    );
  }
}

async function preparePaletteScreen(cdp, screenshot) {
  if (screenshot.query) {
    await setAccessibleInputValue(cdp, "searchbox", "Search commands", screenshot.query);
    await waitFor(() => hasAccessibleNode(cdp, "option"));
  }

  if (screenshot.screen === "add") {
    await press(cdp, "a", "KeyA", 65, 1);
    await waitFor(() => hasAccessibleNode(cdp, "heading", "Add command"));
  }

  if (screenshot.screen === "edit") {
    await press(cdp, "e", "KeyE", 69, 1);
    await waitFor(() => hasAccessibleNode(cdp, "heading", "Edit command"));
  }

  if (screenshot.form) {
    await setAccessibleInputValue(cdp, "textbox", "Site", screenshot.form.site);
    await setAccessibleInputValue(cdp, "textbox", "Page", screenshot.form.page);
    await setAccessibleInputValue(cdp, "textbox", "URL", screenshot.form.url);
    await setAccessibleInputValue(
      cdp,
      "textbox",
      "Scope",
      screenshot.form.scope,
      !screenshot.form.preserveScopePreset
    );
  }

  if (screenshot.focus) {
    await focusAccessibleNode(cdp, "textbox", screenshot.focus);
  }
}

async function navigate(cdp, url) {
  await cdp.send("Page.navigate", { url });
  await waitFor(() => evaluate(cdp, `location.href === ${JSON.stringify(url)}`));
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

async function waitForDebuggingPort(profileDirectory, child, errors) {
  const activePortFile = path.join(profileDirectory, "DevToolsActivePort");
  return waitFor(async () => {
    if (child.exitCode !== null) {
      throw new Error(`Chromium exited with ${child.exitCode}\n${errors()}`);
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
    const targets = await listTargets(port);
    return targets.find((target) => target.type === "page" && target.url === "about:blank");
  });
}

async function waitForExtensionTarget(port, extensionId, errors) {
  try {
    return await waitFor(async () => {
      const targets = await listTargets(port);
      return targets.find((target) => (
        target.type === "service_worker" &&
        target.url.startsWith(`chrome-extension://${extensionId}/`) &&
        target.url.endsWith("/background.js")
      ));
    }, 15_000);
  } catch {
    throw new Error(`Extension service worker did not start\n${errors()}`);
  }
}

async function listTargets(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/list`);
    return response.json();
  } catch {
    return [];
  }
}

async function connectCdp(url) {
  const socket = new WebSocket(url);
  const pending = new Map();
  const events = new Map();
  let nextId = 1;

  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data);
    if (!message.id) {
      events.get(message.method)?.(message.params);
      events.delete(message.method);
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
    once: method => new Promise(resolve => events.set(method, resolve)),
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

async function evaluateAsync(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression, awaitPromise: true, returnByValue: true
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  }
  return result.result.value;
}

async function press(cdp, key, code, windowsVirtualKeyCode, modifiers = 0) {
  const params = { key, code, windowsVirtualKeyCode, modifiers };
  await cdp.send("Input.dispatchKeyEvent", { ...params, type: "rawKeyDown" });
  await cdp.send("Input.dispatchKeyEvent", { ...params, type: "keyUp" });
}

async function openPalette(cdp) {
  await waitFor(async () => {
    if (await evaluate(cdp, "Boolean(document.getElementById('site-command-palette-root'))")) {
      return true;
    }
    await press(cdp, "`", "Backquote", 192);
    return evaluate(cdp, "Boolean(document.getElementById('site-command-palette-root'))");
  });
  await waitFor(() => hasAccessibleNode(cdp, "searchbox", "Search commands"));
}

async function hasAccessibleNode(cdp, role, name = null) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  return nodes.some((node) => (
    node.role?.value === role && (name === null || node.name?.value === name)
  ));
}

async function setAccessibleInputValue(cdp, role, name, value, dispatchInput = true) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const node = nodes.find((candidate) => (
    candidate.role?.value === role && candidate.name?.value === name
  ));
  if (!node?.backendDOMNodeId) throw new Error(`${role} named “${name}” was not found`);

  const { object } = await cdp.send("DOM.resolveNode", {
    backendNodeId: node.backendDOMNodeId
  });
  await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `function(value, dispatchInput) {
      this.focus();
      this.value = value;
      if (dispatchInput) this.dispatchEvent(new Event('input', { bubbles: true }));
    }`,
    arguments: [{ value }, { value: dispatchInput }]
  });
}

async function focusAccessibleNode(cdp, role, name) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const node = nodes.find((candidate) => (
    candidate.role?.value === role && candidate.name?.value === name
  ));
  if (!node?.backendDOMNodeId) throw new Error(`${role} named “${name}” was not found`);

  const { object } = await cdp.send("DOM.resolveNode", {
    backendNodeId: node.backendDOMNodeId
  });
  await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `function() {
      this.focus();
      this.setSelectionRange?.(this.value.length, this.value.length);
    }`
  });
}

async function setAccessibleNodeStyle(cdp, role, name, property, value) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const node = nodes.find((candidate) => (
    candidate.role?.value === role && candidate.name?.value === name
  ));
  if (!node?.backendDOMNodeId) throw new Error(`${role} named “${name}” was not found`);

  const { object } = await cdp.send("DOM.resolveNode", {
    backendNodeId: node.backendDOMNodeId
  });
  await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: "function(property, value) { this.style[property] = value; }",
    arguments: [{ value: property }, { value }]
  });
}

async function accessibleNodeBounds(cdp, role, name) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const node = nodes.find((candidate) => (
    candidate.role?.value === role && candidate.name?.value === name
  ));
  if (!node?.backendDOMNodeId) throw new Error(`${role} named “${name}” was not found`);

  const { object } = await cdp.send("DOM.resolveNode", {
    backendNodeId: node.backendDOMNodeId
  });
  const { result } = await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `function() {
      const bounds = this.getBoundingClientRect();
      return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height };
    }`,
    returnByValue: true
  });
  return result.value;
}

async function isolateAccessibleNode(cdp, role, name) {
  const { nodes } = await cdp.send("Accessibility.getFullAXTree");
  const node = nodes.find((candidate) => (
    candidate.role?.value === role && candidate.name?.value === name
  ));
  if (!node?.backendDOMNodeId) throw new Error(`${role} named “${name}” was not found`);

  const { object } = await cdp.send("DOM.resolveNode", {
    backendNodeId: node.backendDOMNodeId
  });
  await cdp.send("Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: `function() {
      document.body.style.display = 'none';
      document.documentElement.style.background = 'transparent';
      this.parentElement.style.background = 'transparent';
    }`
  });
}

function validatePng(image, viewport) {
  const signature = image.subarray(0, 8).toString("hex");
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  const colorType = image[25];
  if (signature !== "89504e470d0a1a0a") throw new Error("capture is not a PNG file");
  if (width !== viewport.width || height !== viewport.height) {
    throw new Error(`capture is ${width}x${height}; expected ${viewport.width}x${viewport.height}`);
  }
  if (colorType !== 2) throw new Error("capture must be an opaque 24-bit PNG");
}

function validateTransparentPng(image) {
  const signature = image.subarray(0, 8).toString("hex");
  const width = image.readUInt32BE(16);
  const height = image.readUInt32BE(20);
  const colorType = image[25];
  if (signature !== "89504e470d0a1a0a") throw new Error("palette crop is not a PNG file");
  if (width === 0 || height === 0) throw new Error("palette crop is empty");
  if (colorType !== 6) throw new Error("palette crop must be a transparent RGBA PNG");
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

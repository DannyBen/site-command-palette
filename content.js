(() => {
  const STORAGE_KEY = "commandsByHostname";
  const HOST_ID = "site-command-palette-root";
  const stylesheet = fetch(chrome.runtime.getURL("palette.css")).then((response) => {
    if (!response.ok) throw new Error("Could not load palette styles");
    return response.text();
  });

  let palette = null;
  let commands = [];
  let filteredCommands = [];
  let selectedIndex = 0;
  let opening = false;
  let editingCommandId = null;
  const suppressedKeyups = new Set();

  window.addEventListener("keydown", handlePageKeydown, true);
  window.addEventListener("keypress", suppressPageKeyEvent, true);
  window.addEventListener("keyup", suppressPageKeyEvent, true);

  function handlePageKeydown(event) {
    if (palette) {
      suppressedKeyups.add(event.code);
      event.stopImmediatePropagation();
      handlePaletteKeydown(event);
      return;
    }

    const noOtherModifiers = !event.ctrlKey && !event.metaKey && !event.shiftKey;
    const altBacktick = event.altKey && noOtherModifiers;
    const bareBacktick = !event.altKey && noOtherModifiers && !isEditable(event.composedPath()[0]);

    if (event.code !== "Backquote" || event.repeat || opening || (!altBacktick && !bareBacktick)) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    suppressedKeyups.add(event.code);
    openPalette();
  }

  function isEditable(target) {
    if (!(target instanceof Element)) return false;

    return Boolean(
      target.closest("input, textarea, select, [contenteditable]:not([contenteditable='false'])")
    );
  }

  function handlePaletteKeydown(event) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();

      if (palette.mode === "add") {
        showCommandList();
      } else if (palette.search.value) {
        palette.search.value = "";
        filterAndRender();
        palette.search.focus();
      } else {
        closePalette();
      }
      return;
    }

    if (palette.mode !== "list") return;

    if (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      event.key.toLocaleLowerCase() === "a"
    ) {
      event.preventDefault();
      showAddForm();
      return;
    }

    if (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      event.key.toLocaleLowerCase() === "e" &&
      filteredCommands.length > 0
    ) {
      event.preventDefault();
      showEditForm(filteredCommands[selectedIndex]);
      return;
    }

    if (
      event.altKey &&
      !event.ctrlKey &&
      !event.metaKey &&
      event.key.toLocaleLowerCase() === "x" &&
      filteredCommands.length > 0
    ) {
      event.preventDefault();
      removeCommand(filteredCommands[selectedIndex].id);
      return;
    }

    const target = palette.root.activeElement;
    if (target !== palette.search) return;

    if (event.key === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      moveSelection(-1);
    } else if (event.key === "Enter" && filteredCommands.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      visitCommand(filteredCommands[selectedIndex]);
    }
  }

  function suppressPageKeyEvent(event) {
    const shouldSuppress = palette || opening || suppressedKeyups.has(event.code);
    if (!shouldSuppress) return;

    event.stopImmediatePropagation();
    if (event.type === "keyup") suppressedKeyups.delete(event.code);
  }

  async function openPalette() {
    opening = true;
    const existingHost = document.getElementById(HOST_ID);
    if (existingHost) existingHost.remove();

    const host = document.createElement("div");
    host.id = HOST_ID;
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    const overlay = document.createElement("div");

    try {
      style.textContent = await stylesheet;
    } catch (error) {
      opening = false;
      console.error("Site Command Palette:", error);
      return;
    }
    overlay.className = "overlay";
    overlay.innerHTML = `
      <section class="palette" role="dialog" aria-modal="true" aria-label="Site command palette">
        <div class="list-view">
          <header>
            <input class="search" type="search" autocomplete="off" spellcheck="false"
              aria-label="Search commands" placeholder="Search ${escapeHtml(location.hostname)} commands">
          </header>
          <div class="commands" role="listbox" aria-label="Commands"></div>
          <footer>
            <span><kbd>↑</kbd><kbd>↓</kbd> select · <kbd>Enter</kbd> open · <kbd>Alt</kbd>+<kbd>A</kbd> add · <kbd>Alt</kbd>+<kbd>E</kbd> edit · <kbd>Alt</kbd>+<kbd>X</kbd> delete · <kbd>Esc</kbd> close</span>
          </footer>
        </div>
        <form class="add-view" hidden>
          <h1 class="form-title">Add command</h1>
          <label>
            Name
            <input class="name" name="name" required autocomplete="off">
          </label>
          <label>
            URL
            <input class="url" name="url" required type="url" autocomplete="off">
          </label>
          <p class="error" role="alert" hidden></p>
          <div class="form-actions">
            <button class="cancel-button" type="button">Cancel</button>
            <button class="save-button" type="submit">Save command</button>
          </div>
        </form>
      </section>
    `;

    root.append(style, overlay);
    document.documentElement.append(host);
    opening = false;

    palette = {
      host,
      root,
      overlay,
      mode: "list",
      listView: overlay.querySelector(".list-view"),
      addView: overlay.querySelector(".add-view"),
      search: overlay.querySelector(".search"),
      commandList: overlay.querySelector(".commands"),
      name: overlay.querySelector(".name"),
      url: overlay.querySelector(".url"),
      error: overlay.querySelector(".error"),
      formTitle: overlay.querySelector(".form-title"),
      saveButton: overlay.querySelector(".save-button")
    };

    overlay.addEventListener("click", handleOverlayClick);
    palette.search.addEventListener("input", filterAndRender);
    overlay.querySelector(".cancel-button").addEventListener("click", showCommandList);
    palette.addView.addEventListener("submit", saveCommand);

    commands = await loadCommands();

    if (!palette) return;
    filterAndRender();
    palette.search.focus();
  }

  function closePalette() {
    if (!palette) return;
    palette.host.remove();
    palette = null;
  }

  function handleOverlayClick(event) {
    if (event.target === palette.overlay) {
      closePalette();
      return;
    }

    const openButton = event.target.closest("[data-open-command]");
    if (openButton) {
      visitCommand(filteredCommands[Number(openButton.dataset.openCommand)]);
      return;
    }

    const removeButton = event.target.closest("[data-remove-command]");
    if (removeButton) removeCommand(removeButton.dataset.removeCommand);
  }

  function showAddForm() {
    editingCommandId = null;
    palette.mode = "add";
    palette.listView.hidden = true;
    palette.addView.hidden = false;
    palette.formTitle.textContent = "Add command";
    palette.saveButton.textContent = "Save command";
    palette.name.value = document.title.trim() || location.hostname;
    palette.url.value = location.href;
    setError("");
    palette.name.select();
  }

  function showEditForm(command) {
    editingCommandId = command.id;
    palette.mode = "add";
    palette.listView.hidden = true;
    palette.addView.hidden = false;
    palette.formTitle.textContent = "Edit command";
    palette.saveButton.textContent = "Update command";
    palette.name.value = command.name;
    palette.url.value = command.url;
    setError("");
    palette.name.select();
  }

  function showCommandList() {
    editingCommandId = null;
    palette.mode = "list";
    palette.addView.hidden = true;
    palette.listView.hidden = false;
    palette.search.focus();
  }

  async function saveCommand(event) {
    event.preventDefault();

    const name = palette.name.value.trim();
    const url = normalizeUrl(palette.url.value);

    if (!name) {
      setError("Enter a command name.");
      palette.name.focus();
      return;
    }

    if (!url) {
      setError("Enter a valid HTTP or HTTPS URL.");
      palette.url.focus();
      return;
    }

    if (editingCommandId) {
      commands = commands.map((command) => (
        command.id === editingCommandId ? { ...command, name, url } : command
      ));
    } else {
      commands.push({ id: crypto.randomUUID(), name, url });
    }
    await storeCommands(commands);
    palette.search.value = "";
    showCommandList();
    filterAndRender();
  }

  async function removeCommand(id) {
    commands = commands.filter((command) => command.id !== id);
    await storeCommands(commands);
    filterAndRender();
  }

  function filterAndRender() {
    if (!palette) return;

    const query = palette.search.value.trim();
    filteredCommands = commands
      .map((command) => {
        const match = fuzzyMatch(query, command.name);
        return match ? { ...command, match } : null;
      })
      .filter(Boolean)
      .sort((left, right) => right.match.score - left.match.score || left.name.localeCompare(right.name));

    selectedIndex = 0;
    renderCommands();
  }

  function renderCommands() {
    palette.commandList.replaceChildren();

    if (filteredCommands.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = commands.length === 0
        ? `No commands saved for ${location.hostname}.`
        : "No matching commands.";
      palette.commandList.append(empty);
      return;
    }

    filteredCommands.forEach((command, index) => {
      const row = document.createElement("div");
      const openButton = document.createElement("button");
      const label = document.createElement("strong");
      const address = document.createElement("span");
      const removeButton = document.createElement("button");

      row.className = "command";
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === selectedIndex));

      openButton.type = "button";
      openButton.className = "open-command";
      openButton.dataset.openCommand = String(index);
      appendHighlightedText(label, command.name, command.match.indices);
      address.textContent = compactUrl(command.url);
      address.title = command.url;
      openButton.append(label, address);

      removeButton.type = "button";
      removeButton.className = "remove-command";
      removeButton.dataset.removeCommand = command.id;
      removeButton.setAttribute("aria-label", `Remove ${command.name}`);
      removeButton.title = "Remove command";
      removeButton.textContent = "×";

      row.append(openButton, removeButton);
      palette.commandList.append(row);
    });
  }

  function moveSelection(offset) {
    if (filteredCommands.length === 0) return;

    selectedIndex = (selectedIndex + offset + filteredCommands.length) % filteredCommands.length;
    renderCommands();
    palette.commandList.children[selectedIndex]?.scrollIntoView({ block: "nearest" });
  }

  function visitCommand(command) {
    if (command) location.href = command.url;
  }

  async function loadCommands() {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return result[STORAGE_KEY]?.[location.hostname] ?? [];
  }

  async function storeCommands(siteCommands) {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    const commandsByHostname = result[STORAGE_KEY] ?? {};

    commandsByHostname[location.hostname] = siteCommands;
    await chrome.storage.local.set({ [STORAGE_KEY]: commandsByHostname });
  }

  function normalizeUrl(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) ? url.href : null;
    } catch {
      return null;
    }
  }

  function fuzzyMatch(query, candidate) {
    if (!query) return { score: 0, indices: [] };

    const needle = query.toLocaleLowerCase();
    const haystack = candidate.toLocaleLowerCase();
    const indices = [];
    let score = 0;
    let needleIndex = 0;
    let previousMatch = -2;

    for (let index = 0; index < haystack.length && needleIndex < needle.length; index += 1) {
      if (haystack[index] !== needle[needleIndex]) continue;

      score += 1;
      if (index === 0 || /[\s/_-]/.test(haystack[index - 1])) score += 4;
      if (index === previousMatch + 1) score += 2;
      previousMatch = index;
      indices.push(index);
      needleIndex += 1;
    }

    if (needleIndex !== needle.length) return null;
    if (haystack.startsWith(needle)) score += 8;
    return { score: score - haystack.length * 0.01, indices };
  }

  function appendHighlightedText(element, value, indices) {
    const matchedIndices = new Set(indices);

    for (let index = 0; index < value.length; index += 1) {
      if (matchedIndices.has(index)) {
        const mark = document.createElement("mark");
        mark.textContent = value[index];
        element.append(mark);
      } else {
        element.append(document.createTextNode(value[index]));
      }
    }
  }

  function compactUrl(value) {
    const url = new URL(value);
    const path = `${url.pathname}${url.search}${url.hash}` || "/";
    return middleEllipsis(path, 42);
  }

  function middleEllipsis(value, maximumLength) {
    if (value.length <= maximumLength) return value;

    const visibleLength = maximumLength - 1;
    const startLength = Math.ceil(visibleLength / 2);
    const endLength = Math.floor(visibleLength / 2);
    return `${value.slice(0, startLength)}…${value.slice(-endLength)}`;
  }

  function setError(message) {
    palette.error.textContent = message;
    palette.error.hidden = !message;
  }

  function escapeHtml(value) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }
})();

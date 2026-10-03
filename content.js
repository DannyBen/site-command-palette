(() => {
  const {
    findCommandNameConflict,
    formatKeyBinding,
    fuzzyMatch,
    isSiteDisabled,
    isCommandExternal,
    keyBindingHasModifier,
    matchesKeyBinding,
    normalizeCommandsByScope,
    normalizeScope,
    normalizeSettings,
    normalizeSites,
    normalizeUrl,
    resolveAllCommands,
    resolveTheme,
    resolveCommandsForLocation,
    siteIdentity,
    siteNameForUrl,
    suggestPageName,
    suggestSiteName,
    urlMatchesPage
  } = globalThis.SiteCommandPaletteCore;
  const {
    COMMANDS_STORAGE_KEY,
    SITES_STORAGE_KEY,
    SETTINGS_STORAGE_KEY,
    loadStorage
  } = globalThis.SiteCommandPaletteStorage;
  const HOST_ID = "site-command-palette-root";
  const COMMAND_SCOPE_STORAGE_KEY = "commandScope";

  let palette = null;
  let commandsByScope = {};
  let sitesByHostname = {};
  let commands = [];
  let settings = normalizeSettings();
  let filteredItems = [];
  let selectedIndex = 0;
  let showAllCommands = false;
  let opening = false;
  let editingCommandId = null;
  let editingCommandScope = null;
  let formSiteHostname = null;
  let siteNameEdited = false;
  let stylesheet = null;
  let systemTheme = null;
  let enabled = false;
  const suppressedKeyups = new Set();

  initialize();

  async function initialize() {
    try {
      const stored = await loadStorage();
      settings = stored[SETTINGS_STORAGE_KEY];
      if (isSiteDisabled(settings, location)) return;

      const storedScope = await chrome.storage.local.get(COMMAND_SCOPE_STORAGE_KEY);
      showAllCommands = storedScope[COMMAND_SCOPE_STORAGE_KEY] === "all";

      stylesheet = fetch(chrome.runtime.getURL("palette.css")).then((response) => {
        if (!response.ok) throw new Error("Could not load palette styles");
        return response.text();
      });
      systemTheme = matchMedia("(prefers-color-scheme: dark)");
      enabled = true;
      window.addEventListener("keydown", handlePageKeydown, true);
      window.addEventListener("keypress", suppressPageKeyEvent, true);
      window.addEventListener("keyup", suppressPageKeyEvent, true);
      window.addEventListener("blur", clearSuppressedKeys);
      window.addEventListener("hashchange", handlePageNavigation);
      window.addEventListener("popstate", handlePageNavigation);
      globalThis.navigation?.addEventListener("navigate", handlePageNavigation);
      globalThis.navigation?.addEventListener("currententrychange", handlePageNavigation);
      chrome.storage.onChanged.addListener(handleStorageChange);
      systemTheme.addEventListener("change", applyTheme);
    } catch (error) {
      handleExtensionError(error, "Site Command Palette settings failed to load:");
    }
  }

  function hasExtensionContext() {
    try {
      return Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function ensureExtensionContext() {
    if (hasExtensionContext()) return true;
    disableCurrentSite(false);
    return false;
  }

  function handleExtensionError(error, message) {
    if (!hasExtensionContext() || error?.message?.includes("Extension context invalidated")) {
      disableCurrentSite(false);
      return;
    }
    console.error(message, error);
  }

  function disableCurrentSite(removeStorageListener = true) {
    enabled = false;
    opening = false;
    window.removeEventListener("keydown", handlePageKeydown, true);
    window.removeEventListener("keypress", suppressPageKeyEvent, true);
    window.removeEventListener("keyup", suppressPageKeyEvent, true);
    window.removeEventListener("blur", clearSuppressedKeys);
    window.removeEventListener("hashchange", handlePageNavigation);
    window.removeEventListener("popstate", handlePageNavigation);
    globalThis.navigation?.removeEventListener("navigate", handlePageNavigation);
    globalThis.navigation?.removeEventListener("currententrychange", handlePageNavigation);
    if (removeStorageListener) chrome.storage.onChanged.removeListener(handleStorageChange);
    systemTheme?.removeEventListener("change", applyTheme);
    document.getElementById(HOST_ID)?.remove();
    palette = null;
    stylesheet = null;
    systemTheme = null;
    commandsByScope = {};
    sitesByHostname = {};
    commands = [];
    filteredItems = [];
    suppressedKeyups.clear();
  }

  function handlePageKeydown(event) {
    if (!ensureExtensionContext()) return;
    // A fresh press starts a new sequence, even if an earlier keyup was lost.
    if (!event.repeat) suppressedKeyups.delete(event.code);

    if (palette) {
      suppressedKeyups.add(event.code);
      event.stopImmediatePropagation();

      if (isPaletteShortcut(event, true)) {
        event.preventDefault();
        closePalette();
      } else {
        handlePaletteKeydown(event);
      }

      // Closing clears palette state, but the rest of this press still belongs
      // to the palette. A fresh keydown or losing focus clears this guard.
      if (!palette) suppressedKeyups.add(event.code);
      return;
    }

    if (event.repeat && suppressedKeyups.has(event.code)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      return;
    }

    if (opening || !isPaletteShortcut(event, false)) return;

    event.preventDefault();
    event.stopImmediatePropagation();
    suppressedKeyups.add(event.code);
    openPalette();
  }

  function isPaletteShortcut(event, allowBareInEditable) {
    if (event.repeat) return false;

    const binding = [
      settings.keyBindings.togglePrimary,
      settings.keyBindings.toggleAlternate
    ].find((candidate) => matchesKeyBinding(event, candidate));
    if (!binding) return false;

    return allowBareInEditable || keyBindingHasModifier(binding) ||
      !isEditable(event.composedPath()[0]);
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

      if (!palette.message.hidden) {
        clearListMessage();
      } else if (palette.mode === "add") {
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
      event.key === "Tab" &&
      !event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      clearListMessage();
      showAllCommands = !showAllCommands;
      chrome.storage.local.set({
        [COMMAND_SCOPE_STORAGE_KEY]: showAllCommands ? "all" : "site"
      }).catch((error) => {
        handleExtensionError(error, "Site Command Palette scope failed to save:");
      });
      refreshCommands();
      updateSearchPlaceholder();
      filterAndRender();
      palette.search.focus();
      return;
    }

    if (matchesKeyBinding(event, settings.keyBindings.add)) {
      event.preventDefault();
      showAddForm();
      return;
    }

    if (
      matchesKeyBinding(event, settings.keyBindings.edit) &&
      filteredItems[selectedIndex]?.type === "link"
    ) {
      event.preventDefault();
      showEditForm(filteredItems[selectedIndex]);
      return;
    }

    if (
      matchesKeyBinding(event, settings.keyBindings.remove) &&
      filteredItems[selectedIndex]?.type === "link"
    ) {
      event.preventDefault();
      removeCommand(filteredItems[selectedIndex].id);
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
    } else if (event.key === "Enter" && filteredItems.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      activateItem(filteredItems[selectedIndex], event.ctrlKey)
        .catch(error => handleExtensionError(error, "Site Command Palette action failed:"));
    }
  }

  function suppressPageKeyEvent(event) {
    if (!ensureExtensionContext()) return;
    const shouldSuppress = palette || opening || suppressedKeyups.has(event.code);
    if (!shouldSuppress) return;

    event.stopImmediatePropagation();
    if (event.type === "keyup") suppressedKeyups.delete(event.code);
  }

  function clearSuppressedKeys() {
    suppressedKeyups.clear();
  }

  async function openPalette() {
    if (!enabled || !ensureExtensionContext()) return;
    try {
      await createPalette();
    } catch (error) {
      closePalette();
      handleExtensionError(error, "Site Command Palette failed to open:");
    } finally {
      opening = false;
    }
  }

  async function createPalette() {
    opening = true;
    const previouslyFocusedElement = document.activeElement;
    const existingHost = document.getElementById(HOST_ID);
    if (existingHost) existingHost.remove();

    const host = document.createElement("div");
    host.id = HOST_ID;
    host.style.setProperty("--edit-icon", `url("${chrome.runtime.getURL("icons/edit.svg")}")`);
    host.style.setProperty("--delete-icon", `url("${chrome.runtime.getURL("icons/delete.svg")}")`);
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    const overlay = document.createElement("div");

    try {
      style.textContent = await stylesheet;
    } catch (error) {
      opening = false;
      handleExtensionError(error, "Site Command Palette:");
      return;
    }
    if (!enabled || !ensureExtensionContext()) return;
    overlay.className = "overlay";
    overlay.dir = "ltr";
    overlay.innerHTML = `
      <section class="palette" role="dialog" aria-modal="true" aria-label="Site command palette">
        <div class="list-view">
          <header>
            <input class="search" type="search" autocomplete="off" spellcheck="false"
              aria-label="Search commands" placeholder="Search commands">
          </header>
          <div class="command-area">
            <div class="commands" role="listbox" aria-label="Commands"></div>
            <p class="message" role="alert" hidden></p>
          </div>
          <footer></footer>
        </div>
        <form class="add-view" hidden>
          <h1 class="form-title">Add command</h1>
          <div class="command-fields">
            <label>
              <span class="field-heading">
                <span>Site</span>
                <small class="site-usage" id="site-usage"></small>
              </span>
              <input class="site-name" name="site-name" required autocomplete="off"
                aria-label="Site" aria-describedby="site-usage">
            </label>
            <label>
              <span class="field-heading">Page</span>
              <input class="page-name" name="page-name" required autocomplete="off" aria-label="Page">
            </label>
          </div>
          <label>
            URL
            <input class="url" name="url" required type="url" autocomplete="off">
          </label>
          <div class="scope-field">
            <div class="scope-heading">
              <label for="scope-pattern">Scope</label>
              <div class="scope-actions" role="group" aria-label="Scope shortcuts">
                <button type="button" data-scope-preset="site" aria-pressed="false">This site</button>
                <button type="button" data-scope-preset="global" aria-pressed="false">Global</button>
                <button type="button" data-scope-preset="custom" aria-pressed="false">Custom</button>
              </div>
            </div>
            <input class="scope-pattern" id="scope-pattern" name="scope-pattern"
              required autocomplete="off" placeholder="*.github.com or github.com/org/*">
          </div>
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
      previouslyFocusedElement,
      mode: "list",
      listView: overlay.querySelector(".list-view"),
      addView: overlay.querySelector(".add-view"),
      search: overlay.querySelector(".search"),
      commandList: overlay.querySelector(".commands"),
      message: overlay.querySelector(".message"),
      footer: overlay.querySelector("footer"),
      siteName: overlay.querySelector(".site-name"),
      pageName: overlay.querySelector(".page-name"),
      siteUsage: overlay.querySelector(".site-usage"),
      url: overlay.querySelector(".url"),
      scopePattern: overlay.querySelector(".scope-pattern"),
      scopePresets: overlay.querySelectorAll("[data-scope-preset]"),
      error: overlay.querySelector(".error"),
      formTitle: overlay.querySelector(".form-title"),
      saveButton: overlay.querySelector(".save-button")
    };

    overlay.addEventListener("click", handleOverlayClick);
    palette.search.addEventListener("input", () => {
      clearListMessage();
      filterAndRender();
    });
    palette.message.addEventListener("click", clearListMessage);
    palette.siteName.addEventListener("input", () => { siteNameEdited = true; });
    palette.url.addEventListener("input", updateFormSiteFromUrl);
    palette.scopePattern.addEventListener("input", updateScopePresetState);
    overlay.querySelector(".scope-actions").addEventListener("click", applyScopePreset);
    overlay.querySelector(".cancel-button").addEventListener("click", showCommandList);
    palette.addView.addEventListener("submit", saveCommand);

    updateSearchPlaceholder();
    const stored = await loadStorage();
    if (!enabled || !ensureExtensionContext()) return;
    commandsByScope = stored[COMMANDS_STORAGE_KEY];
    sitesByHostname = stored[SITES_STORAGE_KEY];
    refreshCommands();
    settings = stored[SETTINGS_STORAGE_KEY];

    if (!palette) return;
    updateSearchPlaceholder();
    applyTheme();
    filterAndRender();
    palette.search.focus();
  }

  function closePalette() {
    if (!palette) return;
    const { host, previouslyFocusedElement } = palette;
    host.remove();
    palette = null;
    clearSuppressedKeys();
    filteredItems = [];
    selectedIndex = 0;
    editingCommandId = null;
    editingCommandScope = null;
    formSiteHostname = null;
    siteNameEdited = false;
    if (
      previouslyFocusedElement?.isConnected &&
      typeof previouslyFocusedElement.focus === "function"
    ) {
      previouslyFocusedElement.focus({ preventScroll: true });
    }
  }

  function handlePageNavigation() {
    closePalette();
  }

  function handleOverlayClick(event) {
    if (!ensureExtensionContext()) return;
    if (event.target === palette.overlay) {
      closePalette();
      return;
    }

    const openButton = event.target.closest("[data-activate-item]");
    if (openButton) {
      activateItem(filteredItems[Number(openButton.dataset.activateItem)])
        .catch(error => handleExtensionError(error, "Site Command Palette action failed:"));
      return;
    }

    const editButton = event.target.closest("[data-edit-command]");
    if (editButton) {
      const command = commands.find((candidate) => candidate.id === editButton.dataset.editCommand);
      if (command) showEditForm(command);
      return;
    }

    const removeButton = event.target.closest("[data-remove-command]");
    if (removeButton) removeCommand(removeButton.dataset.removeCommand);
  }

  function showAddForm() {
    clearListMessage();
    editingCommandId = null;
    editingCommandScope = null;
    palette.mode = "add";
    palette.listView.hidden = true;
    palette.addView.hidden = false;
    palette.formTitle.textContent = "Add command";
    palette.saveButton.textContent = "Save command";
    palette.url.value = location.href;
    formSiteHostname = siteIdentity(location.href);
    palette.siteName.value = siteNameForUrl(sitesByHostname, location.href, document.title);
    palette.pageName.value = suggestPageName(location.href);
    palette.scopePattern.value = location.hostname;
    siteNameEdited = false;
    updateSiteUsage();
    updateScopePresetState();
    setError("");
    palette.pageName.select();
  }

  function showEditForm(command) {
    clearListMessage();
    editingCommandId = command.id;
    editingCommandScope = command.scope;
    palette.mode = "add";
    palette.listView.hidden = true;
    palette.addView.hidden = false;
    palette.formTitle.textContent = "Edit command";
    palette.saveButton.textContent = "Update command";
    palette.url.value = command.url;
    formSiteHostname = siteIdentity(command.url);
    palette.siteName.value = siteNameForUrl(sitesByHostname, command.url);
    palette.pageName.value = command.page;
    palette.scopePattern.value = command.scope;
    siteNameEdited = false;
    updateSiteUsage();
    updateScopePresetState();
    setError("");
    palette.pageName.select();
  }

  function showCommandList() {
    editingCommandId = null;
    editingCommandScope = null;
    palette.mode = "list";
    palette.addView.hidden = true;
    palette.listView.hidden = false;
    updateSearchPlaceholder();
    palette.search.focus();
  }

  function updateSearchPlaceholder() {
    if (!palette) return;

    if (showAllCommands) {
      palette.search.placeholder = "Search all commands";
      return;
    }

    const siteName = siteNameForUrl(sitesByHostname, location, document.title);
    palette.search.placeholder = `Search ${siteName} commands`;
  }

  function applyScopePreset(event) {
    const preset = event.target.closest("[data-scope-preset]")?.dataset.scopePreset;
    if (!preset) return;

    palette.scopePattern.value = {
      site: location.hostname,
      global: "*",
      custom: `*.${location.hostname}`
    }[preset];
    updateScopePresetState();
    palette.scopePattern.focus();
    palette.scopePattern.select();
  }

  function updateScopePresetState() {
    const scope = normalizeScope(palette.scopePattern.value);
    let selectedPreset = null;
    if (scope === location.hostname) selectedPreset = "site";
    else if (scope === "*") selectedPreset = "global";
    else if (scope) selectedPreset = "custom";

    for (const button of palette.scopePresets) {
      button.setAttribute("aria-pressed", String(button.dataset.scopePreset === selectedPreset));
    }
  }

  function selectedScope() {
    return normalizeScope(palette.scopePattern.value);
  }

  function updateFormSiteFromUrl() {
    const hostname = siteIdentity(palette.url.value);
    if (!hostname || hostname === formSiteHostname) return;

    formSiteHostname = hostname;
    if (!siteNameEdited) {
      palette.siteName.value = siteNameForUrl(sitesByHostname, palette.url.value);
    }
    updateSiteUsage();
  }

  function updateSiteUsage() {
    const count = Object.values(commandsByScope)
      .flat()
      .filter((command) => siteIdentity(command.url) === formSiteHostname)
      .length;
    palette.siteUsage.textContent = count > 0
      ? `Shared by ${count} ${count === 1 ? "command" : "commands"}`
      : "New site";
  }

  async function saveCommand(event) {
    event.preventDefault();
    if (!ensureExtensionContext()) return;

    const editedCommandId = editingCommandId;
    const siteName = palette.siteName.value.trim();
    const page = palette.pageName.value.trim();
    const url = normalizeUrl(palette.url.value);
    const scope = selectedScope();

    if (!siteName) {
      setError("Enter a site name.");
      palette.siteName.focus();
      return;
    }

    if (!page) {
      setError("Enter a page name.");
      palette.pageName.focus();
      return;
    }

    if (!url) {
      setError("Enter a valid HTTP or HTTPS URL.");
      palette.url.focus();
      return;
    }

    if (!scope) {
      setError("Enter a valid scope pattern.");
      palette.scopePattern.focus();
      return;
    }

    const conflict = findCommandNameConflict(
      commandsByScope,
      scope,
      page,
      url,
      editingCommandId
    );
    if (conflict) {
      setError(conflict.url === url
        ? "This command already exists in this scope."
        : `A “${page}” command for this site already exists in this scope. Edit it instead.`);
      palette.pageName.focus();
      palette.pageName.select();
      return;
    }

    const previousCommandsByScope = commandsByScope;
    const previousSitesByHostname = sitesByHostname;
    commandsByScope = { ...commandsByScope };
    sitesByHostname = { ...sitesByHostname };

    try {
      const hostname = siteIdentity(url);
      sitesByHostname[hostname] = { name: siteName };

      if (editingCommandId) {
        const previousCommands = commandsByScope[editingCommandScope] ?? [];
        commandsByScope[editingCommandScope] = previousCommands.filter(
          (command) => command.id !== editingCommandId
        );
        if (commandsByScope[editingCommandScope].length === 0) {
          delete commandsByScope[editingCommandScope];
        }
        commandsByScope[scope] = [
          ...(commandsByScope[scope] ?? []),
          { id: editingCommandId, page, url }
        ];
      } else {
        commandsByScope[scope] = [
          ...(commandsByScope[scope] ?? []),
          { id: crypto.randomUUID(), page, url }
        ];
      }
      pruneUnusedSites();
      await storeCommandData();
    } catch (error) {
      commandsByScope = previousCommandsByScope;
      sitesByHostname = previousSitesByHostname;
      if (palette) setError("Could not save the command. Try again.");
      handleExtensionError(error, "Site Command Palette command failed to save:");
      return;
    }

    refreshCommands();
    if (!palette) return;
    palette.search.value = "";
    showCommandList();
    filterAndRender(editedCommandId);
  }

  async function removeCommand(id) {
    if (!ensureExtensionContext()) return;
    const command = commands.find((candidate) => candidate.id === id);
    if (!command) return;

    const removedIndex = filteredItems.findIndex((item) => item.id === id);
    const neighborId = removedIndex >= 0
      ? filteredItems[removedIndex + 1]?.id ?? filteredItems[removedIndex - 1]?.id ?? null
      : null;

    const previousCommandsByScope = commandsByScope;
    const previousSitesByHostname = sitesByHostname;
    commandsByScope = {
      ...commandsByScope,
      [command.scope]: (commandsByScope[command.scope] ?? [])
        .filter((candidate) => candidate.id !== id)
    };
    sitesByHostname = { ...sitesByHostname };
    if (commandsByScope[command.scope].length === 0) delete commandsByScope[command.scope];

    try {
      pruneUnusedSites();
      await storeCommandData();
    } catch (error) {
      commandsByScope = previousCommandsByScope;
      sitesByHostname = previousSitesByHostname;
      if (palette) showListMessage("Could not delete the command. Try again.");
      handleExtensionError(error, "Site Command Palette command failed to delete:");
      return;
    }

    clearListMessage();
    refreshCommands();
    filterAndRender(neighborId);
  }

  function filterAndRender(preferredItemId = null) {
    if (!palette) return;

    const query = palette.search.value.trim();
    const actionMode = query.startsWith("/");
    const items = actionMode
      ? getActions()
      : commands.map((command) => ({
        ...command,
        type: "link",
        external: isCommandExternal(command, location),
        name: `${siteNameForUrl(sitesByHostname, command.url)} › ${command.page}`
          .replace(/\s+>\s+/g, " › ")
      }));

    filteredItems = items
      .map((item) => {
        const match = fuzzyMatch(query, item.name);
        return match ? { ...item, match } : null;
      })
      .filter(Boolean)
      .sort((left, right) => actionMode
        ? left.order - right.order
        : right.match.score - left.match.score || left.name.localeCompare(right.name));

    if (!actionMode) {
      filteredItems = [
        ...filteredItems.filter((item) => !item.external),
        ...filteredItems.filter((item) => item.external)
      ];
    }

    const preferredIndex = filteredItems.findIndex((item) => item.id === preferredItemId);
    const currentPageIndex = !actionMode && !query
      ? filteredItems.findIndex((item) => urlMatchesPage(item.url, location))
      : -1;
    selectedIndex = preferredIndex >= 0
      ? preferredIndex
      : Math.max(currentPageIndex, 0);
    renderItems(actionMode);
  }

  function renderItems(actionMode) {
    palette.commandList.replaceChildren();

    if (filteredItems.length === 0) {
      const empty = document.createElement("p");
      empty.className = "empty";

      if (actionMode) {
        empty.textContent = "No matching actions.";
      } else if (commands.length === 0) {
        empty.textContent = `No commands saved for ${location.hostname}.`;
      } else {
        empty.textContent = "No matching commands.";
      }

      palette.commandList.append(empty);
      renderFooter();
      return;
    }

    const firstExternalIndex = actionMode
      ? -1
      : filteredItems.findIndex((item) => item.external);
    const showExternalDivider = firstExternalIndex > 0;

    filteredItems.forEach((item, index) => {
      if (showExternalDivider && index === firstExternalIndex) {
        const divider = document.createElement("div");
        divider.className = "command-divider";
        divider.setAttribute("role", "separator");
        divider.setAttribute("aria-label", "External commands");
        divider.textContent = "External";
        palette.commandList.append(divider);
      }

      const row = document.createElement("div");
      const openButton = document.createElement("button");
      const label = document.createElement("span");

      row.className = "command";
      row.dataset.itemIndex = String(index);
      row.setAttribute("role", "option");
      row.setAttribute("aria-selected", String(index === selectedIndex));

      openButton.type = "button";
      openButton.className = "open-command";
      openButton.dataset.activateItem = String(index);
      label.className = "command-name";
      appendHighlightedText(label, item.name, item.match.indices);
      openButton.append(label);

      if (item.type !== "link") {
        const detail = document.createElement("span");
        detail.className = "command-detail";
        detail.textContent = item.detail;
        detail.title = item.detail;
        openButton.classList.add("detailed");
        openButton.append(detail);
      }

      row.append(openButton);

      if (item.type === "link") {
        const actions = document.createElement("div");
        const editButton = document.createElement("button");
        const removeButton = document.createElement("button");

        actions.className = "command-actions";
        editButton.type = "button";
        editButton.className = "icon-button command-action edit-command";
        editButton.dataset.editCommand = item.id;
        editButton.setAttribute("aria-label", `Edit ${item.name}`);
        editButton.append(createIcon("edit"));

        removeButton.type = "button";
        removeButton.className = "icon-button command-action remove-command";
        removeButton.dataset.removeCommand = item.id;
        removeButton.setAttribute("aria-label", `Remove ${item.name}`);
        removeButton.append(createIcon("delete"));

        actions.append(editButton, removeButton);
        row.append(actions);
      }

      palette.commandList.append(row);
    });

    renderFooter();
  }

  function renderFooter() {
    const selectedItem = filteredItems[selectedIndex];
    const hints = [];

    hints.push(footerHint("Tab", "Scope"));

    if (selectedItem?.type === "link") {
      hints.push(footerHint("Ctrl+Enter", "New tab"));
    }

    hints.push(shortcutHint(settings.keyBindings.add, "add"));

    if (selectedItem?.type === "link") {
      hints.push(shortcutHint(settings.keyBindings.edit, "edit"));
      hints.push(shortcutHint(settings.keyBindings.remove, "delete"));
    }

    hints.push(footerHint("/", "Actions"));
    palette.footer.innerHTML = `<span class="footer-hints">${hints.join(" ")}</span>`;
  }

  function moveSelection(offset) {
    if (filteredItems.length === 0) return;

    selectedIndex = (selectedIndex + offset + filteredItems.length) % filteredItems.length;
    renderItems(palette.search.value.trim().startsWith("/"));
    palette.commandList.querySelector(`[data-item-index="${selectedIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }

  async function activateItem(item, openInNewTab = false) {
    if (!item) return;

    if (item.type === "link") {
      if (openInNewTab) {
        await chrome.runtime.sendMessage({ type: "open-tab", url: item.url });
        closePalette();
        return;
      }

      if (urlMatchesPage(item.url, location)) {
        closePalette();
        return;
      }

      location.href = item.url;
      return;
    }

    await item.run();
    if (!palette) return;

    switch (item.afterRun ?? "refresh") {
      case "close":
        closePalette();
        break;
      case "preserve":
        break;
      default:
        filterAndRender(item.id);
        palette.search.focus();
    }
  }

  function getActions() {
    const siteTheme = settings.siteThemes[location.hostname] ?? null;

    return [
      {
        type: "action",
        id: "add-current-page",
        order: 0,
        name: "/add › Current page",
        detail: location.hostname,
        afterRun: "preserve",
        run: showAddForm
      },
      {
        type: "action",
        id: "open-settings",
        order: 1,
        name: "/settings › Open extension settings",
        detail: "Global and per-site preferences",
        afterRun: "close",
        run: () => chrome.runtime.sendMessage({ type: "open-options" })
      },
      {
        type: "action",
        id: "theme-global",
        order: 10,
        name: "/theme › Use global setting",
        detail: siteTheme === null
          ? `Current · ${capitalize(settings.theme)}`
          : `Global: ${capitalize(settings.theme)}`,
        afterRun: "refresh",
        run: () => setSiteTheme(null)
      },
      {
        type: "action",
        id: "theme-dark",
        order: 11,
        name: `/theme › Use dark for ${location.hostname}`,
        detail: siteTheme === "dark" ? "Current" : "",
        afterRun: "refresh",
        run: () => setSiteTheme("dark")
      },
      {
        type: "action",
        id: "theme-light",
        order: 12,
        name: `/theme › Use light for ${location.hostname}`,
        detail: siteTheme === "light" ? "Current" : "",
        afterRun: "refresh",
        run: () => setSiteTheme("light")
      }
    ];
  }

  async function setSiteTheme(theme) {
    if (theme) {
      settings.siteThemes[location.hostname] = theme;
    } else {
      delete settings.siteThemes[location.hostname];
    }

    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
    applyTheme();
  }

  function applyTheme() {
    if (!palette) return;
    palette.host.dataset.theme = resolveTheme(
      settings,
      location.hostname,
      systemTheme.matches
    );
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "local") return;

    if (changes[COMMAND_SCOPE_STORAGE_KEY]) {
      const nextShowAllCommands = changes[COMMAND_SCOPE_STORAGE_KEY].newValue === "all";
      if (nextShowAllCommands !== showAllCommands) {
        showAllCommands = nextShowAllCommands;
        refreshCommands();
        updateSearchPlaceholder();
        if (palette?.mode === "list") filterAndRender();
      }
    }

    if (changes[COMMANDS_STORAGE_KEY]) {
      commandsByScope = normalizeCommandsByScope(changes[COMMANDS_STORAGE_KEY].newValue);
      refreshCommands();
      if (palette?.mode === "list") filterAndRender();
    }

    if (changes[SITES_STORAGE_KEY]) {
      sitesByHostname = normalizeSites(changes[SITES_STORAGE_KEY].newValue);
      updateSearchPlaceholder();
      if (palette?.mode === "list") filterAndRender();
    }

    if (!changes[SETTINGS_STORAGE_KEY]) return;

    settings = normalizeSettings(changes[SETTINGS_STORAGE_KEY].newValue);
    if (isSiteDisabled(settings, location)) {
      disableCurrentSite();
      return;
    }
    applyTheme();
    if (palette?.mode === "list" && palette.search.value.trim().startsWith("/")) {
      filterAndRender();
    }
  }

  function capitalize(value) {
    return value.charAt(0).toLocaleUpperCase() + value.slice(1);
  }

  function refreshCommands() {
    commands = showAllCommands
      ? resolveAllCommands(commandsByScope)
      : resolveCommandsForLocation(commandsByScope, location);
  }

  function pruneUnusedSites() {
    const usedHostnames = new Set(Object.values(commandsByScope)
      .flat()
      .map((command) => siteIdentity(command.url))
      .filter(Boolean));

    for (const hostname of Object.keys(sitesByHostname)) {
      if (!usedHostnames.has(hostname)) delete sitesByHostname[hostname];
    }
  }

  async function storeCommandData() {
    await chrome.storage.local.set({
      [COMMANDS_STORAGE_KEY]: commandsByScope,
      [SITES_STORAGE_KEY]: sitesByHostname
    });
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

  function createIcon(name) {
    const icon = document.createElement("span");
    icon.className = `icon ${name}`;
    icon.setAttribute("aria-hidden", "true");
    return icon;
  }

  function setError(message) {
    palette.error.textContent = message;
    palette.error.hidden = !message;
  }

  function showListMessage(message) {
    palette.message.textContent = message;
    palette.message.hidden = false;
  }

  function clearListMessage() {
    if (!palette) return;
    palette.message.textContent = "";
    palette.message.hidden = true;
  }

  function escapeHtml(value) {
    return value
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function shortcutHint(binding, label) {
    const shortcut = formatKeyBinding(binding).replaceAll(" + ", "+");
    return footerHint(shortcut, capitalize(label));
  }

  function footerHint(shortcut, label) {
    return `<span class="footer-hint"><kbd>${escapeHtml(shortcut)}</kbd> ${label}</span>`;
  }
})();

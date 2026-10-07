(() => {
  const {
    DEFAULT_KEY_BINDINGS,
    HISTORY_ENABLED_STORAGE_KEY,
    formatBackupDate,
    formatKeyBinding,
    keyBindingFromEvent,
    keyBindingHasModifier,
    migrateStorage,
    normalizeHostname,
    normalizeSettings,
    resolveTheme
  } = globalThis.SiteCommandPaletteCore;
  const {
    COMMANDS_STORAGE_KEY,
    SETTINGS_STORAGE_KEY,
    loadStorage
  } = globalThis.SiteCommandPaletteStorage;
  const {
    BACKUP_STATUS_KEY,
    backupDownloadName,
    clearBackupDirectory,
    createBackupDocument,
    getBackupState,
    inspectBackupDirectory,
    parseBackupDocument,
    preserveSnapshot,
    queryBackupPermission,
    readBackupFile,
    requestBackupPermission,
    setBackupDirectory,
    setHistoryLimit,
    storageDataEqual,
    writeBackup
  } = globalThis.SiteCommandPaletteBackup;
  const systemTheme = matchMedia("(prefers-color-scheme: dark)");

  const globalTheme = document.getElementById("global-theme");
  const includeHistory = document.getElementById("include-history");
  const historyMessage = document.getElementById("history-message");
  const extensionVersion = document.getElementById("extension-version");
  const overrideList = document.getElementById("override-list");
  const emptyOverrides = document.getElementById("empty-overrides");
  const overrideCount = document.getElementById("override-count");
  const disabledSiteForm = document.getElementById("disabled-site-form");
  const disabledSiteInput = document.getElementById("disabled-site-input");
  const disabledSiteList = document.getElementById("disabled-site-list");
  const emptyDisabledSites = document.getElementById("empty-disabled-sites");
  const disabledSiteCount = document.getElementById("disabled-site-count");
  const saveStatus = document.getElementById("save-status");
  const keyBindingList = document.getElementById("key-binding-list");
  const keyBindingMessage = document.getElementById("key-binding-message");
  const resetKeyBindings = document.getElementById("reset-key-bindings");
  const downloadBackup = document.getElementById("download-backup");
  const restoreBackupFile = document.getElementById("restore-backup-file");
  const backupFile = document.getElementById("backup-file");
  const manualBackupMessage = document.getElementById("manual-backup-message");
  const backupState = document.getElementById("backup-state");
  const backupFolder = document.getElementById("backup-folder");
  const lastBackup = document.getElementById("last-backup");
  const chooseBackupFolder = document.getElementById("choose-backup-folder");
  const backupNow = document.getElementById("backup-now");
  const restoreBackup = document.getElementById("restore-backup");
  const disableBackup = document.getElementById("disable-backup");
  const backupMessage = document.getElementById("backup-message");
  const backupHistoryLimit = document.getElementById("backup-history-limit");
  const existingBackupDialog = document.getElementById("existing-backup-dialog");
  const existingBackupDate = document.getElementById("existing-backup-date");
  let settings = normalizeSettings();
  let statusTimer = null;
  let pendingDirectory = null;
  let currentBackupState = null;
  let capturingBinding = null;

  extensionVersion.textContent = `· Version ${chrome.runtime.getManifest().version}`;

  globalTheme.addEventListener("change", saveGlobalTheme);
  includeHistory.addEventListener("change", changeHistoryAccess);
  chrome.permissions.onAdded.addListener(renderHistoryAccess);
  chrome.permissions.onRemoved.addListener(renderHistoryAccess);
  overrideList.addEventListener("change", updateSiteTheme);
  overrideList.addEventListener("click", removeSiteTheme);
  disabledSiteForm.addEventListener("submit", addDisabledSite);
  disabledSiteInput.addEventListener("input", () => disabledSiteInput.setCustomValidity(""));
  disabledSiteList.addEventListener("click", removeDisabledSite);
  systemTheme.addEventListener("change", applyTheme);
  chrome.storage.onChanged.addListener(handleStorageChange);
  keyBindingList.addEventListener("click", beginKeyBindingCapture);
  resetKeyBindings.addEventListener("click", restoreDefaultKeyBindings);
  document.addEventListener("keydown", captureKeyBinding, true);
  downloadBackup.addEventListener("click", downloadManualBackup);
  restoreBackupFile.addEventListener("click", chooseManualBackupFile);
  backupFile.addEventListener("change", restoreManualBackup);
  chooseBackupFolder.addEventListener("click", chooseFolder);
  backupNow.addEventListener("click", runManualBackup);
  restoreBackup.addEventListener("click", restoreFromBackup);
  disableBackup.addEventListener("click", disableAutomaticBackup);
  backupHistoryLimit.addEventListener("change", changeHistoryLimit);
  existingBackupDialog.addEventListener("close", resolveExistingBackup);

  loadSettings();
  renderHistoryAccess();
  renderBackupState();
  window.addEventListener("focus", checkBackupAccess);
  checkBackupAccess();

  function checkBackupAccess() {
    chrome.runtime.sendMessage({ type: "check-backup-access" });
    renderBackupState();
  }

  async function renderHistoryAccess() {
    includeHistory.checked = await chrome.permissions.contains({ permissions: ["history"] });
  }

  async function changeHistoryAccess() {
    const requested = includeHistory.checked;
    includeHistory.disabled = true;
    historyMessage.textContent = "";
    try {
      // Request directly from the checkbox gesture, before any other await.
      if (requested) await chrome.permissions.request({ permissions: ["history"] });
      else await chrome.permissions.remove({ permissions: ["history"] });
      await renderHistoryAccess();
      await chrome.storage.local.set({ [HISTORY_ENABLED_STORAGE_KEY]: includeHistory.checked });
      const changed = requested === includeHistory.checked;
      historyMessage.textContent = requested && !includeHistory.checked
        ? "History access was not granted."
        : !requested && includeHistory.checked ? "History access could not be removed."
        : includeHistory.checked ? "Browsing history enabled." : "Browsing history disabled.";
      historyMessage.dataset.status = changed ? "success" : "error";
    } catch (error) {
      historyMessage.textContent = error.message;
      historyMessage.dataset.status = "error";
      await renderHistoryAccess();
    } finally {
      includeHistory.disabled = false;
    }
  }

  async function loadSettings() {
    const stored = await loadStorage();
    settings = stored[SETTINGS_STORAGE_KEY];
    render();
  }

  function render() {
    globalTheme.value = settings.theme;
    applyTheme();
    renderSiteThemes();
    renderDisabledSites();
    renderKeyBindings();
  }

  function applyTheme() {
    document.documentElement.dataset.theme = resolveTheme(settings, "", systemTheme.matches);
  }

  function renderSiteThemes() {
    const siteThemes = Object.entries(settings.siteThemes)
      .sort(([left], [right]) => left.localeCompare(right));

    overrideList.replaceChildren(...siteThemes.map(createSiteThemeRow));
    overrideList.hidden = siteThemes.length === 0;
    emptyOverrides.hidden = siteThemes.length > 0;
    overrideCount.textContent = `${siteThemes.length} ${siteThemes.length === 1 ? "site" : "sites"}`;
  }

  function createSiteThemeRow([hostname, theme]) {
    const row = document.createElement("div");
    const name = document.createElement("strong");
    const select = document.createElement("select");
    const remove = document.createElement("button");

    row.className = "override settings-row";
    name.textContent = hostname;

    select.dataset.hostname = hostname;
    select.setAttribute("aria-label", `Theme for ${hostname}`);
    select.append(
      new Option("Light", "light"),
      new Option("Dark", "dark")
    );
    select.value = theme;

    remove.type = "button";
    remove.dataset.removeHostname = hostname;
    remove.setAttribute("aria-label", `Remove theme override for ${hostname}`);
    remove.textContent = "Remove override";

    row.append(name, select, remove);
    return row;
  }

  function renderDisabledSites() {
    const hostnames = [...settings.disabledHostnames].sort((left, right) => (
      left.localeCompare(right)
    ));

    disabledSiteList.replaceChildren(...hostnames.map(createDisabledSiteRow));
    disabledSiteList.hidden = hostnames.length === 0;
    emptyDisabledSites.hidden = hostnames.length > 0;
    disabledSiteCount.textContent = `${hostnames.length} ${hostnames.length === 1 ? "site" : "sites"}`;
  }

  function createDisabledSiteRow(hostname) {
    const row = document.createElement("div");
    const name = document.createElement("strong");
    const remove = document.createElement("button");

    row.className = "settings-row";
    name.textContent = hostname;
    remove.type = "button";
    remove.dataset.removeDisabledHostname = hostname;
    remove.setAttribute("aria-label", `Remove ${hostname} from disabled sites`);
    remove.textContent = "Remove";
    row.append(name, remove);
    return row;
  }

  function renderKeyBindings() {
    for (const button of keyBindingList.querySelectorAll("[data-key-binding]")) {
      const name = button.dataset.keyBinding;
      button.textContent = capturingBinding === name
        ? "Press shortcut…"
        : formatKeyBinding(settings.keyBindings[name]);
      button.toggleAttribute("data-capturing", capturingBinding === name);
      button.setAttribute("aria-pressed", String(capturingBinding === name));
    }
  }

  function beginKeyBindingCapture(event) {
    const button = event.target.closest("[data-key-binding]");
    if (!button) return;

    capturingBinding = button.dataset.keyBinding;
    showKeyBindingMessage(
      capturingBinding === "toggleAlternate"
        ? "Press a shortcut, Backspace to clear, or Escape to cancel."
        : "Press a shortcut or Escape to cancel."
    );
    renderKeyBindings();
  }

  async function captureKeyBinding(event) {
    if (!capturingBinding) return;

    event.preventDefault();
    event.stopImmediatePropagation();

    if (event.code === "Escape") {
      cancelKeyBindingCapture();
      return;
    }

    const binding = keyBindingFromEvent(event);
    if (!binding) return;

    if (capturingBinding === "toggleAlternate" &&
        !keyBindingHasModifier(binding) && ["Backspace", "Delete"].includes(event.code)) {
      settings.keyBindings.toggleAlternate = null;
      capturingBinding = null;
      await storeSettings("Alternate shortcut cleared");
      showKeyBindingMessage("Alternate shortcut cleared.");
      return;
    }

    if (["Escape", "Tab", "Enter", "NumpadEnter", "ArrowUp", "ArrowDown"].includes(event.code)) {
      showKeyBindingMessage("That key is reserved for palette navigation.", true);
      return;
    }
    if (["add", "edit", "remove"].includes(capturingBinding) &&
        !keyBindingHasModifier(binding)) {
      showKeyBindingMessage("Palette actions must include Ctrl, Alt, Shift, or Meta.", true);
      return;
    }

    const conflict = Object.entries(settings.keyBindings).find(([name, value]) => (
      name !== capturingBinding && value === binding
    ));
    if (conflict) {
      showKeyBindingMessage(
        `${formatKeyBinding(binding)} is already used by ${keyBindingLabel(conflict[0])}.`,
        true
      );
      return;
    }

    const bindingName = capturingBinding;
    settings.keyBindings[bindingName] = binding;
    capturingBinding = null;
    await storeSettings("Key binding saved");
    showKeyBindingMessage(`${keyBindingLabel(bindingName)} set to ${formatKeyBinding(binding)}.`);
  }

  function cancelKeyBindingCapture() {
    capturingBinding = null;
    showKeyBindingMessage("");
    renderKeyBindings();
  }

  async function restoreDefaultKeyBindings() {
    capturingBinding = null;
    settings.keyBindings = { ...DEFAULT_KEY_BINDINGS };
    await storeSettings("Default key bindings restored");
    showKeyBindingMessage("Default key bindings restored.");
  }

  function keyBindingLabel(name) {
    return {
      togglePrimary: "the primary palette shortcut",
      toggleAlternate: "the alternate palette shortcut",
      add: "Add current page",
      edit: "Edit selected command",
      remove: "Delete selected command"
    }[name];
  }

  function showKeyBindingMessage(message, isError = false) {
    keyBindingMessage.textContent = message;
    keyBindingMessage.dataset.status = isError ? "error" : "success";
  }

  async function saveGlobalTheme() {
    settings.theme = globalTheme.value;
    await storeSettings("Global theme saved");
  }

  async function updateSiteTheme(event) {
    const select = event.target.closest("select[data-hostname]");
    if (!select) return;

    settings.siteThemes[select.dataset.hostname] = select.value;
    await storeSettings("Site theme saved");
  }

  async function removeSiteTheme(event) {
    const button = event.target.closest("button[data-remove-hostname]");
    if (!button) return;

    delete settings.siteThemes[button.dataset.removeHostname];
    await storeSettings("Site override removed");
  }

  async function addDisabledSite(event) {
    event.preventDefault();

    const hostname = normalizeHostname(disabledSiteInput.value);
    if (!hostname) {
      disabledSiteInput.setCustomValidity("Enter a valid HTTP or HTTPS hostname or URL.");
      disabledSiteInput.reportValidity();
      return;
    }
    if (settings.disabledHostnames.includes(hostname)) {
      disabledSiteInput.setCustomValidity(`${hostname} is already disabled.`);
      disabledSiteInput.reportValidity();
      return;
    }

    disabledSiteInput.setCustomValidity("");
    settings.disabledHostnames.push(hostname);
    await storeSettings("Disabled site added");
    disabledSiteInput.value = "";
    disabledSiteInput.focus();
  }

  async function removeDisabledSite(event) {
    const button = event.target.closest("button[data-remove-disabled-hostname]");
    if (!button) return;

    settings.disabledHostnames = settings.disabledHostnames.filter(
      (hostname) => hostname !== button.dataset.removeDisabledHostname
    );
    await storeSettings("Disabled site removed");
  }

  async function storeSettings(message) {
    settings = normalizeSettings(settings);
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
    render();
    showStatus(message);
  }

  async function downloadManualBackup() {
    clearManualBackupMessage();

    try {
      const backup = createBackupDocument(await loadStorage());
      const url = URL.createObjectURL(new Blob(
        [`${JSON.stringify(backup, null, 2)}\n`],
        { type: "application/json" }
      ));
      const link = document.createElement("a");
      link.href = url;
      link.download = backupDownloadName(backup.exportedAt);
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 0);
      showManualBackupMessage("Backup downloaded.");
    } catch (error) {
      showManualBackupMessage(error.message, true);
    }
  }

  function chooseManualBackupFile() {
    backupFile.value = "";
    backupFile.click();
  }

  async function restoreManualBackup() {
    clearManualBackupMessage();
    const [file] = backupFile.files;
    if (!file) return;

    try {
      const data = parseBackupDocument(await file.text(), migrateStorage);
      const currentData = await loadStorage();
      if (storageDataEqual(data, currentData)) {
        showManualBackupMessage("Current data already matches this backup.");
        return;
      }
      if (!confirm("Replace all current commands and settings with the selected backup?")) return;
      if (hasUserData(currentData)) await preserveSnapshot(currentData);
      await chrome.storage.local.set(data);
      showManualBackupMessage("Backup restored.");
      await loadSettings();
      await renderBackupState();
    } catch (error) {
      showManualBackupMessage(error.message, true);
    } finally {
      backupFile.value = "";
    }
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "local") return;
    if (changes[BACKUP_STATUS_KEY]) renderBackupState();
    if (changes[SETTINGS_STORAGE_KEY]) {
      settings = normalizeSettings(changes[SETTINGS_STORAGE_KEY].newValue);
      render();
    }
  }

  function showStatus(message) {
    clearTimeout(statusTimer);
    saveStatus.textContent = message;
    statusTimer = setTimeout(() => {
      saveStatus.textContent = "";
    }, 2000);
  }

  async function chooseFolder() {
    clearBackupMessage();

    try {
      const directoryHandle = await window.showDirectoryPicker({
        id: "site-command-palette-backup",
        mode: "readwrite"
      });
      const currentData = await loadStorage();
      const inspection = await inspectBackupDirectory(
        directoryHandle,
        globalThis.SiteCommandPaletteCore.migrateStorage,
        currentData
      );

      if (inspection.status === "invalid") {
        throw new Error(`The existing backup is invalid and was not changed. ${inspection.message}`);
      }
      if (inspection.status === "missing") {
        await setBackupDirectory(directoryHandle);
        await performBackup("Backup folder selected and initial backup created.");
        return;
      }
      if (inspection.matchesCurrent) {
        await setBackupDirectory(directoryHandle, { lastBackupAt: inspection.exportedAt });
        showBackupMessage("Backup folder connected. Your data is already up to date.");
        await renderBackupState();
        return;
      }

      pendingDirectory = { directoryHandle, inspection, currentData };
      existingBackupDate.textContent = formatBackupDate(inspection.exportedAt);
      existingBackupDialog.returnValue = "cancel";
      existingBackupDialog.showModal();
    } catch (error) {
      if (error?.name !== "AbortError") {
        showBackupMessage(error.message, true);
        await renderBackupState();
      }
    }
  }

  async function runManualBackup() {
    const state = await getBackupState();
    if (!state.directoryHandle) return;

    try {
      if (!(await requestBackupPermission(state.directoryHandle))) {
        throw new Error("Backup folder permission was not granted.");
      }
      await performBackup("Backup completed.");
    } catch (error) {
      showBackupMessage(error.message, true);
      await renderBackupState();
    }
  }

  async function performBackup(successMessage) {
    const data = await loadStorage();
    const result = await writeBackup(data);

    if (!["written", "unchanged"].includes(result.status)) {
      throw new Error(result.message ?? "The backup could not be written.");
    }

    showBackupMessage(successMessage);
    await renderBackupState();
  }

  async function restoreFromBackup() {
    clearBackupMessage();
    try {
      if (!currentBackupState?.directoryHandle) return;
      const [fileHandle] = await window.showOpenFilePicker({
        id: "site-command-palette-restore",
        startIn: currentBackupState.directoryHandle,
        multiple: false,
        types: [{
          description: "Site Command Palette backup",
          accept: { "application/json": [".json"] }
        }]
      });
      const data = await readBackupFile(
        fileHandle,
        globalThis.SiteCommandPaletteCore.migrateStorage
      );
      const currentData = await loadStorage();
      if (globalThis.SiteCommandPaletteBackup.storageDataEqual(data, currentData)) {
        showBackupMessage("Current data already matches this backup.");
        return;
      }
      if (!confirm("Replace all current commands and settings with the selected backup?")) return;
      if (hasUserData(currentData)) await preserveSnapshot(currentData);
      await chrome.storage.local.set(data);
      showBackupMessage("Backup restored.");
      await loadSettings();
      await renderBackupState();
    } catch (error) {
      if (error?.name !== "AbortError") showBackupMessage(error.message, true);
    }
  }

  async function disableAutomaticBackup() {
    if (!confirm("Disable backup and forget the selected folder? Existing backup files will be kept.")) {
      return;
    }

    await clearBackupDirectory();
    showBackupMessage("Backup disabled.");
    await renderBackupState();
  }

  async function renderBackupState() {
    const state = await getBackupState();
    currentBackupState = state;
    const configured = Boolean(state.directoryHandle);
    const permission = await queryBackupPermission(state.directoryHandle);
    const storedStatus = (await chrome.storage.local.get(BACKUP_STATUS_KEY))[BACKUP_STATUS_KEY];
    const needsPermission = configured && (permission !== "granted" ||
      storedStatus?.status === "permission-required");

    backupFolder.textContent = state.directoryName ?? "No folder selected";
    lastBackup.textContent = state.lastBackupAt
      ? formatBackupDate(state.lastBackupAt)
      : "Never";
    chooseBackupFolder.textContent = configured ? "Change backup folder" : "Choose backup folder";
    backupNow.disabled = !configured;
    backupNow.textContent = needsPermission ? "Reconnect folder" : "Backup now";
    restoreBackup.disabled = !configured;
    disableBackup.disabled = !configured;
    backupHistoryLimit.value = String(state.historyLimit);

    if (!configured) {
      backupState.textContent = "Not configured";
      backupState.dataset.status = "idle";
    } else if (needsPermission) {
      backupState.textContent = "Needs permission";
      backupState.dataset.status = "warning";
      showBackupMessage("Automatic backups are paused. Click Reconnect folder to approve access again. Your saved data and existing backups are kept.", true);
    } else if (state.lastError || storedStatus?.status === "error") {
      backupState.textContent = "Backup failed";
      backupState.dataset.status = "error";
      showBackupMessage(state.lastError || storedStatus.message, true);
    } else {
      backupState.textContent = "Active";
      backupState.dataset.status = "active";
    }
  }

  async function changeHistoryLimit() {
    const state = currentBackupState ?? await getBackupState();
    const previousLimit = state.historyLimit;
    const nextLimit = Number(backupHistoryLimit.value);
    const isLower = nextLimit !== -1 && (previousLimit === -1 || nextLimit < previousLimit);

    if (isLower && !confirm(
      `Keep only the latest ${nextLimit} historical ${nextLimit === 1 ? "version" : "versions"}? ` +
      "Older history files will be permanently removed."
    )) {
      backupHistoryLimit.value = String(previousLimit);
      return;
    }

    try {
      if (isLower && state.directoryHandle &&
          !(await requestBackupPermission(state.directoryHandle))) {
        backupHistoryLimit.value = String(previousLimit);
        showBackupMessage("Folder access was not granted. Backup history was not changed.", true);
        return;
      }

      const result = await setHistoryLimit(nextLimit);
      if (result.status === "permission-required") {
        backupHistoryLimit.value = String(previousLimit);
        showBackupMessage("Folder access is unavailable. Backup history was not changed.", true);
        return;
      }
      const removal = result.removed > 0
        ? ` ${result.removed} older ${result.removed === 1 ? "version was" : "versions were"} removed.`
        : "";
      showBackupMessage(`Backup history setting saved.${removal}`);
      await renderBackupState();
    } catch (error) {
      backupHistoryLimit.value = String(previousLimit);
      showBackupMessage(error.message, true);
    }
  }

  async function resolveExistingBackup() {
    const selection = existingBackupDialog.returnValue;
    const pending = pendingDirectory;
    pendingDirectory = null;
    if (!pending || !["restore", "replace"].includes(selection)) return;

    clearBackupMessage();
    try {
      await setBackupDirectory(pending.directoryHandle, {
        lastBackupAt: pending.inspection.exportedAt
      });

      if (selection === "restore") {
        if (hasUserData(pending.currentData)) await preserveSnapshot(pending.currentData);
        await chrome.storage.local.set(pending.inspection.data);
        await loadSettings();
        showBackupMessage("Existing backup restored and automatic backup enabled.");
      } else if (selection === "replace") {
        const result = await writeBackup(pending.currentData);
        if (!["written", "unchanged"].includes(result.status)) {
          throw new Error(result.message ?? "The backup could not be replaced.");
        }
        showBackupMessage("Existing backup replaced.");
      }

      await renderBackupState();
    } catch (error) {
      showBackupMessage(error.message, true);
      await renderBackupState();
    }
  }

  function hasUserData(data) {
    const commandCount = Object.values(data[COMMANDS_STORAGE_KEY] ?? {})
      .reduce((total, commands) => total + commands.length, 0);
    const storedSettings = data[SETTINGS_STORAGE_KEY];

    return commandCount > 0 || storedSettings.theme !== "light" ||
      Object.keys(storedSettings.siteThemes).length > 0 ||
      storedSettings.disabledHostnames.length > 0;
  }

  function showBackupMessage(message, isError = false) {
    backupMessage.textContent = message;
    backupMessage.dataset.status = isError ? "error" : "success";
  }

  function clearBackupMessage() {
    backupMessage.textContent = "";
    delete backupMessage.dataset.status;
  }

  function showManualBackupMessage(message, isError = false) {
    manualBackupMessage.textContent = message;
    manualBackupMessage.dataset.status = isError ? "error" : "success";
  }

  function clearManualBackupMessage() {
    manualBackupMessage.textContent = "";
    delete manualBackupMessage.dataset.status;
  }
})();

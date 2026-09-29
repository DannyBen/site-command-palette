(() => {
  const { normalizeSettings, resolveTheme } = globalThis.SiteCommandPaletteCore;
  const {
    COMMANDS_STORAGE_KEY,
    SETTINGS_STORAGE_KEY,
    loadStorage
  } = globalThis.SiteCommandPaletteStorage;
  const {
    clearBackupDirectory,
    getBackupState,
    inspectBackupDirectory,
    preserveSnapshot,
    queryBackupPermission,
    readBackup,
    requestBackupPermission,
    setBackupDirectory,
    setHistoryLimit,
    writeBackup
  } = globalThis.SiteCommandPaletteBackup;
  const systemTheme = matchMedia("(prefers-color-scheme: dark)");

  const globalTheme = document.getElementById("global-theme");
  const overrideList = document.getElementById("override-list");
  const emptyOverrides = document.getElementById("empty-overrides");
  const overrideCount = document.getElementById("override-count");
  const saveStatus = document.getElementById("save-status");
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

  globalTheme.addEventListener("change", saveGlobalTheme);
  overrideList.addEventListener("change", updateSiteTheme);
  overrideList.addEventListener("click", removeSiteTheme);
  systemTheme.addEventListener("change", applyTheme);
  chrome.storage.onChanged.addListener(handleStorageChange);
  chooseBackupFolder.addEventListener("click", chooseFolder);
  backupNow.addEventListener("click", runManualBackup);
  restoreBackup.addEventListener("click", restoreFromBackup);
  disableBackup.addEventListener("click", disableAutomaticBackup);
  backupHistoryLimit.addEventListener("change", changeHistoryLimit);
  existingBackupDialog.addEventListener("close", resolveExistingBackup);

  loadSettings();
  renderBackupState();

  async function loadSettings() {
    const stored = await loadStorage();
    settings = stored[SETTINGS_STORAGE_KEY];
    render();
  }

  function render() {
    globalTheme.value = settings.theme;
    applyTheme();
    renderSiteThemes();
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

    row.className = "override";
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

  async function storeSettings(message) {
    settings = normalizeSettings(settings);
    await chrome.storage.local.set({ [SETTINGS_STORAGE_KEY]: settings });
    render();
    showStatus(message);
  }

  function handleStorageChange(changes, areaName) {
    if (areaName !== "local" || !changes[SETTINGS_STORAGE_KEY]) return;
    settings = normalizeSettings(changes[SETTINGS_STORAGE_KEY].newValue);
    render();
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
      existingBackupDate.textContent = formatDate(inspection.exportedAt);
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
    if (!confirm("Replace all current commands and settings with the selected backup?")) return;

    clearBackupMessage();
    try {
      const data = await readBackup(globalThis.SiteCommandPaletteCore.migrateStorage);
      const currentData = await loadStorage();
      if (globalThis.SiteCommandPaletteBackup.storageDataEqual(data, currentData)) {
        showBackupMessage("Current data already matches this backup.");
        return;
      }
      if (hasUserData(currentData)) await preserveSnapshot(currentData);
      await chrome.storage.local.set(data);
      showBackupMessage("Backup restored.");
      await loadSettings();
      await renderBackupState();
    } catch (error) {
      showBackupMessage(error.message, true);
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
    const configured = Boolean(state.directoryHandle);
    const permission = await queryBackupPermission(state.directoryHandle);

    backupFolder.textContent = state.directoryName ?? "No folder selected";
    lastBackup.textContent = state.lastBackupAt
      ? new Date(state.lastBackupAt).toLocaleString()
      : "Never";
    chooseBackupFolder.textContent = configured ? "Change backup folder" : "Choose backup folder";
    backupNow.disabled = !configured;
    restoreBackup.disabled = !configured;
    disableBackup.disabled = !configured;
    backupHistoryLimit.value = String(state.historyLimit);

    if (!configured) {
      backupState.textContent = "Not configured";
      backupState.dataset.status = "idle";
    } else if (permission !== "granted") {
      backupState.textContent = "Needs permission";
      backupState.dataset.status = "warning";
    } else if (state.lastError) {
      backupState.textContent = "Backup failed";
      backupState.dataset.status = "error";
      showBackupMessage(state.lastError, true);
    } else {
      backupState.textContent = "Active";
      backupState.dataset.status = "active";
    }
  }

  async function changeHistoryLimit() {
    const state = await getBackupState();
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
      const result = await setHistoryLimit(nextLimit);
      if (result.status === "permission-required") {
        showBackupMessage(
          "Backup history setting saved. Reconnect the folder to remove older files.",
          true
        );
        await renderBackupState();
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
      Object.keys(storedSettings.siteThemes).length > 0;
  }

  function formatDate(value) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? "an unknown date" : date.toLocaleString();
  }

  function showBackupMessage(message, isError = false) {
    backupMessage.textContent = message;
    backupMessage.dataset.status = isError ? "error" : "success";
  }

  function clearBackupMessage() {
    backupMessage.textContent = "";
    delete backupMessage.dataset.status;
  }
})();

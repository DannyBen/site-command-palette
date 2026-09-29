(() => {
  const BACKUP_FORMAT = "site-command-palette-backup";
  const BACKUP_FORMAT_VERSION = 1;
  const BACKUP_FILE_NAME = "site-command-palette-backup.json";
  const HISTORY_DIRECTORY_NAME = "site-command-palette-history";
  const DEFAULT_HISTORY_LIMIT = 10;
  const HISTORY_LIMITS = new Set([0, 5, 10, 25, 50, -1]);
  const DATABASE_NAME = "site-command-palette";
  const DATABASE_VERSION = 1;
  const STORE_NAME = "backup";
  const STATE_KEY = "state";

  function createBackupDocument(data, exportedAt = new Date().toISOString()) {
    return {
      format: BACKUP_FORMAT,
      version: BACKUP_FORMAT_VERSION,
      exportedAt,
      data
    };
  }

  function parseBackupDocument(value, migrateStorage) {
    const document = typeof value === "string" ? JSON.parse(value) : value;

    if (!document || typeof document !== "object" || Array.isArray(document)) {
      throw new Error("This file is not a Site Command Palette backup.");
    }
    if (document.format !== BACKUP_FORMAT) {
      throw new Error("This file is not a Site Command Palette backup.");
    }
    if (document.version !== BACKUP_FORMAT_VERSION) {
      throw new Error(`Unsupported backup format version: ${document.version}`);
    }
    if (!document.data || typeof document.data !== "object" || Array.isArray(document.data)) {
      throw new Error("The backup does not contain valid extension data.");
    }

    return migrateStorage(document.data).data;
  }

  function storageDataEqual(left, right) {
    return stableStringify(left) === stableStringify(right);
  }

  function stableStringify(value) {
    if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
    if (!value || typeof value !== "object") return JSON.stringify(value);

    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableStringify(value[key])}`
    )).join(",")}}`;
  }

  async function getBackupState() {
    const state = await readState();
    return {
      ...(state ?? {}),
      historyLimit: normalizeHistoryLimit(state?.historyLimit)
    };
  }

  async function setBackupDirectory(directoryHandle, { lastBackupAt = null } = {}) {
    const state = await getBackupState();
    await writeState({
      ...state,
      directoryHandle,
      directoryName: directoryHandle.name,
      lastBackupAt,
      lastError: null
    });
  }

  async function clearBackupDirectory() {
    const state = await getBackupState();
    await writeState({ historyLimit: state.historyLimit });
  }

  async function setHistoryLimit(historyLimit) {
    const normalizedLimit = normalizeHistoryLimit(historyLimit);
    const state = await getBackupState();
    await writeState({ ...state, historyLimit: normalizedLimit });

    if (!state.directoryHandle) return { status: "saved", removed: 0 };
    if (await queryBackupPermission(state.directoryHandle) !== "granted") {
      return { status: "permission-required", removed: 0 };
    }

    const removed = await pruneHistory(state.directoryHandle, normalizedLimit);
    return { status: "saved", removed };
  }

  async function queryBackupPermission(directoryHandle) {
    if (!directoryHandle) return "missing";

    try {
      return await directoryHandle.queryPermission({ mode: "readwrite" });
    } catch {
      return "denied";
    }
  }

  async function requestBackupPermission(directoryHandle) {
    const permission = await queryBackupPermission(directoryHandle);
    if (permission === "granted") return true;
    if (permission === "missing" || permission === "denied") return false;

    return (await directoryHandle.requestPermission({ mode: "readwrite" })) === "granted";
  }

  async function writeBackup(data) {
    const state = await getBackupState();
    if (!state.directoryHandle) return { status: "disabled" };

    const permission = await queryBackupPermission(state.directoryHandle);
    if (permission !== "granted") {
      const message = "Backup folder permission is unavailable. Reconnect it in Settings.";
      await writeState({ ...state, lastError: message });
      return { status: "permission-required", message };
    }

    try {
      const inspection = await inspectBackupDirectory(
        state.directoryHandle,
        getStorageMigrator(),
        data
      );

      if (inspection.status === "invalid") {
        throw new Error(`The existing backup is invalid and was not overwritten. ${inspection.message}`);
      }
      if (inspection.status === "valid" && inspection.matchesCurrent) {
        await writeState({
          ...state,
          lastBackupAt: inspection.exportedAt,
          lastError: null
        });
        return { status: "unchanged", lastBackupAt: inspection.exportedAt };
      }
      if (inspection.status === "valid" && state.historyLimit !== 0) {
        await archiveDocument(
          state.directoryHandle,
          inspection.document,
          state.historyLimit
        );
      }

      const backup = createBackupDocument(data);
      await writeDocument(state.directoryHandle, BACKUP_FILE_NAME, backup);

      const lastBackupAt = backup.exportedAt;
      await writeState({ ...state, lastBackupAt, lastError: null });
      return { status: "written", lastBackupAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeState({ ...state, lastError: message });
      return { status: "error", message };
    }
  }

  async function preserveSnapshot(data) {
    const state = await getBackupState();
    if (!state.directoryHandle || state.historyLimit === 0) return { status: "disabled" };
    if (await queryBackupPermission(state.directoryHandle) !== "granted") {
      return { status: "permission-required" };
    }

    await archiveDocument(
      state.directoryHandle,
      createBackupDocument(data),
      state.historyLimit
    );
    return { status: "written" };
  }

  async function inspectBackupDirectory(directoryHandle, migrateStorage, currentData = null) {
    let fileHandle;

    try {
      fileHandle = await directoryHandle.getFileHandle(BACKUP_FILE_NAME);
    } catch (error) {
      if (error?.name === "NotFoundError") return { status: "missing" };
      throw error;
    }

    try {
      const file = await fileHandle.getFile();
      const document = JSON.parse(await file.text());
      const data = parseBackupDocument(document, migrateStorage);

      return {
        status: "valid",
        document,
        data,
        exportedAt: document.exportedAt,
        matchesCurrent: currentData === null ? null : storageDataEqual(data, currentData)
      };
    } catch (error) {
      return {
        status: "invalid",
        message: error instanceof Error ? error.message : String(error)
      };
    }
  }

  async function readBackup(migrateStorage) {
    const state = await getBackupState();
    if (!state.directoryHandle) throw new Error("Choose a backup folder first.");
    if (!(await requestBackupPermission(state.directoryHandle))) {
      throw new Error("Backup folder permission was not granted.");
    }

    const inspection = await inspectBackupDirectory(state.directoryHandle, migrateStorage);
    if (inspection.status === "missing") throw new Error("No backup file was found in this folder.");
    if (inspection.status === "invalid") throw new Error(inspection.message);
    return inspection.data;
  }

  async function archiveDocument(directoryHandle, document, historyLimit) {
    if (historyLimit === 0) return;

    const historyDirectory = await directoryHandle.getDirectoryHandle(HISTORY_DIRECTORY_NAME, {
      create: true
    });
    const timestamp = String(document.exportedAt ?? new Date().toISOString())
      .replaceAll(":", "-")
      .replaceAll(".", "-");
    const suffix = crypto.randomUUID();
    await writeDocument(historyDirectory, `${timestamp}-${suffix}.json`, document);
    await pruneHistory(directoryHandle, historyLimit);
  }

  async function pruneHistory(directoryHandle, historyLimit) {
    if (historyLimit === -1) return 0;

    let historyDirectory;
    try {
      historyDirectory = await directoryHandle.getDirectoryHandle(HISTORY_DIRECTORY_NAME);
    } catch (error) {
      if (error?.name === "NotFoundError") return 0;
      throw error;
    }

    const filenames = [];
    for await (const [name, handle] of historyDirectory.entries()) {
      if (handle.kind === "file" && name.endsWith(".json")) filenames.push(name);
    }
    filenames.sort();

    const obsolete = filenames.slice(0, Math.max(0, filenames.length - historyLimit));
    await Promise.all(obsolete.map((name) => historyDirectory.removeEntry(name)));
    return obsolete.length;
  }

  async function writeDocument(directoryHandle, filename, document) {
    const fileHandle = await directoryHandle.getFileHandle(filename, { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(`${JSON.stringify(document, null, 2)}\n`);
    await writable.close();
  }

  function normalizeHistoryLimit(value) {
    const numericValue = Number(value);
    return HISTORY_LIMITS.has(numericValue) ? numericValue : DEFAULT_HISTORY_LIMIT;
  }

  function getStorageMigrator() {
    const migrateStorage = globalThis.SiteCommandPaletteCore?.migrateStorage;
    if (!migrateStorage) throw new Error("Storage migration support is unavailable.");
    return migrateStorage;
  }

  function openDatabase() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      request.addEventListener("upgradeneeded", () => {
        if (!request.result.objectStoreNames.contains(STORE_NAME)) {
          request.result.createObjectStore(STORE_NAME);
        }
      });
      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
    });
  }

  async function readState() {
    const database = await openDatabase();

    try {
      return await runRequest(database, "readonly", (store) => store.get(STATE_KEY));
    } finally {
      database.close();
    }
  }

  async function writeState(state) {
    const database = await openDatabase();

    try {
      await runRequest(database, "readwrite", (store) => store.put(state, STATE_KEY));
    } finally {
      database.close();
    }
  }

  function runRequest(database, mode, operation) {
    return new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));

      request.addEventListener("success", () => resolve(request.result));
      request.addEventListener("error", () => reject(request.error));
      transaction.addEventListener("abort", () => reject(transaction.error));
    });
  }

  const api = Object.freeze({
    BACKUP_FILE_NAME,
    DEFAULT_HISTORY_LIMIT,
    clearBackupDirectory,
    createBackupDocument,
    getBackupState,
    inspectBackupDirectory,
    parseBackupDocument,
    preserveSnapshot,
    queryBackupPermission,
    readBackup,
    requestBackupPermission,
    setBackupDirectory,
    setHistoryLimit,
    storageDataEqual,
    writeBackup
  });

  globalThis.SiteCommandPaletteBackup = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

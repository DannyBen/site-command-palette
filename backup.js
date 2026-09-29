(() => {
  const BACKUP_FORMAT = "site-command-palette-backup";
  const BACKUP_FORMAT_VERSION = 1;
  const BACKUP_FILE_NAME = "site-command-palette-backup.json";
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

  async function getBackupState() {
    const state = await readState();
    return state ?? {};
  }

  async function setBackupDirectory(directoryHandle) {
    const state = await getBackupState();
    await writeState({
      ...state,
      directoryHandle,
      directoryName: directoryHandle.name,
      lastError: null
    });
  }

  async function clearBackupDirectory() {
    await deleteState();
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
      const fileHandle = await state.directoryHandle.getFileHandle(BACKUP_FILE_NAME, {
        create: true
      });
      const writable = await fileHandle.createWritable();
      const backup = createBackupDocument(data);
      await writable.write(`${JSON.stringify(backup, null, 2)}\n`);
      await writable.close();

      const lastBackupAt = backup.exportedAt;
      await writeState({ ...state, lastBackupAt, lastError: null });
      return { status: "written", lastBackupAt };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await writeState({ ...state, lastError: message });
      return { status: "error", message };
    }
  }

  async function readBackup(migrateStorage) {
    const state = await getBackupState();
    if (!state.directoryHandle) throw new Error("Choose a backup folder first.");
    if (!(await requestBackupPermission(state.directoryHandle))) {
      throw new Error("Backup folder permission was not granted.");
    }

    const fileHandle = await state.directoryHandle.getFileHandle(BACKUP_FILE_NAME);
    const file = await fileHandle.getFile();
    return parseBackupDocument(await file.text(), migrateStorage);
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

  async function deleteState() {
    const database = await openDatabase();

    try {
      await runRequest(database, "readwrite", (store) => store.delete(STATE_KEY));
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
    clearBackupDirectory,
    createBackupDocument,
    getBackupState,
    parseBackupDocument,
    queryBackupPermission,
    readBackup,
    requestBackupPermission,
    setBackupDirectory,
    writeBackup
  });

  globalThis.SiteCommandPaletteBackup = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})();

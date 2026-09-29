const test = require("node:test");
const assert = require("node:assert/strict");

const { migrateStorage } = require("../core.js");
const {
  BACKUP_FILE_NAME,
  createBackupDocument,
  inspectBackupDirectory,
  parseBackupDocument,
  readBackupFile
} = require("../backup.js");

test("backup documents round-trip normalized extension data", async () => {
  const data = migrateStorage({
    commandsByHostname: {
      "example.com": [
        { id: "docs", name: "Documentation", url: "https://example.com/docs" }
      ]
    },
    settings: { theme: "dark", siteThemes: {} }
  }).data;
  const document = createBackupDocument(data, "2026-09-29T12:00:00.000Z");

  assert.equal(BACKUP_FILE_NAME, "site-command-palette-backup.json");
  assert.equal(document.format, "site-command-palette-backup");
  assert.equal(document.version, 1);
  assert.equal(document.exportedAt, "2026-09-29T12:00:00.000Z");
  assert.deepEqual(parseBackupDocument(JSON.stringify(document), migrateStorage), data);
  assert.deepEqual(
    await readBackupFile({
      getFile: async () => ({ text: async () => JSON.stringify(document) })
    }, migrateStorage),
    data
  );
});

test("backup parsing rejects unrelated and unsupported files", () => {
  assert.throws(
    () => parseBackupDocument("{}", migrateStorage),
    /not a Site Command Palette backup/
  );
  assert.throws(
    () => parseBackupDocument({
      format: "site-command-palette-backup",
      version: 2,
      data: {}
    }, migrateStorage),
    /Unsupported backup format version: 2/
  );
  assert.throws(
    () => parseBackupDocument("not json", migrateStorage),
    /Unexpected token/
  );
});

test("backup folder inspection detects missing, valid, matching, and invalid backups", async () => {
  const data = migrateStorage({
    commandsByHostname: {},
    settings: { theme: "light", siteThemes: {} }
  }).data;
  const validDocument = createBackupDocument(data, "2026-09-29T12:00:00.000Z");

  assert.deepEqual(
    await inspectBackupDirectory(fakeDirectory(), migrateStorage, data),
    { status: "missing" }
  );

  const valid = await inspectBackupDirectory(
    fakeDirectory(JSON.stringify(validDocument)),
    migrateStorage,
    data
  );
  assert.equal(valid.status, "valid");
  assert.equal(valid.matchesCurrent, true);
  assert.equal(valid.exportedAt, "2026-09-29T12:00:00.000Z");

  const different = await inspectBackupDirectory(
    fakeDirectory(JSON.stringify(validDocument)),
    migrateStorage,
    migrateStorage({ settings: { theme: "dark" } }).data
  );
  assert.equal(different.matchesCurrent, false);

  const invalid = await inspectBackupDirectory(fakeDirectory("not json"), migrateStorage, data);
  assert.equal(invalid.status, "invalid");
});

function fakeDirectory(contents) {
  return {
    async getFileHandle() {
      if (contents === undefined) throw new DOMException("Missing", "NotFoundError");
      return {
        async getFile() {
          return { text: async () => contents };
        }
      };
    }
  };
}

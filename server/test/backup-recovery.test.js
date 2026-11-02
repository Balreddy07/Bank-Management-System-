const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const {
  buildBackupFileName,
  createDatabaseBackup,
  loadDatabaseConfig,
  sanitizeSensitiveText,
  validateBackupFile,
  verifyBackupIntegrity,
  restoreDatabaseBackup,
  findLatestValidBackup,
} = require("../src/scripts/backup-recovery");

function makeConfig(overrides = {}) {
  return {
    host: "localhost",
    port: 3306,
    user: "root",
    password: "super-secret-password",
    database: "bank_management_system",
    ...overrides,
  };
}

function createFakeMysqlScript() {
  const scriptPath = path.join(os.tmpdir(), `fake-mysqldump-${process.pid}-${Math.random().toString(16).slice(2)}.js`);
  const scriptText = `
    const fs = require("node:fs");
    const args = process.argv.slice(2);
    const index = args.indexOf("--result-file");
    const outputFile = index >= 0 ? args[index + 1] : null;
    if (!outputFile) {
      console.error("Missing --result-file");
      process.exit(1);
    }
    const content = "CREATE TABLE customers (customer_id BIGINT NOT NULL, full_name VARCHAR(100));\\nINSERT INTO customers VALUES (1, 'Test Customer');\\n";
    fs.writeFileSync(outputFile, content, "utf8");
  `;
  fs.writeFileSync(scriptPath, scriptText, "utf8");
  return scriptPath;
}

test("backup configuration reads the actual database settings and fails safely when missing", () => {
  assert.deepEqual(loadDatabaseConfig({ DB_HOST: "localhost", DB_USER: "root", DB_NAME: "bank_management_system" }), {
    host: "localhost",
    port: 3306,
    user: "root",
    password: "",
    database: "bank_management_system",
  });

  assert.doesNotThrow(() => loadDatabaseConfig({ DB_HOST: "localhost", DB_USER: "root", DB_NAME: "bank_management_system" }));
  assert.throws(() => loadDatabaseConfig({ DB_USER: "root", DB_NAME: "bad-name!" }), /invalid DB_NAME/);
});

test("backup filenames are unique, timestamped, and use valid formatting", () => {
  const timestamp = new Date("2026-11-02T14:15:30+05:30");
  assert.match(buildBackupFileName("bank_management_system", timestamp), /^bank_management_system_20261102_\d{6}\.sql$/);
});

test("backup creation writes a valid dump plus checksum without exposing credentials", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-unit-"));
  const scriptPath = createFakeMysqlScript();
  const config = makeConfig({ password: "super-secret-password" });

  try {
    const timestamp = new Date("2026-11-02T14:15:30+05:30");
    const first = createDatabaseBackup({
      config,
      backupRoot: tempDir,
      timestamp,
      commandName: scriptPath,
    });
    const second = createDatabaseBackup({
      config,
      backupRoot: tempDir,
      timestamp,
      commandName: scriptPath,
    });

    assert.match(path.basename(first.backupFilePath), /^bank_management_system_20261102_\d{6}\.sql$/);
    assert.match(path.basename(second.backupFilePath), /^bank_management_system_20261102_\d{6}_1\.sql$/);
    assert.equal(fs.existsSync(first.checksumFilePath), true);
    assert.equal(fs.readFileSync(first.checksumFilePath, "utf8").includes("super-secret-password"), false);

    const sanitized = sanitizeSensitiveText("DB_PASSWORD=super-secret-password password=super-secret-password", config);
    assert.equal(sanitized.includes("super-secret-password"), false);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
    fs.rmSync(scriptPath, { force: true });
  }
});

test("failed backup operations throw meaningful, sanitized errors", () => {
  const config = makeConfig();
  assert.throws(() => createDatabaseBackup({
    config,
    backupRoot: path.join(os.tmpdir(), "missing-dir-for-backup"),
    timestamp: new Date("2026-11-02T14:15:30Z"),
    commandName: "definitely-not-mysql",
  }), /Backup failed:/);
});

test(".gitignore contains the backup directory to keep generated files out of source control", () => {
  const repoRoot = path.resolve(__dirname, "..", "..", "");
  const gitIgnore = fs.readFileSync(path.join(repoRoot, ".gitignore"), "utf8");
  assert.match(gitIgnore, /bank-management-system-backups\//);
});

test("valid backup files are accepted and checksum verification works", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-verify-"));
  const dumpPath = path.join(tempDir, "valid_backup.sql");
  const dumpContents = "CREATE TABLE accounts (account_id INT NOT NULL);\nINSERT INTO accounts VALUES (1);\n";
  const checksum = require("node:crypto").createHash("sha256").update(dumpContents).digest("hex");

  fs.writeFileSync(dumpPath, dumpContents, "utf8");
  fs.writeFileSync(`${dumpPath}.sha256`, `${checksum}  valid_backup.sql\n`, { mode: 0o600 });

  const fileInfo = validateBackupFile(dumpPath);
  const verified = verifyBackupIntegrity(dumpPath, `${dumpPath}.sha256`);

  assert.equal(fileInfo.filePath, dumpPath);
  assert.equal(verified.valid, true);
  assert.equal(verified.actual, checksum);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("missing and invalid backup files are rejected", () => {
  assert.throws(() => validateBackupFile(path.join(os.tmpdir(), "definitely-missing.sql")), /does not exist/);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-invalid-"));
  const invalidPath = path.join(tempDir, "invalid.sql");
  fs.writeFileSync(invalidPath, "not a mysql dump", "utf8");

  assert.throws(() => validateBackupFile(invalidPath), /not a valid MySQL dump/);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("corrupted backups are detected by checksum verification", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-corrupt-"));
  const dumpPath = path.join(tempDir, "corrupt.sql");
  const checksumPath = `${dumpPath}.sha256`;
  fs.writeFileSync(dumpPath, "CREATE TABLE accounts (account_id INT);\n", "utf8");
  fs.writeFileSync(checksumPath, "deadbeef  corrupt.sql\n", "utf8");

  assert.throws(() => verifyBackupIntegrity(dumpPath, checksumPath), /checksum mismatch|missing/);
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("restore targets are validated and destructive restore is blocked by default", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-restore-"));
  const dumpPath = path.join(tempDir, "restore.sql");
  const dumpContents = "CREATE TABLE customers (customer_id INT NOT NULL);\nINSERT INTO customers VALUES (1);\n";
  const checksum = require("node:crypto").createHash("sha256").update(dumpContents).digest("hex");
  fs.writeFileSync(dumpPath, dumpContents, "utf8");
  fs.writeFileSync(`${dumpPath}.sha256`, `${checksum}  restore.sql\n`, "utf8");

  await assert.rejects(() => restoreDatabaseBackup({
    config: makeConfig(),
    backupFile: dumpPath,
    targetDatabase: "bad-target-name!",
    mysqlCommand: process.execPath,
  }), /invalid/);

  await assert.rejects(() => restoreDatabaseBackup({
    config: makeConfig(),
    backupFile: dumpPath,
    targetDatabase: "bank_management_system",
    mysqlCommand: process.execPath,
  }), /Refusing to overwrite the active database/);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("restore fails safely when the MySQL client is unavailable or the backup is invalid", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-restore-fail-"));
  const dumpPath = path.join(tempDir, "restore.sql");
  const dumpContents = "CREATE TABLE customers (customer_id INT NOT NULL);\nINSERT INTO customers VALUES (1);\n";
  const checksum = require("node:crypto").createHash("sha256").update(dumpContents).digest("hex");
  fs.writeFileSync(dumpPath, dumpContents, "utf8");
  fs.writeFileSync(`${dumpPath}.sha256`, `${checksum}  restore.sql\n`, "utf8");

  await assert.rejects(() => restoreDatabaseBackup({
    config: makeConfig(),
    backupFile: dumpPath,
    targetDatabase: "restore_target",
    mysqlCommand: "definitely-not-mysql",
  }), /Restore failed:/);

  fs.rmSync(tempDir, { recursive: true, force: true });
});

test("latest backup selection prefers valid, checksum-verified dumps", () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "backup-latest-"));
  const validDump = path.join(tempDir, "bank_management_system_20261102_020000.sql");
  const validContents = "CREATE TABLE customers (customer_id INT NOT NULL);\nINSERT INTO customers VALUES (1);\n";
  fs.writeFileSync(validDump, validContents, "utf8");
  fs.writeFileSync(`${validDump}.sha256`, `${require("node:crypto").createHash("sha256").update(validContents).digest("hex")}  bank_management_system_20261102_020000.sql\n`, "utf8");

  const invalidDump = path.join(tempDir, "older.sql");
  fs.writeFileSync(invalidDump, "not a mysql dump", "utf8");

  const latest = findLatestValidBackup(tempDir);
  assert.equal(path.basename(latest), "bank_management_system_20261102_020000.sql");

  fs.rmSync(tempDir, { recursive: true, force: true });
});

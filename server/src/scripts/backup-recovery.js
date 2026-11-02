const crypto = require("node:crypto");
const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const DEFAULT_BACKUP_DIRECTORY = "bank-management-system-backups";
const SAFE_DATABASE_PATTERN = /^[A-Za-z0-9_]+$/;

function loadDatabaseConfig(env = process.env) {
  const config = {
    host: env.DB_HOST || "localhost",
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER || "root",
    password: env.DB_PASSWORD || "",
    database: env.DB_NAME || "bank_management_system",
  };

  if (!config.user) {
    throw new Error("Database configuration is missing the DB_USER value.");
  }
  if (!config.database) {
    throw new Error("Database configuration is missing the DB_NAME value.");
  }
  if (!SAFE_DATABASE_PATTERN.test(config.database)) {
    throw new Error("Database configuration has an invalid DB_NAME value.");
  }

  return config;
}

function resolveBackupRoot(env = process.env) {
  if (env.BACKUP_ROOT) {
    return path.resolve(env.BACKUP_ROOT);
  }

  return path.resolve(__dirname, "../../../../", DEFAULT_BACKUP_DIRECTORY);
}

function sanitizeSensitiveText(value, config = {}) {
  if (typeof value !== "string") return value;

  let sanitized = value;
  const sensitiveValues = [
    config.password,
    config.database,
    config.user,
    config.host,
    String(config.port || ""),
  ].filter((entry) => typeof entry === "string" && entry.length > 0);

  for (const token of sensitiveValues) {
    sanitized = sanitized.split(token).join("[REDACTED]");
  }

  sanitized = sanitized.replace(/--password=(?:[^\s]+)/gi, "--password=[REDACTED]");
  sanitized = sanitized.replace(/password\s*[:=]\s*['"][^'"]+['"]/gi, "password=[REDACTED]");
  sanitized = sanitized.replace(/DB_PASSWORD\s*[:=]\s*[^\s]+/gi, "DB_PASSWORD=[REDACTED]");
  return sanitized;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeSqlIdentifier(name) {
  return `\`${String(name).replace(/`/g, "``")}\``;
}

function formatTimestamp(date = new Date()) {
  const pad = (value) => String(value).padStart(2, "0");
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    "_",
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join("");
}

function buildBackupFileName(databaseName, timestamp = new Date()) {
  return `${databaseName}_${formatTimestamp(timestamp)}.sql`;
}

function writeMysqlDefaultsFile(config) {
  const defaultsPath = path.join(
    os.tmpdir(),
    `bank-backup-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.cnf`
  );

  const fileContents = [
    "[client]",
    `host=${config.host}`,
    `port=${config.port}`,
    `user=${config.user}`,
    `password=${config.password || ""}`,
    "default-character-set=utf8mb4",
    "",
  ].join("\n");

  fs.writeFileSync(defaultsPath, fileContents, { mode: 0o600 });
  return defaultsPath;
}

function runMysqlCommand({ commandName, config, args = [], input = null, timeoutMs = 600000 } = {}) {
  const defaultsFile = writeMysqlDefaultsFile(config);
  const isNodeScript = typeof commandName === "string" && /\.(?:c|m)?js$/i.test(commandName);
  const executable = isNodeScript ? process.execPath : commandName;
  const commandArguments = isNodeScript
    ? [commandName, "--defaults-extra-file", defaultsFile, ...args]
    : ["--defaults-extra-file", defaultsFile, ...args];

  try {
    const result = spawnSync(executable, commandArguments, {
      encoding: "utf8",
      input,
      timeout: timeoutMs,
      maxBuffer: 1024 * 1024 * 16,
    });

    const stdout = typeof result.stdout === "string" ? result.stdout : "";
    const stderr = typeof result.stderr === "string" ? result.stderr : "";
    const combinedOutput = sanitizeSensitiveText(`${stdout}\n${stderr}`.trim(), config);

    if (result.error) {
      const details = sanitizeSensitiveText(result.error.message || "Command execution failed.", config);
      throw new Error(`MySQL command unavailable: ${details}`);
    }

    if (result.status !== 0) {
      throw new Error(`Command failed (${commandName}): ${combinedOutput || "unknown error"}`);
    }

    return { stdout, stderr, status: result.status };
  } finally {
    fs.rmSync(defaultsFile, { force: true });
  }
}

function computeSha256(filePath) {
  const hash = crypto.createHash("sha256");
  const fileData = fs.readFileSync(filePath);
  hash.update(fileData);
  return hash.digest("hex");
}

function createDatabaseBackup({
  config = loadDatabaseConfig(),
  backupRoot = resolveBackupRoot(),
  timestamp = new Date(),
  commandName = "mysqldump",
} = {}) {
  if (!config || !config.database) {
    throw new Error("Database configuration is missing the DB_NAME value.");
  }

  const resolvedRoot = path.resolve(backupRoot);
  fs.mkdirSync(resolvedRoot, { recursive: true });

  let filePath = path.join(resolvedRoot, buildBackupFileName(config.database, timestamp));
  let tries = 1;
  while (fs.existsSync(filePath)) {
    filePath = path.join(
      resolvedRoot,
      `${path.basename(buildBackupFileName(config.database, timestamp), ".sql")}_${tries}.sql`
    );
    tries += 1;
  }

  try {
    runMysqlCommand({
      commandName,
      config,
      args: [
        "--single-transaction",
        "--routines",
        "--events",
        "--triggers",
        "--lock-tables=false",
        "--no-create-db",
        "--databases",
        config.database,
        "--result-file",
        filePath,
      ],
    });
  } catch (error) {
    throw new Error(`Backup failed: ${sanitizeSensitiveText(error.message, config)}`);
  }

  const checksum = computeSha256(filePath);
  const checksumPath = `${filePath}.sha256`;
  fs.writeFileSync(checksumPath, `${checksum}  ${path.basename(filePath)}\n`, { mode: 0o600 });

  try {
    fs.chmodSync(filePath, 0o600);
  } catch (error) {
    // Best effort on Windows and non-POSIX hosts.
  }

  return {
    backupFilePath: filePath,
    checksumFilePath: checksumPath,
    checksum,
    backupRoot: resolvedRoot,
    databaseName: config.database,
    createdAt: timestamp.toISOString(),
  };
}

function validateBackupFile(filePath) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error("The selected backup file does not exist.");
  }

  const stats = fs.statSync(resolvedPath);
  if (!stats.isFile()) {
    throw new Error("The selected backup path is not a regular file.");
  }
  if (stats.size === 0) {
    throw new Error("The selected backup file is empty.");
  }

  let content;
  try {
    content = fs.readFileSync(resolvedPath, "utf8");
  } catch (error) {
    throw new Error("The selected backup file is not readable.");
  }

  if (content.includes("\u0000")) {
    throw new Error("The selected backup file appears to be corrupted.");
  }

  const hasExpectedDumpMarkers = /CREATE TABLE|CREATE VIEW|INSERT INTO|-- MySQL dump|-- MariaDB dump/i.test(content);
  if (!hasExpectedDumpMarkers) {
    throw new Error("The selected file is not a valid MySQL dump.");
  }

  return { filePath: resolvedPath, size: stats.size };
}

function verifyBackupIntegrity(filePath, checksumFilePath = `${filePath}.sha256`) {
  validateBackupFile(filePath);

  if (!fs.existsSync(checksumFilePath)) {
    throw new Error("The backup checksum file is missing; integrity verification could not complete.");
  }

  const checksumText = fs.readFileSync(checksumFilePath, "utf8").trim();
  const expected = checksumText.split(/\s+/)[0];
  const actual = computeSha256(filePath);

  if (actual !== expected) {
    throw new Error("Backup checksum mismatch: the file may be incomplete or corrupted.");
  }

  return { valid: true, expected, actual };
}

function findLatestValidBackup(backupRoot = resolveBackupRoot()) {
  if (!fs.existsSync(backupRoot)) {
    throw new Error(`No backup directory was found at ${backupRoot}.`);
  }

  const listing = fs.readdirSync(backupRoot)
    .filter((entry) => entry.endsWith(".sql"))
    .sort((left, right) => {
      const leftPath = path.join(backupRoot, left);
      const rightPath = path.join(backupRoot, right);
      return fs.statSync(rightPath).mtimeMs - fs.statSync(leftPath).mtimeMs;
    });

  for (const filename of listing) {
    const filePath = path.join(backupRoot, filename);
    try {
      validateBackupFile(filePath);
      const checksumPath = `${filePath}.sha256`;
      if (fs.existsSync(checksumPath)) {
        verifyBackupIntegrity(filePath, checksumPath);
      }
      return filePath;
    } catch (error) {
      // Skip invalid or stale backup candidates.
    }
  }

  throw new Error(`No valid backup was found in ${backupRoot}.`);
}

function normalizeMysqlDumpForTarget(sqlDump, sourceDatabase) {
  const sourceQuoted = escapeSqlIdentifier(sourceDatabase);
  return sqlDump
    .replace(new RegExp(`(?:^|\\n)\\s*CREATE\\s+DATABASE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${escapeRegex(sourceQuoted)}\\s*;?`, "gi"), "")
    .replace(new RegExp(`(?:^|\\n)\\s*USE\\s+${escapeRegex(sourceQuoted)}\\s*;?`, "gi"), "")
    .replace(new RegExp(`(?:^|\\n)\\s*DROP\\s+DATABASE\\s+(?:IF\\s+EXISTS\\s+)?${escapeRegex(sourceQuoted)}\\s*;?`, "gi"), "");
}

async function readRecoveryTestResult(writePath, data) {
  const payload = {
    generatedAt: new Date().toISOString(),
    status: data.status,
    backupFile: path.basename(data.backupFile || ""),
    database: data.database || null,
    accountCount: Number(data.accountCount || 0),
    transactionCount: Number(data.transactionCount || 0),
    orphanAccounts: Number(data.orphanAccounts || 0),
    orphanTransactions: Number(data.orphanTransactions || 0),
    notes: data.notes || "",
  };

  await fsPromises.mkdir(path.dirname(writePath), { recursive: true });
  await fsPromises.writeFile(writePath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  return payload;
}

async function verifyRecoveredDatabase({ config = loadDatabaseConfig(), targetDatabase, backupFile, checksumFilePath } = {}) {
  const mysql = require("mysql2/promise");
  const connection = mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: targetDatabase,
  });

  try {
    const [tableRows] = await connection.execute(
      `SELECT TABLE_NAME AS tableName
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = ?
         AND TABLE_NAME IN ('customers', 'accounts', 'transactions')`,
      [targetDatabase]
    );
    const requiredTables = new Set(["customers", "accounts", "transactions"]);
    const foundTables = new Set(tableRows.map((row) => row.tableName));
    if ([...requiredTables].some((table) => !foundTables.has(table))) {
      throw new Error("The restored database is missing one or more required accounting tables.");
    }

    const [[accountRow]] = await connection.execute("SELECT COUNT(*) AS total FROM accounts");
    const [[customerRow]] = await connection.execute("SELECT COUNT(*) AS total FROM customers");
    const [[transactionRow]] = await connection.execute("SELECT COUNT(*) AS total FROM transactions");
    const [[orphanAccountRow]] = await connection.execute(
      `SELECT COUNT(*) AS total
       FROM accounts a
       LEFT JOIN customers c ON c.customer_id = a.customer_id
       WHERE c.customer_id IS NULL`
    );
    const [[orphanTransactionRow]] = await connection.execute(
      `SELECT COUNT(*) AS total
       FROM transactions t
       LEFT JOIN accounts a ON a.account_id = t.account_id
       WHERE a.account_id IS NULL`
    );

    return {
      databaseName: targetDatabase,
      backupFile,
      checksumFilePath,
      accountCount: Number(accountRow.total),
      customerCount: Number(customerRow.total),
      transactionCount: Number(transactionRow.total),
      orphanAccounts: Number(orphanAccountRow.total),
      orphanTransactions: Number(orphanTransactionRow.total),
      tableCoverage: [...requiredTables].filter((tableName) => foundTables.has(tableName)),
      status: "pass",
    };
  } catch (error) {
    throw new Error(`Restoration verification failed: ${sanitizeSensitiveText(error.message, config)}`);
  } finally {
    await connection.end();
  }
}

async function restoreDatabaseBackup({
  config = loadDatabaseConfig(),
  backupFile,
  targetDatabase,
  confirmRestore = false,
  mysqlCommand = "mysql",
  checksumFilePath,
} = {}) {
  if (!backupFile) {
    throw new Error("A backup file path is required for restoration.");
  }

  const resolvedBackupFile = path.resolve(backupFile);
  validateBackupFile(resolvedBackupFile);

  const activeDatabaseName = config.database;
  const resolvedTargetDatabase = targetDatabase || `${activeDatabaseName}_restore_${formatTimestamp()}`;

  if (!SAFE_DATABASE_PATTERN.test(resolvedTargetDatabase)) {
    throw new Error("The restore target database name is invalid.");
  }

  if (resolvedTargetDatabase === activeDatabaseName && !confirmRestore) {
    throw new Error("Refusing to overwrite the active database. Re-run with --confirm or use a separate restore target.");
  }

  const checksumPath = checksumFilePath || `${resolvedBackupFile}.sha256`;
  verifyBackupIntegrity(resolvedBackupFile, checksumPath);

  const backupText = fs.readFileSync(resolvedBackupFile, "utf8");
  const normalizedDump = normalizeMysqlDumpForTarget(backupText, config.database);

  try {
    runMysqlCommand({
      commandName: mysqlCommand,
      config,
      args: ["--execute", `CREATE DATABASE IF NOT EXISTS ${escapeSqlIdentifier(resolvedTargetDatabase)};`],
    });

    const restoreResult = runMysqlCommand({
      commandName: mysqlCommand,
      config: { ...config },
      args: ["--database", resolvedTargetDatabase],
      input: normalizedDump,
    });

    if (restoreResult.status !== 0) {
      throw new Error("The backup could not be imported into the restore database.");
    }

    const verification = await verifyRecoveredDatabase({
      config,
      targetDatabase: resolvedTargetDatabase,
      backupFile: resolvedBackupFile,
      checksumFilePath: checksumPath,
    });

    return {
      restoreTarget: resolvedTargetDatabase,
      backupFile: resolvedBackupFile,
      verification,
    };
  } catch (error) {
    throw new Error(`Restore failed: ${sanitizeSensitiveText(error.message || "Restore failed.", config)}`);
  }
}

function printUsage() {
  console.log("Usage: node src/scripts/backup-recovery.js <backup|restore|latest> [options]");
  console.log("  backup            Creates a timestamped MySQL dump in the configured backup directory.");
  console.log("  restore --file path --target my_restore_db [--confirm]");
  console.log("  latest            Prints the latest valid backup file in the backup directory.");
}

async function main(argv = process.argv.slice(2)) {
  const args = argv.slice();
  const command = args.shift();

  if (!command) {
    printUsage();
    return 1;
  }

  try {
    const config = loadDatabaseConfig();

    if (command === "backup") {
      const result = createDatabaseBackup({ config, backupRoot: resolveBackupRoot() });
      console.log(`Backup created at ${result.backupFilePath}`);
      return 0;
    }

    if (command === "latest") {
      const latest = findLatestValidBackup(resolveBackupRoot());
      console.log(latest);
      return 0;
    }

    if (command === "restore") {
      let filePath;
      let targetDatabase;
      let confirmRestore = false;
      while (args.length > 0) {
        const arg = args.shift();
        if (arg === "--file") filePath = args.shift();
        else if (arg === "--target") targetDatabase = args.shift();
        else if (arg === "--confirm") confirmRestore = true;
        else if (arg === "--help" || arg === "-h") {
          printUsage();
          return 0;
        }
      }

      if (!filePath) {
        throw new Error("A backup file path is required for restoration.");
      }

      const result = await restoreDatabaseBackup({
        config,
        backupFile: filePath,
        targetDatabase,
        confirmRestore,
      });
      console.log(`Restore completed into ${result.restoreTarget}.`);
      return 0;
    }

    printUsage();
    return 1;
  } catch (error) {
    const safeMessage = sanitizeSensitiveText(error.message || "An error occurred.", process.env);
    console.error(`Backup and restore failed: ${safeMessage}`);
    return 1;
  }
}

if (require.main === module) {
  main().then((exitCode) => {
    process.exitCode = exitCode;
  });
}

module.exports = {
  buildBackupFileName,
  computeSha256,
  createDatabaseBackup,
  findLatestValidBackup,
  formatTimestamp,
  loadDatabaseConfig,
  main,
  normalizeMysqlDumpForTarget,
  readRecoveryTestResult,
  resolveBackupRoot,
  restoreDatabaseBackup,
  sanitizeSensitiveText,
  validateBackupFile,
  verifyBackupIntegrity,
  verifyRecoveredDatabase,
};


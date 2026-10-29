require("dotenv").config();

const crypto = require("node:crypto");
const fs = require("node:fs/promises");
const path = require("node:path");
const pool = require("../db");

const MIGRATIONS_DIRECTORY = path.join(__dirname, "../../migrations");
const MIGRATION_LOCK_NAME = "bank_management_system_schema_migrations";
const CORE_TABLES = [
  "accounts",
  "customers",
  "transactions",
  "customer_users",
  "transaction_idempotency",
  "staff_users",
];

const REQUIRED_COLUMNS = [
  {
    table: "customers",
    column: "customer_id",
    type: "bigint unsigned",
    definition: "BIGINT UNSIGNED",
    primaryKey: true,
  },
  { table: "customers", column: "full_name", type: "varchar(100)", definition: "VARCHAR(100)" },
  { table: "customers", column: "address", type: "varchar(255)", definition: "VARCHAR(255)" },
  { table: "customers", column: "phone", type: "varchar(15)", definition: "VARCHAR(15)" },
  { table: "customers", column: "id_proof_type", type: "varchar(30)", definition: "VARCHAR(30)" },
  { table: "customers", column: "id_proof_number", type: "varchar(100)", definition: "VARCHAR(100)" },
  {
    table: "customers",
    column: "created_at",
    type: "timestamp",
    definition: "TIMESTAMP",
    defaultSql: "DEFAULT CURRENT_TIMESTAMP",
  },
  {
    table: "accounts",
    column: "account_id",
    type: "bigint unsigned",
    definition: "BIGINT UNSIGNED",
    primaryKey: true,
  },
  {
    table: "accounts",
    column: "account_number",
    type: "char(10)",
    definition: "CHAR(10)",
    characterSet: "ascii",
    collation: "ascii_bin",
  },
  { table: "accounts", column: "customer_id", type: "bigint unsigned", definition: "BIGINT UNSIGNED" },
  { table: "accounts", column: "balance", type: "decimal(12,2)", definition: "DECIMAL(12,2)" },
  {
    table: "accounts",
    column: "created_at",
    type: "timestamp",
    definition: "TIMESTAMP",
    defaultSql: "DEFAULT CURRENT_TIMESTAMP",
  },
  {
    table: "staff_users",
    column: "user_id",
    type: "bigint unsigned",
    definition: "BIGINT UNSIGNED",
    primaryKey: true,
  },
  {
    table: "accounts",
    column: "status",
    type: "enum('active','inactive')",
    definition: "ENUM('ACTIVE', 'INACTIVE')",
    defaultValue: "ACTIVE",
  },
  { table: "transactions", column: "transaction_ref", type: "varchar(36)", definition: "VARCHAR(36)" },
  { table: "transactions", column: "account_id", type: "bigint unsigned", definition: "BIGINT UNSIGNED" },
  {
    table: "transactions",
    column: "transaction_type",
    type: "enum('deposit','withdrawal')",
    definition: "ENUM('DEPOSIT', 'WITHDRAWAL')",
  },
  { table: "transactions", column: "amount", type: "decimal(12,2)", definition: "DECIMAL(12,2)" },
  { table: "transactions", column: "balance_after", type: "decimal(12,2)", definition: "DECIMAL(12,2)" },
  {
    table: "transactions",
    column: "created_at",
    type: "timestamp",
    definition: "TIMESTAMP",
    defaultSql: "DEFAULT CURRENT_TIMESTAMP",
  },
  {
    table: "customer_users",
    column: "customer_id",
    type: "bigint unsigned",
    definition: "BIGINT UNSIGNED",
    primaryKey: true,
  },
  { table: "customer_users", column: "username", type: "varchar(64)", definition: "VARCHAR(64)" },
  { table: "customer_users", column: "password_hash", type: "varchar(255)", definition: "VARCHAR(255)" },
  {
    table: "transaction_idempotency",
    column: "user_id",
    type: "bigint unsigned",
    definition: "BIGINT UNSIGNED",
  },
  {
    table: "transaction_idempotency",
    column: "account_number",
    type: "char(10)",
    definition: "CHAR(10)",
    characterSet: "ascii",
    collation: "ascii_bin",
  },
  {
    table: "transaction_idempotency",
    column: "transaction_type",
    type: "enum('deposit','withdrawal')",
    definition: "ENUM('DEPOSIT', 'WITHDRAWAL')",
  },
  {
    table: "transaction_idempotency",
    column: "idempotency_key",
    type: "varchar(128)",
    definition: "VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin",
  },
  {
    table: "transaction_idempotency",
    column: "request_hash",
    type: "char(64)",
    definition: "CHAR(64) CHARACTER SET ascii COLLATE ascii_bin",
  },
];

const DATA_VALIDATIONS = [
  [
    "duplicate account numbers",
    `SELECT account_number
     FROM accounts
     GROUP BY account_number
     HAVING COUNT(*) > 1`,
  ],
  [
    "account numbers not exactly 10 ASCII digits",
    `SELECT account_id
     FROM accounts
     WHERE account_number IS NULL
        OR account_number NOT REGEXP '^[0-9]{10}$'`,
  ],
  [
    "customers with missing required values",
    `SELECT customer_id
     FROM customers
     WHERE full_name IS NULL
        OR address IS NULL
        OR phone IS NULL
        OR id_proof_type IS NULL
        OR id_proof_number IS NULL
        OR created_at IS NULL`,
  ],
  [
    "duplicate customer identity proofs",
    `SELECT id_proof_type, id_proof_number
     FROM customers
     GROUP BY id_proof_type, id_proof_number
     HAVING COUNT(*) > 1`,
  ],
  [
    "accounts with missing required values",
    `SELECT account_id
     FROM accounts
     WHERE account_number IS NULL
        OR customer_id IS NULL
        OR balance IS NULL
        OR status IS NULL
        OR created_at IS NULL`,
  ],
  [
    "accounts with invalid balances or statuses",
    `SELECT account_id
     FROM accounts
     WHERE balance < 0
        OR status NOT IN ('ACTIVE', 'INACTIVE')`,
  ],
  [
    "accounts referencing missing customers",
    `SELECT a.account_id
     FROM accounts a
     LEFT JOIN customers c ON c.customer_id = a.customer_id
     WHERE a.customer_id IS NOT NULL
       AND c.customer_id IS NULL`,
  ],
  [
    "transactions with missing required values",
    `SELECT transaction_id
     FROM transactions
     WHERE transaction_ref IS NULL
        OR account_id IS NULL
        OR transaction_type IS NULL
        OR amount IS NULL
        OR balance_after IS NULL
        OR created_at IS NULL`,
  ],
  [
    "duplicate transaction references",
    `SELECT transaction_ref
     FROM transactions
     GROUP BY transaction_ref
     HAVING COUNT(*) > 1`,
  ],
  [
    "transactions with invalid amounts, types, or balances",
    `SELECT transaction_id
     FROM transactions
     WHERE transaction_type NOT IN ('DEPOSIT', 'WITHDRAWAL')
        OR amount <= 0
        OR balance_after < 0`,
  ],
  [
    "transactions referencing missing accounts",
    `SELECT t.transaction_id
     FROM transactions t
     LEFT JOIN accounts a ON a.account_id = t.account_id
     WHERE t.account_id IS NOT NULL
       AND a.account_id IS NULL`,
  ],
  [
    "customer credentials with missing required values",
    `SELECT customer_id
     FROM customer_users
     WHERE customer_id IS NULL
        OR username IS NULL
        OR password_hash IS NULL`,
  ],
  [
    "customer credentials referencing missing customers",
    `SELECT u.customer_id
     FROM customer_users u
     LEFT JOIN customers c ON c.customer_id = u.customer_id
     WHERE u.customer_id IS NOT NULL
       AND c.customer_id IS NULL`,
  ],
  [
    "idempotency records with missing required values",
    `SELECT idempotency_id
     FROM transaction_idempotency
     WHERE user_id IS NULL
        OR account_number IS NULL
        OR transaction_type IS NULL
        OR idempotency_key IS NULL
        OR request_hash IS NULL`,
  ],
  [
    "idempotency records with invalid account numbers or transaction types",
    `SELECT idempotency_id
     FROM transaction_idempotency
     WHERE account_number NOT REGEXP '^[0-9]{10}$'
        OR transaction_type NOT IN ('DEPOSIT', 'WITHDRAWAL')`,
  ],
  [
    "idempotency records referencing missing staff users",
    `SELECT i.idempotency_id
     FROM transaction_idempotency i
     LEFT JOIN staff_users s ON s.user_id = i.user_id
     WHERE i.user_id IS NOT NULL
       AND s.user_id IS NULL`,
  ],
  [
    "idempotency records referencing missing accounts",
    `SELECT i.idempotency_id
     FROM transaction_idempotency i
     LEFT JOIN accounts a ON a.account_number = i.account_number
     WHERE i.account_number IS NOT NULL
       AND a.account_number IS NULL`,
  ],
];

const UNIQUE_INDEXES = {
  uq_customer_id_proof: ["id_proof_type", "id_proof_number"],
  uq_account_number: ["account_number"],
  uq_transaction_ref: ["transaction_ref"],
};

const FOREIGN_KEYS = {
  fk_accounts_customer: {
    column: "customer_id",
    referencedTable: "customers",
    referencedColumn: "customer_id",
  },
  fk_transactions_account: {
    column: "account_id",
    referencedTable: "accounts",
    referencedColumn: "account_id",
  },
  fk_customer_users_customer: {
    column: "customer_id",
    referencedTable: "customers",
    referencedColumn: "customer_id",
  },
  fk_transaction_idempotency_user: {
    column: "user_id",
    referencedTable: "staff_users",
    referencedColumn: "user_id",
  },
  fk_transaction_idempotency_account: {
    column: "account_number",
    referencedTable: "accounts",
    referencedColumn: "account_number",
  },
};

const CHECK_CONSTRAINTS = {
  chk_account_number_digits: [
    "account_numberregexp'^[0-9]{10}$'",
    "regexp_likeaccount_number,'^[0-9]{10}$'",
  ],
  chk_account_balance_nonnegative: ["balance>=0"],
  chk_account_status: ["statusin'active','inactive'"],
  chk_transaction_type: ["transaction_typein'deposit','withdrawal'"],
  chk_transaction_amount: ["amount>0"],
  chk_transaction_balance_after_nonnegative: ["balance_after>=0"],
};

function migrationError(message, code = "MIGRATION_FAILED") {
  const error = new Error(message);
  error.code = code;
  error.safeMessage = true;
  return error;
}

function splitStatements(sql) {
  return sql
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function readMigrations(migrationsDirectory = MIGRATIONS_DIRECTORY) {
  const fileNames = await fs.readdir(migrationsDirectory);
  const migrationNames = fileNames.filter((fileName) => /^\d{3,}_[a-z0-9_]+\.sql$/i.test(fileName));
  const migrations = await Promise.all(migrationNames.map(async (fileName) => {
    const match = /^(\d{3,})_(.+)\.sql$/i.exec(fileName);
    const contents = await fs.readFile(path.join(migrationsDirectory, fileName), "utf8");
    return {
      version: match[1],
      name: match[2],
      fileName,
      checksum: crypto.createHash("sha256").update(contents).digest("hex"),
      statements: splitStatements(contents),
    };
  }));
  migrations.sort((left, right) => Number(left.version) - Number(right.version));
  for (let index = 1; index < migrations.length; index += 1) {
    if (migrations[index - 1].version === migrations[index].version) {
      throw migrationError(`Duplicate migration version ${migrations[index].version}.`);
    }
  }
  return migrations;
}

async function assertSupportedMySQL(connection) {
  const [rows] = await connection.execute("SELECT VERSION() AS version");
  const version = rows[0]?.version;
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version || ""));
  if (!match || /mariadb/i.test(String(version))) {
    throw migrationError("Database migrations require MySQL 8.0.16 or later.");
  }
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major < 8 || (major === 8 && (minor === 0 && patch < 16))) {
    throw migrationError("Database migrations require MySQL 8.0.16 or later for enforced CHECK constraints.");
  }
}

function validateDatabaseColumns(columnRows) {
  const columns = new Map(columnRows.map((row) => [
    `${row.tableName}.${row.columnName}`,
    row,
  ]));
  const missingColumns = REQUIRED_COLUMNS
    .filter(({ table, column }) => !columns.has(`${table}.${column}`))
    .map(({ table, column }) => `${table}.${column}`);
  if (missingColumns.length) {
    throw migrationError(
      `The banking schema is missing required columns: ${missingColumns.join(", ")}. ` +
      "Restore the expected table definitions before applying migration 005."
    );
  }

  const incompatibleTypes = REQUIRED_COLUMNS
    .filter(({ table, column, type }) => {
      const actual = columns.get(`${table}.${column}`).columnType;
      return String(actual).toLowerCase() !== type;
    })
    .map(({ table, column, type }) =>
      `${table}.${column} (expected ${type}, found ${columns.get(`${table}.${column}`).columnType})`
    );
  if (incompatibleTypes.length) {
    throw migrationError(
      `The banking schema has incompatible column types: ${incompatibleTypes.join(", ")}. ` +
      "No schema changes were applied; reconcile the schema manually and rerun migrations."
    );
  }
  const missingPrimaryKeys = REQUIRED_COLUMNS
    .filter(({ table, column, primaryKey }) =>
      primaryKey && columns.get(`${table}.${column}`).columnKey !== "PRI"
    )
    .map(({ table, column }) => `${table}.${column}`);
  if (missingPrimaryKeys.length) {
    throw migrationError(
      `The banking schema is missing expected primary keys: ${missingPrimaryKeys.join(", ")}. ` +
      "Restore the expected table definitions before applying migration 005."
    );
  }
  return columns;
}

async function validateConstraintPrerequisites(connection) {
  const tableNames = CORE_TABLES.map((table) => `'${table}'`).join(", ");
  const [tableRows] = await connection.execute(
    `SELECT TABLE_NAME AS tableName, ENGINE AS engine
     FROM INFORMATION_SCHEMA.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN (${tableNames})`
  );
  const engines = new Map(tableRows.map((row) => [row.tableName, row.engine]));
  const missingTables = CORE_TABLES.filter((table) => !engines.has(table));
  if (missingTables.length) {
    throw migrationError(
      `Migration 005 requires these tables: ${missingTables.join(", ")}. ` +
      "Run the earlier migrations and verify the configured database."
    );
  }
  const nonInnoDbTables = CORE_TABLES.filter((table) => engines.get(table) !== "InnoDB");
  if (nonInnoDbTables.length) {
    throw migrationError(
      `Migration 005 requires InnoDB tables: ${nonInnoDbTables.join(", ")}. ` +
      "Convert these tables with an approved maintenance plan before rerunning."
    );
  }

  const [columnRows] = await connection.execute(
    `SELECT TABLE_NAME AS tableName,
            COLUMN_NAME AS columnName,
            COLUMN_TYPE AS columnType,
            COLUMN_KEY AS columnKey,
            IS_NULLABLE AS isNullable,
            CHARACTER_SET_NAME AS characterSetName,
            COLLATION_NAME AS collationName
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN (${tableNames})`
  );
  const columns = validateDatabaseColumns(columnRows);

  const incompatibleForeignKeys = [
    [["accounts", "customer_id"], ["customers", "customer_id"]],
    [["transactions", "account_id"], ["accounts", "account_id"]],
    [["customer_users", "customer_id"], ["customers", "customer_id"]],
    [["transaction_idempotency", "user_id"], ["staff_users", "user_id"]],
    [["transaction_idempotency", "account_number"], ["accounts", "account_number"]],
  ].filter(([[sourceTable, sourceColumn], [targetTable, targetColumn]]) => {
    const source = columns.get(`${sourceTable}.${sourceColumn}`);
    const target = columns.get(`${targetTable}.${targetColumn}`);
    const accountNumberCharsetMigration =
      sourceTable === "transaction_idempotency" &&
      sourceColumn === "account_number" &&
      targetTable === "accounts" &&
      targetColumn === "account_number" &&
      String(source.characterSetName || "") === "ascii" &&
      String(source.collationName || "") === "ascii_bin";
    return String(source.columnType).toLowerCase() !== String(target.columnType).toLowerCase() ||
      (!accountNumberCharsetMigration && (
        String(source.characterSetName || "") !== String(target.characterSetName || "") ||
        String(source.collationName || "") !== String(target.collationName || "")
      ));
  }).map(([[sourceTable, sourceColumn], [targetTable, targetColumn]]) =>
    `${sourceTable}.${sourceColumn} -> ${targetTable}.${targetColumn}`
  );
  if (incompatibleForeignKeys.length) {
    throw migrationError(
      `Foreign-key columns have incompatible definitions: ${incompatibleForeignKeys.join(", ")}. ` +
      "No schema changes were applied; reconcile the column definitions before rerunning."
    );
  }

  return columns;
}

function requiredColumnAlterations(columns) {
  return REQUIRED_COLUMNS
    .filter((definition) => {
      const metadata = columns.get(`${definition.table}.${definition.column}`);
      return !definition.primaryKey && (metadata.isNullable === "YES" ||
        (definition.characterSet && metadata.characterSetName !== definition.characterSet) ||
        (definition.collation && metadata.collationName !== definition.collation));
    })
    .map((definition) => {
      const { table, column, definition: typeSql, defaultValue, defaultSql: defaultExpression } = definition;
      const metadata = columns.get(`${table}.${column}`);
      const characterSetName = definition.characterSet || metadata.characterSetName;
      const collationName = definition.collation || metadata.collationName;
      const characterSet = characterSetName
        ? ` CHARACTER SET ${characterSetName}`
        : "";
      const collation = collationName
        ? ` COLLATE ${collationName}`
        : "";
      const defaultClause = defaultExpression || (defaultValue === undefined
        ? ""
        : `DEFAULT '${defaultValue.replace(/'/g, "''")}'`);
      return {
        table,
        column,
        sql: `ALTER TABLE \`${table}\` MODIFY COLUMN \`${column}\` ${typeSql}${characterSet}${collation} NOT NULL${defaultClause ? ` ${defaultClause}` : ""}`,
      };
    });
}

async function validateExistingData(connection) {
  const issues = [];
  for (const [name, query] of DATA_VALIDATIONS) {
    const [rows] = await connection.execute(
      `SELECT ? AS checkName, COUNT(*) AS issueCount
       FROM (${query}) AS invalid_records`,
      [name]
    );
    const issueCount = Number(rows[0]?.issueCount || 0);
    if (issueCount > 0) issues.push(`${name}: ${issueCount} row(s)`);
  }
  if (issues.length) {
    throw migrationError(
      `Migration 005 found invalid existing data and stopped before applying banking constraints: ${issues.join("; ")}. ` +
      "Inspect and explicitly remediate the affected rows, then rerun npm run migrate. " +
      "No account, customer, or transaction data is changed automatically.",
      "MIGRATION_DATA_VALIDATION"
    );
  }
}

async function prepareConstraintsMigration(connection) {
  const columns = await validateConstraintPrerequisites(connection);
  await validateExistingData(connection);
  return requiredColumnAlterations(columns);
}

async function hasNamedConstraint(connection, table, name, kind) {
  if (kind === "index") {
    const [rows] = await connection.execute(
      `SELECT COLUMN_NAME AS columnName,
              SEQ_IN_INDEX AS sequenceInIndex,
              NON_UNIQUE AS nonUnique
       FROM INFORMATION_SCHEMA.STATISTICS
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = ?
         AND INDEX_NAME = ?
       ORDER BY SEQ_IN_INDEX`,
      [table, name]
    );
    if (!rows.length) return false;
    const expectedColumns = UNIQUE_INDEXES[name];
    const actualColumns = rows.map((row) => row.columnName);
    if (
      !expectedColumns ||
      rows.some((row) => Number(row.nonUnique) !== 0) ||
      actualColumns.length !== expectedColumns.length ||
      actualColumns.some((column, index) => column !== expectedColumns[index])
    ) {
      throw migrationError(`Index ${table}.${name} exists with an unexpected definition.`);
    }
    return true;
  }

  if (kind === "foreign key") {
    const [rows] = await connection.execute(
      `SELECT kcu.COLUMN_NAME AS columnName,
              kcu.REFERENCED_TABLE_NAME AS referencedTableName,
              kcu.REFERENCED_COLUMN_NAME AS referencedColumnName,
              rc.DELETE_RULE AS deleteRule,
              rc.UPDATE_RULE AS updateRule
       FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE kcu
       INNER JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS rc
         ON rc.CONSTRAINT_SCHEMA = kcu.CONSTRAINT_SCHEMA
        AND rc.TABLE_NAME = kcu.TABLE_NAME
        AND rc.CONSTRAINT_NAME = kcu.CONSTRAINT_NAME
       WHERE kcu.CONSTRAINT_SCHEMA = DATABASE()
         AND kcu.TABLE_NAME = ?
         AND kcu.CONSTRAINT_NAME = ?
         AND kcu.REFERENCED_TABLE_NAME IS NOT NULL`,
      [table, name]
    );
    if (!rows.length) return false;
    const expected = FOREIGN_KEYS[name];
    if (
      !expected ||
      rows.length !== 1 ||
      rows[0].columnName !== expected.column ||
      rows[0].referencedTableName !== expected.referencedTable ||
      rows[0].referencedColumnName !== expected.referencedColumn ||
      !["RESTRICT", "NO ACTION"].includes(rows[0].deleteRule) ||
      !["RESTRICT", "NO ACTION"].includes(rows[0].updateRule)
    ) {
      throw migrationError(`Foreign key ${table}.${name} exists with an unexpected definition.`);
    }
    return true;
  }

  const [rows] = await connection.execute(
    `SELECT tc.CONSTRAINT_TYPE AS constraintType,
            tc.ENFORCED AS enforced,
            cc.CHECK_CLAUSE AS checkClause
     FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS tc
     INNER JOIN INFORMATION_SCHEMA.CHECK_CONSTRAINTS cc
       ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA
      AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME
     WHERE tc.CONSTRAINT_SCHEMA = DATABASE()
       AND tc.TABLE_NAME = ?
       AND tc.CONSTRAINT_NAME = ?`,
    [table, name]
  );
  if (!rows.length) return false;
  const expectedClauses = CHECK_CONSTRAINTS[name];
  const normalizedClause = String(rows[0].checkClause || "")
    .toLowerCase()
    .replace(/`/g, "")
    .replace(/_cp\d+|_utf8mb4/g, "")
    .replace(/\s+/g, "")
    .replace(/[()]/g, "");
  if (
    kind !== "check" ||
    rows[0].constraintType !== "CHECK" ||
    rows[0].enforced !== "YES" ||
    !expectedClauses?.includes(normalizedClause)
  ) {
    throw migrationError(`Check constraint ${table}.${name} exists but is not the expected enforced rule.`);
  }
  return true;
}

function constraintFromStatement(statement) {
  const tableMatch = /^ALTER\s+TABLE\s+`?([a-z0-9_]+)`?\s+ADD\s+/i.exec(statement);
  if (!tableMatch) return null;
  const uniqueMatch = /^ALTER\s+TABLE\s+`?([a-z0-9_]+)`?\s+ADD\s+UNIQUE\s+(?:KEY|INDEX)\s+`?([a-z0-9_]+)`?/i.exec(statement);
  if (uniqueMatch) {
    return { table: uniqueMatch[1], name: uniqueMatch[2], kind: "index" };
  }
  const constraintMatch = /^ALTER\s+TABLE\s+`?([a-z0-9_]+)`?\s+ADD\s+CONSTRAINT\s+`?([a-z0-9_]+)`?\s+(FOREIGN\s+KEY|CHECK)\b/i.exec(statement);
  if (!constraintMatch) return null;
  return {
    table: constraintMatch[1],
    name: constraintMatch[2],
    kind: /^FOREIGN/i.test(constraintMatch[3]) ? "foreign key" : "check",
  };
}

async function applyMigrationStatement(connection, migration, statement) {
  const constraint = migration.version === "005" ? constraintFromStatement(statement) : null;
  if (constraint && await hasNamedConstraint(
    connection,
    constraint.table,
    constraint.name,
    constraint.kind
  )) {
    return false;
  }
  await connection.query(statement);
  return true;
}

async function readAppliedMigrations(connection) {
  const [rows] = await connection.execute(
    "SELECT version, name, checksum FROM schema_migrations ORDER BY version"
  );
  return new Map(rows.map((row) => [row.version, row]));
}

async function migrate({
  databasePool = pool,
  migrationsDirectory = MIGRATIONS_DIRECTORY,
  logger = console,
} = {}) {
  const migrations = await readMigrations(migrationsDirectory);
  const connection = await databasePool.getConnection();
  let lockAcquired = false;
  try {
    const [lockRows] = await connection.execute(
      "SELECT GET_LOCK(?, 30) AS acquired",
      [MIGRATION_LOCK_NAME]
    );
    if (Number(lockRows[0]?.acquired) !== 1) {
      throw migrationError("Could not acquire the database migration lock within 30 seconds.");
    }
    lockAcquired = true;
    await assertSupportedMySQL(connection);
    await connection.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         version VARCHAR(16) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
         name VARCHAR(255) NOT NULL,
         checksum CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
         applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY (version)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
    );

    let applied = await readAppliedMigrations(connection);
    for (const migration of migrations) {
      const recorded = applied.get(migration.version);
      if (recorded) {
        if (recorded.name !== migration.name || recorded.checksum !== migration.checksum) {
          throw migrationError(
            `Applied migration ${migration.version} (${recorded.name}) differs from ` +
            `${migration.name}; restore the applied migration file before continuing.`
          );
        }
        continue;
      }

      const requiredColumnChanges = migration.version === "005"
        ? await prepareConstraintsMigration(connection)
        : [];
      for (const alteration of requiredColumnChanges) {
        await connection.query(alteration.sql);
      }

      for (const statement of migration.statements) {
        await applyMigrationStatement(connection, migration, statement);
      }
      await connection.execute(
        `INSERT INTO schema_migrations (version, name, checksum)
         VALUES (?, ?, ?)`,
        [migration.version, migration.name, migration.checksum]
      );
      applied = await readAppliedMigrations(connection);
      logger.log(`Applied database migration ${migration.version}: ${migration.name}`);
    }
    logger.log("Application schema migrations are ready.");
  } finally {
    try {
      if (lockAcquired) {
        await connection.execute("SELECT RELEASE_LOCK(?) AS released", [MIGRATION_LOCK_NAME]);
      }
    } finally {
      connection.release();
    }
  }
}

async function getMigrationStatus({
  databasePool = pool,
  migrationsDirectory = MIGRATIONS_DIRECTORY,
} = {}) {
  const migrations = await readMigrations(migrationsDirectory);
  const connection = await databasePool.getConnection();
  try {
    const [tables] = await connection.execute(
      `SELECT TABLE_NAME AS tableName
       FROM INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME = 'schema_migrations'`
    );
    if (!tables.length) {
      return migrations.map((migration) => ({ ...migration, status: "pending" }));
    }
    const applied = await readAppliedMigrations(connection);
    return migrations.map((migration) => {
      const recorded = applied.get(migration.version);
      if (!recorded) return { ...migration, status: "pending" };
      return {
        ...migration,
        status: recorded.name === migration.name && recorded.checksum === migration.checksum
          ? "applied"
          : "changed",
        appliedAt: recorded.applied_at,
      };
    });
  } finally {
    connection.release();
  }
}

async function main() {
  if (process.argv.includes("--status")) {
    const migrations = await getMigrationStatus();
    for (const migration of migrations) {
      const appliedAt = migration.appliedAt ? ` (${migration.appliedAt})` : "";
      console.log(`${migration.status.padEnd(7)} ${migration.version} ${migration.name}${appliedAt}`);
    }
    if (migrations.some((migration) => migration.status === "changed")) {
      process.exitCode = 1;
    }
    return;
  }
  await migrate();
}

if (require.main === module) {
  main()
    .catch((error) => {
      if (error.safeMessage) {
        console.error("Application migration failed:", error.message);
      } else {
        console.error("Application migration failed:", error.code || "unknown database error");
        console.error("Database error details were withheld to protect stored data.");
      }
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}

module.exports = {
  REQUIRED_COLUMNS,
  getMigrationStatus,
  migrate,
  readMigrations,
  splitStatements,
  validateExistingData,
};

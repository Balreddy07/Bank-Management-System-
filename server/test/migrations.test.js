const assert = require("node:assert/strict");
const test = require("node:test");
const {
  REQUIRED_COLUMNS,
  getMigrationStatus,
  migrate,
  readMigrations,
  validateExistingData,
} = require("../src/scripts/migrate");

class MigrationPool {
  constructor({
    version = "8.0.46",
    issues = {},
    applied = [],
    ledgerExists = true,
    nullableColumns = [],
  } = {}) {
    this.version = version;
    this.issues = issues;
    this.applied = new Map(applied.map((migration) => [migration.version, migration]));
    this.ledgerExists = ledgerExists;
    this.nullableColumns = new Set(nullableColumns);
    this.statements = [];
    this.released = 0;
  }

  async getConnection() {
    return this;
  }

  async execute(sql, params = []) {
    if (sql.includes("GET_LOCK")) return [[{ acquired: 1 }]];
    if (sql.includes("SELECT RELEASE_LOCK")) return [[{ released: 1 }]];
    if (sql.includes("SELECT VERSION()")) return [[{ version: this.version }]];
    if (sql.includes("FROM schema_migrations")) {
      return [[...this.applied.values()].sort((left, right) =>
        left.version.localeCompare(right.version)
      )];
    }
    if (sql.includes("INFORMATION_SCHEMA.TABLES")) {
      if (sql.includes("schema_migrations")) {
        return [this.ledgerExists ? [{ tableName: "schema_migrations" }] : []];
      }
      return [[
        "accounts",
        "customers",
        "transactions",
        "customer_users",
        "transaction_idempotency",
        "staff_users",
      ].map((tableName) => ({ tableName, engine: "InnoDB" }))];
    }
    if (sql.includes("INFORMATION_SCHEMA.COLUMNS")) {
      return [[...REQUIRED_COLUMNS.map((column) => ({
        tableName: column.table,
        columnName: column.column,
        columnType: column.type,
        columnKey: column.primaryKey ? "PRI" : "",
        isNullable: this.nullableColumns.has(`${column.table}.${column.column}`) ? "YES" : "NO",
        characterSetName: column.characterSet ||
          (/^(char|varchar)/.test(column.type) ? "utf8mb4" : null),
        collationName: column.collation ||
          (/^(char|varchar)/.test(column.type) ? "utf8mb4_0900_ai_ci" : null),
      }))]];
    }
    if (sql.includes("AS checkName")) {
      return [[{ checkName: params[0], issueCount: this.issues[params[0]] || 0 }]];
    }
    if (sql.includes("INFORMATION_SCHEMA.KEY_COLUMN_USAGE")) return [[]];
    if (sql.includes("INFORMATION_SCHEMA.STATISTICS")) return [[]];
    if (sql.includes("INFORMATION_SCHEMA.TABLE_CONSTRAINTS")) return [[]];
    if (sql.includes("INSERT INTO schema_migrations")) {
      const [version, name, checksum] = params;
      this.applied.set(version, { version, name, checksum, applied_at: "2026-10-29 00:00:00" });
      return [{ affectedRows: 1 }];
    }
    throw new Error(`Unexpected migration test query: ${sql}`);
  }

  async query(sql) {
    this.statements.push(sql);
    return [{ affectedRows: 0 }];
  }

  release() {
    this.released += 1;
  }
}

test("migrations are ordered and recorded, and a second run is a no-op", async () => {
  const migrations = await readMigrations();
  const pool = new MigrationPool();
  const messages = [];
  const logger = { log: (message) => messages.push(message) };

  await migrate({ databasePool: pool, logger });
  const firstRunStatements = pool.statements.filter((statement) =>
    !statement.includes("schema_migrations")
  ).length;
  assert.deepEqual(
    [...pool.applied.keys()],
    migrations.map((migration) => migration.version)
  );
  assert.equal(pool.released, 1);
  assert.equal(messages.filter((message) => message.startsWith("Applied")).length, migrations.length);

  await migrate({ databasePool: pool, logger });
  assert.equal(
    pool.statements.filter((statement) => !statement.includes("schema_migrations")).length,
    firstRunStatements
  );
  assert.equal(pool.released, 2);
});

test("fresh and upgrade schemas define the required banking constraints", async () => {
  const migrations = await readMigrations();
  const baseline = migrations.find((migration) => migration.version === "000").statements.join("\n");
  const upgrade = migrations.find((migration) => migration.version === "005").statements.join("\n");

  assert.match(baseline, /account_number CHAR\(10\) CHARACTER SET ascii COLLATE ascii_bin NOT NULL/);
  assert.match(baseline, /UNIQUE KEY uq_account_number/);
  assert.match(baseline, /CHECK \(account_number REGEXP '\^\[0-9\]\{10\}\$'\)/);
  assert.match(baseline, /FOREIGN KEY \(customer_id\) REFERENCES customers/);
  assert.match(baseline, /CHECK \(balance >= 0\)/);
  assert.match(baseline, /transaction_type ENUM\('DEPOSIT', 'WITHDRAWAL'\) NOT NULL/);
  assert.match(baseline, /CHECK \(amount > 0\)/);
  assert.match(baseline, /CHECK \(balance_after >= 0\)/);

  assert.match(upgrade, /ADD UNIQUE KEY uq_account_number/);
  assert.match(upgrade, /FOREIGN KEY \(account_id\) REFERENCES accounts/);
  assert.match(upgrade, /FOREIGN KEY \(customer_id\) REFERENCES customers/);
  assert.match(upgrade, /FOREIGN KEY \(user_id\) REFERENCES staff_users/);
});

test("constraint preflight stops before migration 005 when existing data is invalid", async () => {
  const pool = new MigrationPool({
    issues: { "account numbers not exactly 10 ASCII digits": 2 },
  });

  await assert.rejects(
    migrate({ databasePool: pool, logger: { log() {} } }),
    /Migration 005 found invalid existing data.*account numbers not exactly 10 ASCII digits: 2 row\(s\)/
  );
  assert.equal(pool.applied.has("005"), false);
  assert.equal(pool.statements.some((statement) => statement.startsWith("ALTER TABLE")), false);
  assert.equal(pool.released, 1);
});

test("required nullable columns are made NOT NULL only after data validation", async () => {
  const pool = new MigrationPool({
    nullableColumns: ["accounts.account_number", "customers.full_name", "customers.created_at"],
  });

  await migrate({ databasePool: pool, logger: { log() {} } });

  assert.ok(pool.statements.includes(
    "ALTER TABLE `accounts` MODIFY COLUMN `account_number` CHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL"
  ));
  assert.ok(pool.statements.includes(
    "ALTER TABLE `customers` MODIFY COLUMN `full_name` VARCHAR(100) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci NOT NULL"
  ));
  assert.ok(pool.statements.includes(
    "ALTER TABLE `customers` MODIFY COLUMN `created_at` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP"
  ));
});

test("constraint preflight diagnoses duplicate references, orphans, nulls, and invalid amounts", async () => {
  const issues = {
    "duplicate account numbers": 1,
    "account numbers not exactly 10 ASCII digits": 1,
    "accounts with missing required values": 1,
    "accounts with invalid balances or statuses": 1,
    "accounts referencing missing customers": 1,
    "transactions with missing required values": 1,
    "duplicate transaction references": 1,
    "transactions with invalid amounts, types, or balances": 1,
    "transactions referencing missing accounts": 1,
    "customer credentials referencing missing customers": 1,
    "idempotency records with invalid account numbers or transaction types": 1,
    "idempotency records referencing missing staff users": 1,
    "idempotency records referencing missing accounts": 1,
  };
  await assert.rejects(
    validateExistingData({
      async execute(sql, params) {
        assert.match(sql, /COUNT\(\*\)/);
        return [[{ issueCount: issues[params[0]] || 0 }]];
      },
    }),
    /duplicate account numbers: 1 row\(s\).*account numbers not exactly 10 ASCII digits: 1 row\(s\).*accounts referencing missing customers: 1 row\(s\).*duplicate transaction references: 1 row\(s\).*invalid amounts, types, or balances/
  );
});

test("unsupported MySQL versions are rejected before schema changes", async () => {
  const pool = new MigrationPool({ version: "8.0.15" });

  await assert.rejects(
    migrate({ databasePool: pool, logger: { log() {} } }),
    /require MySQL 8\.0\.16 or later/
  );
  assert.equal(pool.statements.length, 0);
  assert.equal(pool.released, 1);
});

test("migration status marks unapplied versions as pending without creating a ledger", async () => {
  const migrations = await readMigrations();
  const pool = {
    async getConnection() {
      return {
        async execute() {
          return [[]];
        },
        release() {},
      };
    },
  };

  const status = await getMigrationStatus({ databasePool: pool });
  assert.deepEqual(status.map((migration) => migration.version), migrations.map((migration) => migration.version));
  assert.ok(status.every((migration) => migration.status === "pending"));
});

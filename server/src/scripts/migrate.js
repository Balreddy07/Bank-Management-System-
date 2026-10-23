require("dotenv").config();

const fs = require("node:fs/promises");
const path = require("node:path");
const pool = require("../db");

async function migrate() {
  const migrationPath = path.join(__dirname, "../../migrations/001_create_staff_users.sql");
  const migration = await fs.readFile(migrationPath, "utf8");
  const statements = migration.split(/;\s*(?:\r?\n|$)/).map((statement) => statement.trim()).filter(Boolean);
  for (const statement of statements) {
    await pool.query(statement);
  }
  const [statusColumns] = await pool.execute(
    `SELECT COLUMN_TYPE AS columnType
     FROM INFORMATION_SCHEMA.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME = 'accounts'
       AND COLUMN_NAME = 'status'`
  );
  if (!statusColumns.length) throw new Error("Could not verify the existing accounts.status column.");
  console.log(`Existing accounts.status type: ${statusColumns[0].columnType}`);
  console.log("Authentication schema is ready.");
}

migrate()
  .catch((error) => {
    console.error("Authentication migration failed:", error.code || "unknown error");
    process.exitCode = 1;
  })
  .finally(() => pool.end());
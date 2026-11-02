
require("dotenv").config();

const bcrypt = require("bcrypt");
const pool = require("../db");

const USER_COUNT = Number(
  process.env.CONCURRENT_SESSIONS_CLIENTS || 100
);
const USER_PREFIX = "sessionload";
const PASSWORD = process.env.CONCURRENT_SESSIONS_PASSWORD;

async function main() {
  // Restrict this script to the dedicated local development database.
  if (
    process.env.NODE_ENV === "production" ||
    !["localhost", "127.0.0.1", "::1"].includes(
      (process.env.DB_HOST || "localhost").toLowerCase()
    ) ||
    process.env.DB_NAME !== "bank_management_dev"
  ) {
    throw new Error(
      "This setup script only permits the local bank_management_dev database."
    );
  }

  // Validate the requested number of test accounts.
  if (
    !Number.isSafeInteger(USER_COUNT) ||
    USER_COUNT < 1 ||
    USER_COUNT > 1000
  ) {
    throw new Error(
      "CONCURRENT_SESSIONS_CLIENTS must be between 1 and 1000."
    );
  }

  // bcrypt only uses up to 72 bytes of a password.
  if (
    !PASSWORD ||
    PASSWORD.length < 12 ||
    Buffer.byteLength(PASSWORD, "utf8") > 72
  ) {
    throw new Error(
      "Set a dedicated test password of 12-72 bytes in .env."
    );
  }

  const passwordHash = await bcrypt.hash(PASSWORD, 12);
  let created = 0;
  let existing = 0;

  for (let i = 1; i <= USER_COUNT; i += 1) {
    const username = `${USER_PREFIX}${String(i).padStart(4, "0")}`;

    const [rows] = await pool.execute(
      "SELECT user_id FROM staff_users WHERE username = ?",
      [username]
    );

    if (rows.length > 0) {
      existing += 1;
      continue;
    }

    await pool.execute(
      "INSERT INTO staff_users (username, password_hash, role) VALUES (?, ?, 'STAFF')",
      [username, passwordHash]
    );

    created += 1;
  }

  console.log(
    `Session test accounts ready. Created: ${created}; already existed: ${existing}; requested: ${USER_COUNT}.`
  );
}

main()
  .catch((error) => {
    console.error(
      "Session test-account setup failed:",
      error.code || error.message
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });

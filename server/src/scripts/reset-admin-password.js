const bcrypt = require("bcrypt");

const BCRYPT_COST = 12;
const USERNAME_PATTERN = /^[a-z0-9._-]{3,64}$/;
const SAFE_ERROR_MESSAGES = new Set([
  "Enter the existing administrator username in a valid format.",
  "The new password must be at least 12 characters and no more than 72 UTF-8 bytes.",
  "No single active administrator matches the confirmed username.",
  "The intended active administrator was not updated exactly once.",
  "Run this recovery command from a local interactive terminal.",
  "Password entry cancelled.",
  "Confirmation did not match; no database changes were made.",
  "The passwords did not match; no database changes were made.",
]);

function validateUsername(username) {
  if (typeof username !== "string" || !USERNAME_PATTERN.test(username)) {
    throw new Error("Enter the existing administrator username in a valid format.");
  }
}

function validatePassword(password) {
  if (
    typeof password !== "string"
    || password.length < 12
    || Buffer.byteLength(password, "utf8") > 72
  ) {
    throw new Error("The new password must be at least 12 characters and no more than 72 UTF-8 bytes.");
  }
}

async function resetAdminPassword({ databasePool, username, password, bcryptImpl = bcrypt }) {
  validateUsername(username);
  validatePassword(password);

  const connection = await databasePool.getConnection();
  let transactionStarted = false;
  try {
    await connection.beginTransaction();
    transactionStarted = true;

    const [rows] = await connection.execute(
      `SELECT user_id AS userId, role, is_active AS isActive
       FROM staff_users
       WHERE username = ?
       FOR UPDATE`,
      [username]
    );
    if (
      rows.length !== 1
      || rows[0].role !== "ADMIN"
      || Number(rows[0].isActive) !== 1
    ) {
      throw new Error("No single active administrator matches the confirmed username.");
    }

    const passwordHash = await bcryptImpl.hash(password, BCRYPT_COST);
    const [result] = await connection.execute(
      `UPDATE staff_users
       SET password_hash = ?, failed_login_attempts = 0, locked_until = NULL
       WHERE user_id = ? AND username = ? AND role = 'ADMIN' AND is_active = 1`,
      [passwordHash, rows[0].userId, username]
    );
    if (result.affectedRows !== 1) {
      throw new Error("The intended active administrator was not updated exactly once.");
    }

    await connection.commit();
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function readHidden(prompt, { input = process.stdin, output = process.stdout } = {}) {
  if (!input.isTTY || typeof input.setRawMode !== "function") {
    return Promise.reject(new Error("Run this recovery command from a local interactive terminal."));
  }

  return new Promise((resolve, reject) => {
    const wasRaw = input.isRaw;
    let value = "";
    let settled = false;
    output.write(prompt);

    const finish = (error) => {
      if (settled) return;
      settled = true;
      input.removeListener("data", onData);
      input.setRawMode(wasRaw);
      input.pause();
      output.write("\r\n");
      if (error) reject(error);
      else resolve(value);
    };

    const onData = (chunk) => {
      for (const character of chunk) {
        if (character === "\u0003") {
          finish(new Error("Password entry cancelled."));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u0008" || character === "\u007f") {
          value = Array.from(value).slice(0, -1).join("");
        } else if (character >= " ") {
          value += character;
        }
      }
    };

    input.setEncoding("utf8");
    input.setRawMode(true);
    input.resume();
    input.on("data", onData);
  });
}

async function main() {
  const readline = require("node:readline/promises");
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  let username;
  try {
    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
      throw new Error("Run this recovery command from a local interactive terminal.");
    }
    username = (await terminal.question("Existing administrator username: ")).trim().toLowerCase();
    validateUsername(username);
    const confirmation = await terminal.question(`Type RESET ${username} to continue: `);
    if (confirmation !== `RESET ${username}`) {
      throw new Error("Confirmation did not match; no database changes were made.");
    }
  } finally {
    terminal.close();
  }

  const password = await readHidden("New password (input hidden): ");
  const repeatedPassword = await readHidden("Re-enter new password (input hidden): ");
  validatePassword(password);
  if (password !== repeatedPassword) {
    throw new Error("The passwords did not match; no database changes were made.");
  }

  require("dotenv").config();
  const databasePool = require("../db");
  try {
    await resetAdminPassword({ databasePool, username, password });
    console.log(`Password reset for active administrator '${username}'.`);
  } finally {
    await databasePool.end();
  }
}

if (require.main === module) {
  main().catch((error) => {
    const safeReason = SAFE_ERROR_MESSAGES.has(error.message)
      ? error.message
      : error.code || "unexpected error";
    console.error("Administrator password recovery failed:", safeReason);
    process.exitCode = 1;
  });
}

module.exports = { resetAdminPassword, validatePassword, validateUsername, readHidden };

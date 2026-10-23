require("dotenv").config();

const bcrypt = require("bcrypt");
const pool = require("../db");

async function initializeAdmin() {
  const username = process.env.INITIAL_ADMIN_USERNAME?.trim().toLowerCase();
  const password = process.env.INITIAL_ADMIN_PASSWORD;
  if (!username || !/^[a-z0-9._-]{3,64}$/.test(username) || !password || password.length < 12 || Buffer.byteLength(password, "utf8") > 72) {
    throw new Error("Set valid INITIAL_ADMIN_USERNAME and INITIAL_ADMIN_PASSWORD values in the environment.");
  }

  const connection = await pool.getConnection();
  const [lockRows] = await connection.execute("SELECT GET_LOCK(?, 10) AS acquired", ["securebank-initial-admin"]);
  if (Number(lockRows[0].acquired) !== 1) {
    connection.release();
    throw new Error("Could not acquire the one-time initialization lock.");
  }

  try {
    const [admins] = await connection.execute(
      "SELECT user_id FROM staff_users WHERE role = 'ADMIN' LIMIT 1"
    );
    if (admins.length) throw new Error("An administrator already exists; initialization is one-time.");

    const passwordHash = await bcrypt.hash(password, 12);
    await connection.execute(
      "INSERT INTO staff_users (username, password_hash, role) VALUES (?, ?, 'ADMIN')",
      [username, passwordHash]
    );
    console.log(`Initial administrator '${username}' created.`);
  } finally {
    await connection.execute("SELECT RELEASE_LOCK(?)", ["securebank-initial-admin"]);
    connection.release();
  }
}

initializeAdmin()
  .catch((error) => {
    console.error("Administrator initialization failed:", error.code || error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
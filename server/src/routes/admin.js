const bcrypt = require("bcrypt");
const express = require("express");
const { createDeactivateAccountHandler } = require("./accounts");

const USERNAME_PATTERN = /^[a-zA-Z0-9._-]{3,64}$/;

function createAdminRouter({ databasePool }) {
  const router = express.Router();

  router.get("/staff", async (req, res) => {
    try {
      const [staff] = await databasePool.execute(
        `SELECT user_id AS userId, username, role, is_active AS isActive,
                failed_login_attempts AS failedLoginAttempts, locked_until AS lockedUntil,
                created_at AS createdAt
         FROM staff_users
         ORDER BY username`
      );
      return res.status(200).json({ staff });
    } catch (error) {
      console.error("Staff listing failed:", error.code || "unknown error");
      return res.status(500).json({ message: "Unable to retrieve staff accounts." });
    }
  });

  router.post("/staff", async (req, res) => {
    const username = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    const role = req.body?.role;
    if (!USERNAME_PATTERN.test(username) || password.length < 12 || Buffer.byteLength(password, "utf8") > 72 || !["ADMIN", "STAFF"].includes(role)) {
      return res.status(400).json({ message: "Provide a valid username, a password of at least 12 characters and at most 72 bytes, and an allowed role." });
    }

    try {
      const passwordHash = await bcrypt.hash(password, 12);
      await databasePool.execute(
        "INSERT INTO staff_users (username, password_hash, role) VALUES (?, ?, ?)",
        [username, passwordHash, role]
      );
      return res.status(201).json({ message: "Staff account created.", staff: { username, role } });
    } catch (error) {
      if (error.code === "ER_DUP_ENTRY") return res.status(409).json({ message: "That username is already in use." });
      console.error("Staff account creation failed:", error.code || "unknown error");
      return res.status(500).json({ message: "Unable to create the staff account." });
    }
  });

  router.patch("/staff/:userId/role", async (req, res) => {
    const userId = Number(req.params.userId);
    const { role } = req.body || {};
    if (!Number.isSafeInteger(userId) || userId < 1 || !["ADMIN", "STAFF"].includes(role)) {
      return res.status(400).json({ message: "Provide a valid staff account and role." });
    }
    if (String(req.user.userId) === String(userId) && role !== "ADMIN") {
      return res.status(409).json({ message: "You cannot remove your own administrator role." });
    }

    let connection;
    let transactionStarted = false;
    try {
      connection = await databasePool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const [staffRows] = await connection.execute(
        "SELECT user_id AS userId, role, is_active AS isActive FROM staff_users WHERE user_id = ? FOR UPDATE",
        [userId]
      );
      if (!staffRows.length) {
        await connection.rollback();
        transactionStarted = false;
        return res.status(404).json({ message: "Staff account not found." });
      }
      if (staffRows[0].role === "ADMIN" && staffRows[0].isActive && role !== "ADMIN") {
        const [admins] = await connection.execute(
          "SELECT user_id FROM staff_users WHERE role = 'ADMIN' AND is_active = 1 FOR UPDATE"
        );
        if (admins.length <= 1) {
          await connection.rollback();
          transactionStarted = false;
          return res.status(409).json({ message: "The last active administrator cannot be demoted." });
        }
      }
      await connection.execute("UPDATE staff_users SET role = ? WHERE user_id = ?", [role, userId]);
      await connection.commit();
      transactionStarted = false;
      return res.status(200).json({ message: "Staff role updated.", userId, role });
    } catch (error) {
      if (connection && transactionStarted) await connection.rollback();
      console.error("Staff role update failed:", error.code || "unknown error");
      return res.status(500).json({ message: "Unable to update the staff role." });
    } finally {
      connection?.release();
    }
  });

  router.patch("/accounts/:accountNumber/deactivate", createDeactivateAccountHandler(databasePool));

  return router;
}

module.exports = { createAdminRouter };
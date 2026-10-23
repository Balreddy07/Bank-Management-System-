const bcrypt = require("bcrypt");
const express = require("express");
const { promisify } = require("node:util");

const FAILED_LOGIN_LIMIT = 3;
const DUMMY_HASH_PROMISE = bcrypt.hash("securebank-invalid-login-dummy", 12);
const GENERIC_LOGIN_FAILURE = "Invalid username or password, or account temporarily unavailable.";

function safeUser(row) {
  return { userId: row.userId ?? row.user_id, username: row.username, role: row.role };
}

function safeCustomerUser(row) {
  return {
    userId: row.customerId ?? row.customer_id,
    customerId: row.customerId ?? row.customer_id,
    username: row.username,
    role: "CUSTOMER",
  };
}

function createAuthRouter({
  databasePool,
  loginLimiter = (req, res, next) => next(),
  secureCookie = false,
  sameSite = "lax",
}) {
  const router = express.Router();

  router.post("/login", loginLimiter, async (req, res) => {
    const username = typeof req.body?.username === "string" ? req.body.username.trim().toLowerCase() : "";
    const password = typeof req.body?.password === "string" ? req.body.password : "";
    if (!/^[a-z0-9._-]{3,64}$/.test(username) || password.length < 1 || Buffer.byteLength(password, "utf8") > 72) {
      if (password.length <= 128) await bcrypt.compare(password || "invalid", await DUMMY_HASH_PROMISE);
      return res.status(401).json({ message: GENERIC_LOGIN_FAILURE });
    }

    let connection;
    let transactionStarted = false;
    try {
      connection = await databasePool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const [rows] = await connection.execute(
        `SELECT user_id AS userId, username, password_hash AS passwordHash,
                role, failed_login_attempts AS failedLoginAttempts,
                locked_until AS lockedUntil, is_active AS isActive,
                (locked_until IS NOT NULL AND locked_until > CURRENT_TIMESTAMP) AS lockActive,
                (locked_until IS NOT NULL AND locked_until <= CURRENT_TIMESTAMP) AS lockExpired
         FROM staff_users
         WHERE username = ?
         FOR UPDATE`,
        [username]
      );

      if (!rows.length) {
        const [customerRows] = await connection.execute(
          `SELECT customer_id AS customerId, username, password_hash AS passwordHash,
                  failed_login_attempts AS failedLoginAttempts, locked_until AS lockedUntil,
                  is_active AS isActive,
                  (locked_until IS NOT NULL AND locked_until > CURRENT_TIMESTAMP) AS lockActive,
                  (locked_until IS NOT NULL AND locked_until <= CURRENT_TIMESTAMP) AS lockExpired
           FROM customer_users
           WHERE username = ?
           FOR UPDATE`,
          [username]
        );
        if (!customerRows.length) {
          await connection.rollback();
          transactionStarted = false;
          await bcrypt.compare(password, await DUMMY_HASH_PROMISE);
          return res.status(401).json({ message: GENERIC_LOGIN_FAILURE });
        }

        const customer = customerRows[0];
        if (Number(customer.lockActive) === 1 || Number(customer.isActive) !== 1) {
          await connection.rollback();
          transactionStarted = false;
          await bcrypt.compare(password, customer.passwordHash);
          return res.status(401).json({ message: GENERIC_LOGIN_FAILURE });
        }

        const attempts = Number(customer.lockExpired) === 1
          ? 0
          : Number(customer.failedLoginAttempts || 0);
        if (!await bcrypt.compare(password, customer.passwordHash)) {
          const nextAttempts = attempts + 1;
          await connection.execute(
            `UPDATE customer_users
             SET failed_login_attempts = ?,
             locked_until = CASE WHEN ? >= ? THEN DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 15 MINUTE) ELSE NULL END
             WHERE customer_id = ?`,
            [nextAttempts, nextAttempts, FAILED_LOGIN_LIMIT, customer.customerId]
          );
          await connection.commit();
          transactionStarted = false;
          return res.status(401).json({ message: GENERIC_LOGIN_FAILURE });
        }

        await connection.execute(
          "UPDATE customer_users SET failed_login_attempts = 0, locked_until = NULL WHERE customer_id = ?",
          [customer.customerId]
        );
        await connection.commit();
        transactionStarted = false;

        await promisify(req.session.regenerate).call(req.session);
        req.session.userId = customer.customerId;
        req.session.customerId = customer.customerId;
        req.session.userType = "CUSTOMER";
        await promisify(req.session.save).call(req.session);
        return res.status(200).json({ user: safeCustomerUser(customer) });
      }

      const user = rows[0];
      if (Number(user.lockActive) === 1 || Number(user.isActive) !== 1) {
        await connection.rollback();
        transactionStarted = false;
        await bcrypt.compare(password, user.passwordHash);
        return res.status(401).json({ message: GENERIC_LOGIN_FAILURE });
      }

      const attempts = Number(user.lockExpired) === 1 ? 0 : Number(user.failedLoginAttempts || 0);
      const passwordMatches = await bcrypt.compare(password, user.passwordHash);
      if (!passwordMatches) {
        const nextAttempts = attempts + 1;
        await connection.execute(
          `UPDATE staff_users
           SET failed_login_attempts = ?,
           locked_until = CASE WHEN ? >= ? THEN DATE_ADD(CURRENT_TIMESTAMP, INTERVAL 15 MINUTE) ELSE NULL END
           WHERE user_id = ?`,
          [nextAttempts, nextAttempts, FAILED_LOGIN_LIMIT, user.userId]
        );
        await connection.commit();
        transactionStarted = false;
        return res.status(401).json({ message: GENERIC_LOGIN_FAILURE });
      }

      await connection.execute(
        "UPDATE staff_users SET failed_login_attempts = 0, locked_until = NULL WHERE user_id = ?",
        [user.userId]
      );
      await connection.commit();
      transactionStarted = false;

      await promisify(req.session.regenerate).call(req.session);
      req.session.userId = user.userId;
      req.session.userType = "STAFF";
      await promisify(req.session.save).call(req.session);
      return res.status(200).json({ user: safeUser(user) });
    } catch (error) {
      if (connection && transactionStarted) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          console.error("Login rollback failed:", rollbackError.code || "unknown error");
        }
      }
      console.error("Login request failed:", error.code || "unknown error");
      return res.status(503).json({ message: "Login is temporarily unavailable. Try again." });
    } finally {
      connection?.release();
    }
  });

  router.get("/session", async (req, res) => {
    if (!req.session?.userId) {
      const hasSessionCookie = (req.get("cookie") || "")
        .split(";")
        .some((cookie) => cookie.trim().startsWith("securebank.sid="));
      if (hasSessionCookie) {
        res.clearCookie("securebank.sid", {
          httpOnly: true,
          sameSite,
          secure: secureCookie,
          path: "/",
        });
      }
      return res.status(200).json({ user: null, sessionExpired: hasSessionCookie });
    }
    try {
      const isCustomer = req.session.userType === "CUSTOMER";
      const [rows] = isCustomer
        ? await databasePool.execute(
          `SELECT customer_id AS customerId, username
           FROM customer_users
           WHERE customer_id = ? AND is_active = 1`,
          [req.session.customerId]
        )
        : await databasePool.execute(
          `SELECT user_id AS userId, username, role
           FROM staff_users
           WHERE user_id = ? AND is_active = 1`,
          [req.session.userId]
        );
      if (!rows.length) {
        await promisify(req.session.destroy).call(req.session);
        res.clearCookie("securebank.sid", {
          httpOnly: true,
          sameSite,
          secure: secureCookie,
          path: "/",
        });
        return res.status(200).json({ user: null });
      }
      return res.status(200).json({
        user: isCustomer ? safeCustomerUser(rows[0]) : safeUser(rows[0]),
      });
    } catch (error) {
      console.error("Session check failed:", error.code || "unknown error");
      return res.status(503).json({ message: "Unable to check the current session." });
    }
  });

  router.post("/logout", async (req, res) => {
    if (!req.session) return res.status(200).json({ message: "Signed out." });
    try {
      await promisify(req.session.destroy).call(req.session);
      res.clearCookie("securebank.sid", {
        httpOnly: true,
        sameSite,
        secure: secureCookie,
        path: "/",
      });
      return res.status(200).json({ message: "Signed out." });
    } catch (error) {
      console.error("Logout failed:", error.code || "unknown error");
      return res.status(503).json({ message: "Unable to sign out. Try again." });
    }
  });

  return router;
}

module.exports = { createAuthRouter, GENERIC_LOGIN_FAILURE };
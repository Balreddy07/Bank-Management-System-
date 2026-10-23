
const express = require("express");
const { randomInt, randomUUID } = require("node:crypto");
const { requireRole } = require("../auth/middleware");
const pool = require("../db");

function generateAccountNumber() {
  // Always generates exactly 10 numeric digits.
  return String(randomInt(1_000_000_000, 10_000_000_000));
}

function createDeactivateAccountHandler(databasePool) {
  return async (req, res) => {
    const { accountNumber } = req.params;
    if (!/^\d{10}$/.test(accountNumber) || req.body?.confirm !== true) {
      return res.status(400).json({ message: "Provide a valid account number and explicit confirmation." });
    }

    let connection;
    let transactionStarted = false;
    try {
      connection = await databasePool.getConnection();
      await connection.beginTransaction();
      transactionStarted = true;
      const [accounts] = await connection.execute(
        "SELECT account_id, status FROM accounts WHERE account_number = ? FOR UPDATE",
        [accountNumber]
      );
      if (!accounts.length) {
        await connection.rollback();
        transactionStarted = false;
        return res.status(404).json({ message: "Account not found." });
      }
      if (accounts[0].status !== "ACTIVE") {
        await connection.rollback();
        transactionStarted = false;
        return res.status(409).json({ message: "Account is already inactive." });
      }
      await connection.execute("UPDATE accounts SET status = 'INACTIVE' WHERE account_id = ?", [accounts[0].account_id]);
      await connection.commit();
      transactionStarted = false;
      return res.status(200).json({ message: "Account deactivated.", accountNumber, status: "INACTIVE" });
    } catch (error) {
      if (connection && transactionStarted) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          console.error("Account deactivation rollback failed:", rollbackError.code || "unknown error");
        }
      }
      console.error("Account deactivation failed:", error.code || "unknown error");
      return res.status(500).json({ message: "Unable to deactivate the account." });
    } finally {
      connection?.release();
    }
  };
}

function createAccountRouter(databasePool = pool) {
  const router = express.Router();

  router.get("/:accountNumber", async (req, res) => {
    const { accountNumber } = req.params;
    if (!/^\d{10}$/.test(accountNumber)) {
      return res.status(400).json({ message: "Enter a valid 10-digit account number." });
    }

    try {
      const [accounts] = await databasePool.execute(
        `SELECT a.account_id AS accountId,
                a.account_number AS accountNumber,
                a.balance,
                a.status,
                a.created_at AS createdAt,
                c.customer_id AS customerId,
                c.full_name AS fullName,
                c.address,
                c.phone
         FROM accounts a
         INNER JOIN customers c ON c.customer_id = a.customer_id
         WHERE a.account_number = ?
           AND (? IS NULL OR c.customer_id = ?)`,
        [
          accountNumber,
          req.user?.role === "CUSTOMER" ? req.user.customerId : null,
          req.user?.role === "CUSTOMER" ? req.user.customerId : null,
        ]
      );
      if (!accounts.length) return res.status(404).json({ message: "Account not found." });
      return res.status(200).json({ account: accounts[0] });
    } catch (error) {
      console.error("Account detail lookup failed:", error.code || "unknown error");
      return res.status(500).json({ message: "Unable to retrieve account details." });
    }
  });

  router.get("/", async (req, res) => {
  try {
    const search = String(req.query.search || "").trim();

    if (search.length > 100) {
      return res.status(400).json({
        message: "Search must be 100 characters or fewer.",
      });
    }

    const searchPattern = `%${search}%`;

    const [accounts] = await databasePool.execute(
      `SELECT
         a.account_id AS accountId,
         a.account_number AS accountNumber,
         a.balance,
         a.status,
         a.created_at AS createdAt,
         c.customer_id AS customerId,
         c.full_name AS fullName,
         c.address,
         c.phone
       FROM accounts a
       INNER JOIN customers c ON c.customer_id = a.customer_id
       WHERE (? = ''
          OR a.account_number LIKE ?
          OR c.full_name LIKE ?)
         AND (? IS NULL OR c.customer_id = ?)
       ORDER BY a.created_at DESC
       LIMIT 100`,
      [
        search,
        searchPattern,
        searchPattern,
        req.user?.role === "CUSTOMER" ? req.user.customerId : null,
        req.user?.role === "CUSTOMER" ? req.user.customerId : null,
      ]
    );

    return res.status(200).json({ accounts });
  } catch (error) {
    console.error("Account listing failed:", error.code || "unknown error");
    return res.status(500).json({
      message: "Unable to retrieve accounts.",
    });
  }
});

router.patch("/:accountNumber", requireRole("ADMIN", "STAFF"), async (req, res) => {
  const { accountNumber } = req.params;
  if (!/^\d{10}$/.test(accountNumber)) {
    return res.status(400).json({ message: "Enter a valid 10-digit account number." });
  }

  const { fullName, address, phone } = req.body || {};
  if (
    typeof fullName !== "string" ||
    typeof address !== "string" ||
    typeof phone !== "string" ||
    !fullName.trim() ||
    !address.trim() ||
    !phone.trim()
  ) {
    return res.status(400).json({ message: "Full name, address, and phone are required." });
  }
  if (fullName.trim().length > 100 || address.trim().length > 255) {
    return res.status(400).json({ message: "One or more fields exceed the allowed length." });
  }
  const normalizedPhone = phone.trim().replace(/[\s()-]/g, "");
  if (!/^\+?[0-9]{7,15}$/.test(normalizedPhone) || normalizedPhone.length > 15) {
    return res.status(400).json({ message: "Enter a valid phone number." });
  }

  let connection;
  let transactionStarted = false;
  try {
    connection = await databasePool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;
    const [accounts] = await connection.execute(
      "SELECT account_id, customer_id FROM accounts WHERE account_number = ? FOR UPDATE",
      [accountNumber]
    );
    if (!accounts.length) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(404).json({ message: "Account not found." });
    }

    await connection.execute(
      "UPDATE customers SET full_name = ?, address = ?, phone = ? WHERE customer_id = ?",
      [fullName.trim(), address.trim(), normalizedPhone, accounts[0].customer_id]
    );
    await connection.commit();
    transactionStarted = false;
    return res.status(200).json({
      message: "Customer details updated.",
      account: {
        accountNumber,
        customerId: accounts[0].customer_id,
        fullName: fullName.trim(),
        address: address.trim(),
        phone: normalizedPhone,
      },
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Customer update rollback failed:", rollbackError.code || "unknown error");
      }
    }
    console.error("Customer details update failed:", error.code || "unknown error");
    return res.status(500).json({ message: "Unable to update customer details." });
  } finally {
    connection?.release();
  }
});

router.patch(
  "/:accountNumber/deactivate",
  requireRole("ADMIN", "STAFF"),
  createDeactivateAccountHandler(databasePool)
);

router.post("/", requireRole("ADMIN", "STAFF"), async (req, res) => {
  const {
    fullName,
    address,
    phone,
    idProofType,
    idProofNumber,
    initialDeposit,
  } = req.body;

  // Validate required fields.
  if (
    typeof fullName !== "string" ||
    typeof address !== "string" ||
    typeof phone !== "string" ||
    typeof idProofType !== "string" ||
    typeof idProofNumber !== "string" ||
    !fullName.trim() ||
    !address.trim() ||
    !phone.trim() ||
    !idProofType.trim() ||
    !idProofNumber.trim()
  ) {
    return res.status(400).json({
      message: "All customer and KYC fields are required.",
    });
  }

  if (
    fullName.trim().length > 100 ||
    address.trim().length > 255 ||
    idProofType.trim().length > 30 ||
    idProofNumber.trim().length > 100
  ) {
    return res.status(400).json({
      message: "One or more fields exceed the allowed length.",
    });
  }

  const normalizedPhone = phone.trim().replace(/[\s()-]/g, "");

  if (!/^\+?[0-9]{7,15}$/.test(normalizedPhone) || normalizedPhone.length > 15) {
    return res.status(400).json({
      message: "Enter a valid phone number.",
    });
  }

  if (
    typeof initialDeposit !== "number" ||
    !Number.isFinite(initialDeposit) ||
    initialDeposit < 500 ||
    initialDeposit > 9999999999.99
  ) {
    return res.status(400).json({
      message: "Initial deposit must be at least ₹500.",
    });
  }

  // Avoid unexpected floating-point precision in money values.
  if (Math.round(initialDeposit * 100) !== initialDeposit * 100) {
    return res.status(400).json({
      message: "Deposit can have at most two decimal places.",
    });
  }

  let connection;
  let transactionStarted = false;

  try {
    connection = await databasePool.getConnection();

    await connection.beginTransaction();
    transactionStarted = true;

    const [customerResult] = await connection.execute(
      `INSERT INTO customers
       (full_name, address, phone, id_proof_type, id_proof_number)
       VALUES (?, ?, ?, ?, ?)`,
      [
        fullName.trim(),
        address.trim(),
        normalizedPhone,
        idProofType.trim(),
        idProofNumber.trim(),
      ]
    );

    const customerId = customerResult.insertId;

    let accountNumber;
    let accountCreated = false;

    // Retry if a randomly generated account number already exists.
    for (let attempt = 0; attempt < 5; attempt++) {
      accountNumber = generateAccountNumber();

      try {
        await connection.execute(
          `INSERT INTO accounts
           (account_number, customer_id, balance)
           VALUES (?, ?, ?)`,
          [accountNumber, customerId, initialDeposit.toFixed(2)]
        );

        accountCreated = true;
        break;
      } catch (error) {
        if (
          error.code === "ER_DUP_ENTRY" &&
          error.message.includes("uq_account_number")
        ) {
          continue;
        }

        throw error;
      }
    }

    if (!accountCreated) {
      const error = new Error("Unable to generate a unique account number.");
      error.code = "ACCOUNT_NUMBER_RETRY_LIMIT";
      throw error;
    }

    const [accountRows] = await connection.execute(
      "SELECT account_id FROM accounts WHERE account_number = ?",
      [accountNumber]
    );

    const accountId = accountRows[0].account_id;

    await connection.execute(
      `INSERT INTO transactions
       (transaction_ref, account_id, transaction_type, amount, balance_after)
       VALUES (?, ?, 'DEPOSIT', ?, ?)`,
      [
        randomUUID(),
        accountId,
        initialDeposit.toFixed(2),
        initialDeposit.toFixed(2),
      ]
    );

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      message: "Bank account created successfully.",
      account: {
        accountNumber,
        customerId,
        balance: initialDeposit.toFixed(2),
        status: "ACTIVE",
      },
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Database rollback failed.");
      }
    }

    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({
        message: "This ID proof is already registered.",
      });
    }

    if (error.code === "ACCOUNT_NUMBER_RETRY_LIMIT") {
      return res.status(503).json({
        message: "Could not generate an account number. Please retry.",
      });
    }

    console.error("Account creation failed:", error.code || "unknown error");

    return res.status(500).json({
      message: "Account creation failed. Please try again.",
    });
  } finally {
    if (connection) {
      connection.release();
    }
  }
  });

  return router;
}

module.exports = createAccountRouter();
module.exports.createAccountRouter = createAccountRouter;
module.exports.createDeactivateAccountHandler = createDeactivateAccountHandler;

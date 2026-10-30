
const express = require("express");
const { randomInt, randomUUID } = require("node:crypto");
const { requireRole } = require("../auth/middleware");
const { writeAuditEvent } = require("../audit-logger");
const pool = require("../db");
const {
  formatMoneyCents,
  isRecord,
  isValidAccountNumber,
  normalizePhone,
  normalizeText,
  parseMoneyCents,
} = require("../validation");

const MIN_INITIAL_DEPOSIT_CENTS = 50000n;

function generateAccountNumber() {
  // Always generates exactly 10 numeric digits.
  return String(randomInt(1_000_000_000, 10_000_000_000));
}

async function writeFailedAccountAudit(databasePool, event) {
  try {
    await writeAuditEvent(databasePool, event);
  } catch (error) {
    console.error("Account audit write failed:", error.code || "unknown error");
  }
}

function createAccountStatusTransitionHandler(databasePool, fixedTargetStatus = null) {
  return async (req, res) => {
    const { accountNumber } = req.params;
    if (!isValidAccountNumber(accountNumber) || req.body?.confirm !== true) {
      return res.status(400).json({ message: "Provide a valid account number and explicit confirmation." });
    }

    const requestedStatus = fixedTargetStatus || req.body?.status;
    if (typeof requestedStatus !== "string" || !["ACTIVE", "INACTIVE"].includes(requestedStatus.toUpperCase())) {
      return res.status(400).json({ message: "Target status must be ACTIVE or INACTIVE." });
    }
    const targetStatus = requestedStatus.toUpperCase();
    const isDeactivation = targetStatus === "INACTIVE";
    const failureEventType = isDeactivation ? "ACCOUNT_DEACTIVATION_FAILURE" : "ACCOUNT_ACTIVATION_FAILURE";
    const successEventType = isDeactivation ? "ACCOUNT_DEACTIVATION_SUCCESS" : "ACCOUNT_ACTIVATION_SUCCESS";

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
        await writeFailedAccountAudit(databasePool, {
          eventType: failureEventType,
          outcome: "FAILURE",
          actorUserId: req.user?.userId ?? null,
          actorRole: req.user?.role ?? null,
          targetType: "account",
          targetId: accountNumber,
        });
        return res.status(404).json({ message: "Account not found." });
      }
      if (accounts[0].status === targetStatus) {
        await connection.rollback();
        transactionStarted = false;
        await writeFailedAccountAudit(databasePool, {
          eventType: failureEventType,
          outcome: "FAILURE",
          actorUserId: req.user?.userId ?? null,
          actorRole: req.user?.role ?? null,
          targetType: "account",
          targetId: accountNumber,
        });
        return res.status(409).json({
          message: isDeactivation ? "Account is already inactive." : "Account is already active.",
        });
      }
      await connection.execute(
        isDeactivation
          ? "UPDATE accounts SET status = 'INACTIVE' WHERE account_id = ?"
          : "UPDATE accounts SET status = 'ACTIVE' WHERE account_id = ?",
        [accounts[0].account_id]
      );
      await writeAuditEvent(connection, {
        eventType: successEventType,
        outcome: "SUCCESS",
        actorUserId: req.user?.userId ?? null,
        actorRole: req.user?.role ?? null,
        targetType: "account",
        targetId: accountNumber,
      });
      await connection.commit();
      transactionStarted = false;
      return res.status(200).json({
        message: isDeactivation ? "Account deactivated." : "Account activated.",
        accountNumber,
        status: targetStatus,
        previousStatus: accounts[0].status,
      });
    } catch (error) {
      if (connection && transactionStarted) {
        try {
          await connection.rollback();
        } catch (rollbackError) {
          console.error("Account status transition rollback failed:", rollbackError.code || "unknown error");
        }
      }
      console.error("Account status transition failed:", error.code || "unknown error");
      return res.status(500).json({
        message: isDeactivation ? "Unable to deactivate the account." : "Unable to activate the account.",
      });
    } finally {
      connection?.release();
    }
  };
}

function createDeactivateAccountHandler(databasePool) {
  return createAccountStatusTransitionHandler(databasePool, "INACTIVE");
}

function createActivateAccountHandler(databasePool) {
  return createAccountStatusTransitionHandler(databasePool, "ACTIVE");
}

function createUpdateAccountStatusHandler(databasePool) {
  return createAccountStatusTransitionHandler(databasePool, null);
}

function createAccountRouter(databasePool = pool) {
  const router = express.Router();

  router.get("/:accountNumber", async (req, res) => {
    const { accountNumber } = req.params;
    if (!isValidAccountNumber(accountNumber)) {
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
      const rawSearch =
        req.query.search === undefined ? "" : req.query.search;
      const rawStatus =
        req.query.status === undefined ? "" : req.query.status;

      // Validate the status filter.
      if (
        typeof rawStatus !== "string" ||
        !["", "ACTIVE", "INACTIVE"].includes(rawStatus)
      ) {
        return res.status(400).json({
          message: "Status must be ACTIVE or INACTIVE.",
        });
      }

      // Validate the search input.
      if (typeof rawSearch !== "string") {
        return res.status(400).json({
          message: "Search must be a text value of 100 characters or fewer.",
        });
      }

      const search = rawSearch.trim();

      if (Array.from(search).length > 100 || /\p{Cc}/u.test(search)) {
        return res.status(400).json({
          message: "Search must be 100 characters or fewer.",
        });
      }

      const searchPattern = `%${search}%`;
      const customerId =
        req.user?.role === "CUSTOMER" ? req.user.customerId : null;

      // Search by account number or customer name, apply the status
      // filter, and restrict customer users to their own accounts.
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
         INNER JOIN customers c
           ON c.customer_id = a.customer_id
         WHERE (
           ? = ''
           OR a.account_number LIKE ?
           OR c.full_name LIKE ?
         )
           AND (? IS NULL OR c.customer_id = ?)
           AND (? = '' OR a.status = ?)
         ORDER BY a.created_at DESC
         LIMIT 100`,
        [
          search,
          searchPattern,
          searchPattern,
          customerId,
          customerId,
          rawStatus,
          rawStatus,
        ]
      );

      return res.status(200).json({ accounts });
    } catch (error) {
      console.error(
        "Account listing failed:",
        error.code || "unknown error"
      );

      return res.status(500).json({
        message: "Unable to retrieve accounts.",
      });
    }
  });


router.patch("/:accountNumber", requireRole("ADMIN", "STAFF"), async (req, res) => {
  const { accountNumber } = req.params;
  if (!isValidAccountNumber(accountNumber)) {
    return res.status(400).json({ message: "Enter a valid 10-digit account number." });
  }

  if (!isRecord(req.body)) {
    return res.status(400).json({ message: "Full name, address, and phone are required." });
  }
  const fullName = normalizeText(req.body.fullName, 100);
  const address = normalizeText(req.body.address, 255);
  const phone = normalizePhone(req.body.phone);
  if (!fullName || !address || !phone) {
    return res.status(400).json({ message: "One or more fields exceed the allowed length." });
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
      await writeFailedAccountAudit(databasePool, {
        eventType: "ACCOUNT_EDIT_FAILURE",
        outcome: "FAILURE",
        actorUserId: req.user?.userId ?? null,
        actorRole: req.user?.role ?? null,
        targetType: "account",
        targetId: accountNumber,
      });
      return res.status(404).json({ message: "Account not found." });
    }

    await connection.execute(
      "UPDATE customers SET full_name = ?, address = ?, phone = ? WHERE customer_id = ?",
      [fullName, address, phone, accounts[0].customer_id]
    );
    await writeAuditEvent(connection, {
      eventType: "ACCOUNT_EDIT_SUCCESS",
      outcome: "SUCCESS",
      actorUserId: req.user?.userId ?? null,
      actorRole: req.user?.role ?? null,
      targetType: "account",
      targetId: accountNumber,
    });
    await connection.commit();
    transactionStarted = false;
    return res.status(200).json({
      message: "Customer details updated.",
      account: {
        accountNumber,
        customerId: accounts[0].customer_id,
        fullName,
        address,
        phone,
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

router.patch(
  "/:accountNumber/activate",
  requireRole("ADMIN", "STAFF"),
  createActivateAccountHandler(databasePool)
);

router.patch(
  "/:accountNumber/status",
  requireRole("ADMIN", "STAFF"),
  createUpdateAccountStatusHandler(databasePool)
);

router.post("/", requireRole("ADMIN", "STAFF"), async (req, res) => {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body
    : {};

  const {
    fullName: submittedFullName,
    address: submittedAddress,
    phone: submittedPhone,
    idProofType: submittedIdProofType,
    idProofNumber: submittedIdProofNumber,
    initialDeposit,
  } = body;

  const fullName = normalizeText(submittedFullName, 100);
  const address = normalizeText(submittedAddress, 255);
  const idProofType = normalizeText(submittedIdProofType, 30);
  const idProofNumber = normalizeText(submittedIdProofNumber, 100);
  const normalizedPhone = normalizePhone(submittedPhone);
  const initialDepositCents = parseMoneyCents(initialDeposit);

  if (
    !fullName ||
    !address ||
    !normalizedPhone ||
    !idProofType ||
    !idProofNumber ||
    !/^[A-Za-z][A-Za-z0-9 _-]*$/.test(idProofType)
  ) {
    return res.status(400).json({
      message: "All customer and KYC fields are required.",
    });
  }

  if (initialDepositCents === null || initialDepositCents < MIN_INITIAL_DEPOSIT_CENTS) {
    return res.status(400).json({
      message: "Initial deposit must be at least ₹500.",
    });
  }

  const initialDepositValue = formatMoneyCents(initialDepositCents);

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
        fullName,
        address,
        normalizedPhone,
        idProofType.toUpperCase(),
        idProofNumber,
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
          [accountNumber, customerId, initialDepositValue]
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
        initialDepositValue,
        initialDepositValue,
      ]
    );

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      message: "Bank account created successfully.",
      account: {
        accountNumber,
        customerId,
        balance: initialDepositValue,
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
module.exports.createActivateAccountHandler = createActivateAccountHandler;
module.exports.createUpdateAccountStatusHandler = createUpdateAccountStatusHandler;
module.exports.createAccountStatusTransitionHandler = createAccountStatusTransitionHandler;

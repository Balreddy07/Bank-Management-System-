const express = require("express");
const { randomUUID } = require("node:crypto");
const pool = require("../db");

const MAX_BALANCE_CENTS = 999999999999n;
const MIN_WITHDRAWAL_BALANCE_CENTS = 100000n;

function parseMoneyCents(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return null;

  const cents = BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
  return cents <= MAX_BALANCE_CENTS ? cents : null;
}

function formatMoneyCents(cents) {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function readStoredMoneyCents(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) throw new Error("Invalid monetary value stored in database.");
  return BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
}

function createTransactionRouter(databasePool = pool) {
  const router = express.Router();

  router.post("/deposit", (req, res) =>
    processBalanceChange(req, res, "DEPOSIT", databasePool)
  );
  router.post("/withdraw", (req, res) =>
    processBalanceChange(req, res, "WITHDRAWAL", databasePool)
  );

  router.get("/", async (req, res) => {
    const accountNumber = String(req.query.accountNumber || "");
    if (!/^\d{10}$/.test(accountNumber)) {
      return res.status(400).json({ message: "Enter a valid 10-digit account number." });
    }

    try {
      const [accounts] = await databasePool.execute(
        `SELECT account_number AS accountNumber, balance, status
         FROM accounts
         WHERE account_number = ?`,
        [accountNumber]
      );

      if (accounts.length === 0) {
        return res.status(404).json({ message: "Account not found." });
      }

      const [transactions] = await databasePool.execute(
        `SELECT transaction_ref AS transactionRef,
                transaction_type AS type,
                amount,
                balance_after AS balanceAfter,
                created_at AS createdAt
         FROM transactions
         WHERE account_id = (
           SELECT account_id FROM accounts WHERE account_number = ?
         )
         ORDER BY created_at DESC
         LIMIT 50`,
        [accountNumber]
      );

      return res.status(200).json({ account: accounts[0], transactions });
    } catch (error) {
      console.error("Transaction history lookup failed:", error.code || "unknown error");
      return res.status(500).json({ message: "Unable to retrieve transaction history." });
    }
  });

  router.get("/:transactionRef", async (req, res) => {
    const { transactionRef } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(transactionRef)) {
      return res.status(400).json({ message: "Enter a valid transaction reference." });
    }

    try {
      const [transactions] = await databasePool.execute(
        `SELECT t.transaction_ref AS transactionRef,
                a.account_number AS accountNumber,
                t.transaction_type AS type,
                t.amount,
                t.balance_after AS balanceAfter,
                t.created_at AS createdAt
         FROM transactions t
         INNER JOIN accounts a ON a.account_id = t.account_id
         WHERE t.transaction_ref = ?`,
        [transactionRef]
      );

      if (transactions.length === 0) {
        return res.status(404).json({ message: "Transaction not found." });
      }

      return res.status(200).json({ transaction: transactions[0] });
    } catch (error) {
      console.error("Transaction lookup failed:", error.code || "unknown error");
      return res.status(500).json({ message: "Unable to retrieve the transaction." });
    }
  });

  return router;
}

async function processBalanceChange(req, res, transactionType, databasePool) {
  const { accountNumber, amount } = req.body || {};

  if (typeof accountNumber !== "string" || !/^\d{10}$/.test(accountNumber)) {
    return res.status(400).json({ message: "Enter a valid 10-digit account number." });
  }

  const amountCents = parseMoneyCents(amount);
  if (amountCents === null || amountCents <= 0n) {
    return res.status(400).json({ message: "Amount must be positive and have at most two decimal places." });
  }

  let connection;
  let transactionStarted = false;

  try {
    connection = await databasePool.getConnection();
    await connection.beginTransaction();
    transactionStarted = true;

    const [accounts] = await connection.execute(
      `SELECT account_id, account_number, balance, status
       FROM accounts
       WHERE account_number = ?
       FOR UPDATE`,
      [accountNumber]
    );

    if (accounts.length === 0) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(404).json({ message: "Account not found." });
    }

    const account = accounts[0];
    if (account.status !== "ACTIVE") {
      await connection.rollback();
      transactionStarted = false;
      return res.status(409).json({ message: "Transactions are not allowed for an inactive account." });
    }

    const currentBalanceCents = readStoredMoneyCents(account.balance);
    const nextBalanceCents = transactionType === "DEPOSIT"
      ? currentBalanceCents + amountCents
      : currentBalanceCents - amountCents;

    if (transactionType === "WITHDRAWAL" && nextBalanceCents < MIN_WITHDRAWAL_BALANCE_CENTS) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(422).json({ message: "Withdrawal would reduce the balance below ₹1,000.00." });
    }

    if (nextBalanceCents < 0n || nextBalanceCents > MAX_BALANCE_CENTS) {
      await connection.rollback();
      transactionStarted = false;
      return res.status(422).json({ message: "Transaction exceeds the supported account balance." });
    }

    const balanceAfter = formatMoneyCents(nextBalanceCents);
    const amountValue = formatMoneyCents(amountCents);
    const transactionRef = randomUUID();

    await connection.execute(
      "UPDATE accounts SET balance = ? WHERE account_id = ?",
      [balanceAfter, account.account_id]
    );
    await connection.execute(
      `INSERT INTO transactions
       (transaction_ref, account_id, transaction_type, amount, balance_after)
       VALUES (?, ?, ?, ?, ?)`,
      [transactionRef, account.account_id, transactionType, amountValue, balanceAfter]
    );

    const [transactionRows] = await connection.execute(
      `SELECT transaction_ref AS transactionRef,
              transaction_type AS type,
              amount,
              balance_after AS balanceAfter,
              created_at AS createdAt
       FROM transactions
       WHERE transaction_ref = ?`,
      [transactionRef]
    );

    if (transactionRows.length === 0) {
      const error = new Error("Transaction receipt could not be generated.");
      error.code = "TRANSACTION_RECEIPT_MISSING";
      throw error;
    }

    await connection.commit();
    transactionStarted = false;

    return res.status(201).json({
      message: transactionType === "DEPOSIT" ? "Deposit completed." : "Withdrawal completed.",
      account: {
        accountNumber: account.account_number,
        balance: balanceAfter,
      },
      transaction: transactionRows[0],
    });
  } catch (error) {
    if (connection && transactionStarted) {
      try {
        await connection.rollback();
      } catch (rollbackError) {
        console.error("Transaction rollback failed:", rollbackError.code || "unknown error");
      }
    }

    console.error("Account transaction failed:", error.code || "unknown error");
    return res.status(500).json({ message: "Transaction could not be completed. Please try again." });
  } finally {
    if (connection) connection.release();
  }
}

module.exports = createTransactionRouter();
module.exports.createTransactionRouter = createTransactionRouter;
module.exports.parseMoneyCents = parseMoneyCents;
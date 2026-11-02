const assert = require("node:assert/strict");
const express = require("express");
const { once } = require("node:events");
const test = require("node:test");
const { createTransactionRouter } = require("../src/routes/transactions");

const ACCOUNTS = [
  { account_id: 1, account_number: "7811288401", balance: "1500.00", status: "ACTIVE" },
  { account_id: 2, account_number: "9900010002", balance: "3000.00", status: "ACTIVE" },
];

class ConcurrentPool {
  constructor(accounts) {
    this.accounts = accounts.map((account) => ({ ...account }));
    this.transactions = [];
    this.lockTails = new Map();
    this.activeLocks = 0;
    this.maxConcurrentLocks = 0;
  }

  async acquireAccountLock(accountId) {
    const previous = this.lockTails.get(accountId) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => { release = resolve; });
    this.lockTails.set(accountId, current);
    await previous;
    this.activeLocks += 1;
    this.maxConcurrentLocks = Math.max(this.maxConcurrentLocks, this.activeLocks);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeLocks -= 1;
      release();
    };
  }

  async getConnection() {
    const database = this;
    let releaseLock;
    let lockedAccount;
    let stagedBalance;
    let stagedTransaction;
    return {
      async beginTransaction() {},
      async execute(sql, params) {
        if (sql.includes("FROM accounts") && sql.includes("FOR UPDATE")) {
          let account = database.accounts.find((item) => item.account_number === params[0]);
          if (!account) return [[]];
          releaseLock = await database.acquireAccountLock(account.account_id);
          await new Promise((resolve) => setTimeout(resolve, 1));
          account = database.accounts.find((item) => item.account_id === account.account_id);
          lockedAccount = account;
          return [[{ ...account }]];
        }
        if (sql.startsWith("UPDATE accounts")) {
          stagedBalance = params[0];
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("INSERT INTO transactions")) {
          stagedTransaction = {
            transaction_ref: params[0],
            account_id: params[1],
            transaction_type: params[2],
            amount: params[3],
            balance_after: params[4],
            created_at: new Date("2026-10-28T12:00:00.000Z"),
          };
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("WHERE transaction_ref = ?")) {
          const transaction = stagedTransaction?.transaction_ref === params[0]
            ? stagedTransaction
            : database.transactions.find((item) => item.transaction_ref === params[0]);
          return [transaction ? [database.toApiTransaction(transaction)] : []];
        }
        throw new Error(`Unexpected connection query: ${sql}`);
      },
      async commit() {
        if (stagedBalance !== undefined && lockedAccount) lockedAccount.balance = stagedBalance;
        if (stagedTransaction) database.transactions.push(stagedTransaction);
      },
      async rollback() {
        stagedBalance = undefined;
        stagedTransaction = undefined;
      },
      release() {
        releaseLock?.();
      },
    };
  }

  toApiTransaction(transaction) {
    return {
      transactionRef: transaction.transaction_ref,
      type: transaction.transaction_type,
      amount: transaction.amount,
      balanceAfter: transaction.balance_after,
      createdAt: transaction.created_at,
    };
  }

  async execute(sql, params) {
    if (sql.includes("SELECT account_number AS accountNumber, balance, status")) {
      const account = this.accounts.find((item) => item.account_number === params[0]);
      return [account ? [{
        accountNumber: account.account_number,
        balance: account.balance,
        status: account.status,
      }] : []];
    }
    if (sql.includes("FROM transactions") && sql.includes("account_id = (")) {
      const account = this.accounts.find((item) => item.account_number === params[0]);
      const transactions = this.transactions
        .filter((item) => item.account_id === account?.account_id)
        .sort((left, right) => new Date(right.created_at) - new Date(left.created_at))
        .slice(0, 50)
        .map((item) => this.toApiTransaction(item));
      return [transactions];
    }
    if (sql.includes("FROM transactions t") && sql.includes("transaction_ref = ?")) {
      const transaction = this.transactions.find((item) => item.transaction_ref === params[0]);
      const account = this.accounts.find((item) => item.account_id === transaction?.account_id);
      return [transaction ? [{
        ...this.toApiTransaction(transaction),
        accountNumber: account.account_number,
      }] : []];
    }
    throw new Error(`Unexpected pool query: ${sql}`);
  }
}

async function startApi(database) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { userId: 41, role: "ADMIN" };
    next();
  });
  app.use("/api/transactions", createTransactionRouter(database));
  const server = app.listen(0);
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/api/transactions`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function postTransaction(baseUrl, operation, accountNumber, amount) {
  const response = await fetch(`${baseUrl}/${operation}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ accountNumber, amount }),
  });
  return { status: response.status, body: await response.json() };
}

function cents(value) {
  const [whole, fraction] = String(value).split(".");
  return BigInt(whole) * 100n + BigInt((fraction || "").padEnd(2, "0"));
}

function assertReconciled(database, initialAccounts) {
  const references = database.transactions.map((transaction) => transaction.transaction_ref);
  assert.equal(new Set(references).size, references.length);
  for (const initialAccount of initialAccounts) {
    const account = database.accounts.find((item) => item.account_id === initialAccount.account_id);
    const accountTransactions = database.transactions.filter((item) => item.account_id === account.account_id);
    const netChange = accountTransactions.reduce((total, transaction) => {
      const amount = cents(transaction.amount);
      return total + (transaction.transaction_type === "DEPOSIT" ? amount : -amount);
    }, 0n);
    assert.equal(cents(account.balance), cents(initialAccount.balance) + netChange);
    for (const transaction of accountTransactions) {
      if (transaction.transaction_type === "WITHDRAWAL") {
        assert.ok(cents(transaction.balance_after) >= 100000n);
      }
    }
  }
}

test("simultaneous deposits and withdrawals on one account preserve every effect and receipt", async () => {
  const initialAccounts = [ACCOUNTS[0]];
  const database = new ConcurrentPool(initialAccounts);
  const api = await startApi(database);
  const operations = Array.from({ length: 32 }, (_, index) => index % 2 === 0 ? "deposit" : "withdraw");

  try {
    const results = await Promise.all(operations.map((operation) =>
      postTransaction(api.baseUrl, operation, ACCOUNTS[0].account_number, 5)
    ));
    assert.ok(results.every((result) => result.status === 201));
    assert.equal(database.transactions.length, operations.length);
    assert.equal(database.accounts[0].balance, "1500.00");
    assert.equal(database.maxConcurrentLocks, 1);
    assertReconciled(database, initialAccounts);

    const receipts = await Promise.all(database.transactions.map(async (transaction) => {
      const response = await fetch(`${api.baseUrl}/${transaction.transaction_ref}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.transaction.transactionRef, transaction.transaction_ref);
      assert.equal(body.transaction.accountNumber, ACCOUNTS[0].account_number);
      assert.equal(body.transaction.balanceAfter, transaction.balance_after);
      return body.transaction.transactionRef;
    }));
    assert.equal(new Set(receipts).size, operations.length);
  } finally {
    await api.close();
  }
});

test("simultaneous mixed transactions on different accounts overlap without lost updates", async () => {
  const initialAccounts = ACCOUNTS.map((account) => ({ ...account }));
  const database = new ConcurrentPool(initialAccounts);
  const api = await startApi(database);
  const operations = initialAccounts.flatMap((account) =>
    Array.from({ length: 20 }, (_, index) => ({
      accountNumber: account.account_number,
      operation: index % 2 === 0 ? "deposit" : "withdraw",
    }))
  );

  try {
    const results = await Promise.all(operations.map((operation) =>
      postTransaction(api.baseUrl, operation.operation, operation.accountNumber, 10)
    ));
    assert.ok(results.every((result) => result.status === 201));
    assert.equal(database.transactions.length, operations.length);
    assert.ok(database.maxConcurrentLocks >= 2);
    assertReconciled(database, initialAccounts);

    for (const account of initialAccounts) {
      const historyResponse = await fetch(
        `${api.baseUrl}?accountNumber=${account.account_number}`
      );
      assert.equal(historyResponse.status, 200);
      const history = await historyResponse.json();
      assert.equal(history.transactions.length, 20);
      assert.equal(history.account.balance, account.balance);
    }
  } finally {
    await api.close();
  }
});

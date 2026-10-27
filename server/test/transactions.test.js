const assert = require("node:assert/strict");
const express = require("express");
const session = require("express-session");
const { once } = require("node:events");
const test = require("node:test");
const bcrypt = require("bcrypt");
const { createApp } = require("../src/app");
const MySQLSessionStore = require("../src/auth/mysql-session-store");
const { createAccountRouter } = require("../src/routes/accounts");
const { createReportRouter } = require("../src/routes/reports");
const { createTransactionRouter } = require("../src/routes/transactions");

const ACCOUNT_NUMBER = "7811288401";

class FakePool {
  constructor({
    balance = "1500.00",
    status = "ACTIVE",
    failInsert = false,
    failCommit = false,
    failAccountLock = false,
    failDuplicateInsert = false,
    hideTransactionReceipt = false,
    duplicateTransactionRefs = [],
    duplicateKeyName = "uq_transactions_transaction_ref",
    reportSummary = {
      transactionCount: 4,
      totalDeposits: "1500.00",
      totalWithdrawals: "250.00",
    },
    reportAccountSummary = {
      activeAccountCount: 3,
      totalBalance: "6250.00",
    },
  } = {}) {
    this.account = {
      account_id: 1,
      account_number: ACCOUNT_NUMBER,
      balance,
      status,
    };
    this.transactions = [];
    this.historyQuery = null;
    this.idempotencyRecords = new Map();
    this.failInsert = failInsert;
    this.failCommit = failCommit;
    this.failAccountLock = failAccountLock;
    this.failDuplicateInsert = failDuplicateInsert;
    this.hideTransactionReceipt = hideTransactionReceipt;
    this.duplicateTransactionRefs = new Set(duplicateTransactionRefs);
    this.duplicateKeyName = duplicateKeyName;
    this.reportSummary = reportSummary;
    this.reportAccountSummary = reportAccountSummary;
    this.reportQuery = null;
    this.reportAccountQuery = null;
    this.lockTail = Promise.resolve();
    this.transactionLifecycle = {
      begins: 0,
      commits: 0,
      rollbacks: 0,
      releases: 0,
    };
  }

  async acquireLock() {
    const previous = this.lockTail;
    let unlock;
    this.lockTail = new Promise((resolve) => {
      unlock = resolve;
    });
    await previous;
    return unlock;
  }

  async getConnection() {
    const database = this;
    let unlock;
    let stagedBalance;
    let stagedTransaction;
    let stagedIdempotencyRecord;
    let stagedIdempotencyScope;

    return {
      async beginTransaction() {
        database.transactionLifecycle.begins += 1;
        unlock = await database.acquireLock();
      },
      async execute(sql, params) {
        if (sql.includes("INSERT INTO transaction_idempotency")) {
          stagedIdempotencyScope = JSON.stringify(params.slice(0, 4));
          if (database.idempotencyRecords.has(stagedIdempotencyScope)) {
            const error = new Error("Duplicate entry for key 'uq_transaction_idempotency_scope'");
            error.code = "ER_DUP_ENTRY";
            error.sqlMessage = error.message;
            throw error;
          }
          stagedIdempotencyRecord = {
            requestHash: params[4],
            transactionRef: null,
          };
          return [{ affectedRows: 1 }];
        }

        if (sql.includes("FROM accounts") && sql.includes("FOR UPDATE")) {
          if (database.failAccountLock) {
            const error = new Error("simulated lock timeout");
            error.code = "ER_LOCK_WAIT_TIMEOUT";
            throw error;
          }
          return [database.account.account_number === params[0] ? [{ ...database.account }] : []];
        }

        if (sql.startsWith("UPDATE accounts")) {
          stagedBalance = params[0];
          return [{ affectedRows: 1 }];
        }

        if (sql.includes("UPDATE transaction_idempotency")) {
          if (!stagedIdempotencyRecord) return [{ affectedRows: 0 }];
          stagedIdempotencyRecord.transactionRef = params[0];
          return [{ affectedRows: 1 }];
        }

        if (sql.includes("INSERT INTO transactions")) {
          if (database.failDuplicateInsert) {
            const error = new Error("Duplicate entry for key 'uq_other_unique_key'");
            error.code = "ER_DUP_ENTRY";
            error.sqlMessage = error.message;
            throw error;
          }
          if (database.duplicateTransactionRefs.has(params[0])) {
            const error = new Error(`Duplicate entry for key '${database.duplicateKeyName}'`);
            error.code = "ER_DUP_ENTRY";
            error.sqlMessage = error.message;
            throw error;
          }
          if (database.failInsert) {
            const error = new Error("simulated insert failure");
            error.code = "TEST_INSERT_FAILURE";
            throw error;
          }

          stagedTransaction = {
            transaction_ref: params[0],
            account_id: params[1],
            transaction_type: params[2],
            amount: params[3],
            balance_after: params[4],
            created_at: new Date("2026-01-02T03:04:05.000Z"),
          };
          return [{ affectedRows: 1 }];
        }

        if (
          sql.includes("SELECT transaction_ref\n") &&
          sql.includes("FROM transactions") &&
          sql.includes("FOR UPDATE")
        ) {
          return [database.duplicateTransactionRefs.has(params[0])
            ? [{ transaction_ref: params[0] }]
            : []];
        }

        if (sql.includes("INFORMATION_SCHEMA.STATISTICS")) {
          return [params[0] === database.duplicateKeyName
            ? [{
              indexName: database.duplicateKeyName,
              columnCount: 1,
              referenceColumnCount: 1,
            }]
            : []];
        }

        if (sql.includes("WHERE transaction_ref = ?")) {
          if (database.hideTransactionReceipt) return [[]];
          const transaction = stagedTransaction?.transaction_ref === params[0]
            ? stagedTransaction
            : database.transactions.find((item) => item.transaction_ref === params[0]);
          return [transaction ? [database.toApiTransaction(transaction)] : []];
        }

        throw new Error(`Unexpected connection query: ${sql}`);
      },
      async commit() {
        database.transactionLifecycle.commits += 1;
        if (database.failCommit) {
          const error = new Error("simulated commit failure with private-test-marker");
          error.code = "TEST_COMMIT_FAILURE";
          throw error;
        }
        if (stagedBalance !== undefined) database.account.balance = stagedBalance;
        if (stagedTransaction) database.transactions.push(stagedTransaction);
        if (stagedIdempotencyRecord) {
          database.idempotencyRecords.set(stagedIdempotencyScope, stagedIdempotencyRecord);
        }
      },
      async rollback() {
        database.transactionLifecycle.rollbacks += 1;
        stagedBalance = undefined;
        stagedTransaction = undefined;
        stagedIdempotencyRecord = undefined;
        stagedIdempotencyScope = undefined;
      },
      release() {
        database.transactionLifecycle.releases += 1;
        unlock?.();
        unlock = null;
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
    if (sql.includes("FROM transaction_idempotency")) {
      const record = this.idempotencyRecords.get(JSON.stringify(params));
      return [record ? [{
        requestHash: record.requestHash,
        transactionRef: record.transactionRef,
      }] : []];
    }

    if (
      sql.includes("FROM transactions") &&
      sql.includes("WHERE transaction_ref = ?")
    ) {
      const transaction = this.transactions.find((item) => item.transaction_ref === params[0]);
      return [transaction ? [this.toApiTransaction(transaction)] : []];
    }

    if (sql.includes("transactionCount")) {
      this.reportQuery = { sql, params };
      return [[this.reportSummary]];
    }

    if (sql.includes("activeAccountCount")) {
      this.reportAccountQuery = { sql, params };
      return [[this.reportAccountSummary]];
    }

    if (sql.includes("SELECT account_number AS accountNumber, balance, status")) {
      if (this.account.account_number !== params[0]) return [[]];
      return [[{
        accountNumber: this.account.account_number,
        balance: this.account.balance,
        status: this.account.status,
      }]];
    }

    if (sql.includes("FROM transactions") && sql.includes("account_id = (")) {
      this.historyQuery = { sql, params };
      return [[...this.transactions]
        .filter((item) => item.account_id === this.account.account_id)
        .sort((left, right) => {
          const timeDifference = new Date(right.created_at) - new Date(left.created_at);
          return timeDifference || right.transaction_ref.localeCompare(left.transaction_ref);
        })
        .slice(0, 50)
        .map((item) => this.toApiTransaction(item))];
    }

    if (sql.includes("FROM transactions t") && sql.includes("transaction_ref = ?")) {
      const transaction = this.transactions.find((item) => item.transaction_ref === params[0]);
      return [transaction ? [{
        ...this.toApiTransaction(transaction),
        accountNumber: this.account.account_number,
      }] : []];
    }

    throw new Error(`Unexpected pool query: ${sql}`);
  }
}

class FakeAccountPool {
  constructor() {
    this.accounts = [];
    this.transactions = [];
    this.committed = false;
    this.connectionRequests = 0;
    this.queryCount = 0;
  }

  async execute(sql, params) {
    this.queryCount += 1;
    this.lastQuery = { sql, params };
    if (sql.includes("FROM accounts a")) {
      this.searchParams = params;
      const [search, accountPattern, namePattern] = params;
      assert.equal(accountPattern, `%${search}%`);
      assert.equal(namePattern, `%${search}%`);
      const query = search.toLowerCase();
      return [[...this.accounts].filter((account) =>
        !query ||
        account.accountNumber.includes(query) ||
        account.fullName.toLowerCase().includes(query)
      )];
    }
    throw new Error(`Unexpected account pool query: ${sql}`);
  }

  async getConnection() {
    this.connectionRequests += 1;
    const database = this;
    let stagedAccount;
    let stagedTransaction;

    return {
      async beginTransaction() {},
      async execute(sql, params) {
        if (sql.includes("INSERT INTO customers")) return [{ insertId: 12 }];
        if (sql.includes("INSERT INTO accounts")) {
          stagedAccount = {
            accountId: 21,
            accountNumber: params[0],
            balance: params[2],
            status: "ACTIVE",
            customerId: 12,
            fullName: "New Test Customer",
            phone: "9876543210",
          };
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("SELECT account_id FROM accounts")) return [[{ account_id: 21 }]];
        if (sql.includes("INSERT INTO transactions")) {
          stagedTransaction = {
            transactionRef: params[0],
            accountId: params[1],
            type: "DEPOSIT",
            amount: params[2],
            balanceAfter: params[3],
          };
          return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected account connection query: ${sql}`);
      },
      async commit() {
        database.accounts.push(stagedAccount);
        database.transactions.push(stagedTransaction);
        database.committed = true;
      },
      async rollback() {
        stagedAccount = undefined;
        stagedTransaction = undefined;
      },
      release() {},
    };
  }
}

class FakeCustomerAccountPool {
  constructor({ failCustomerUpdate = false, failAuditWrite = false } = {}) {
    this.account = {
      accountId: 21,
      account_id: 21,
      accountNumber: ACCOUNT_NUMBER,
      account_number: ACCOUNT_NUMBER,
      customerId: 12,
      customer_id: 12,
      balance: "2500.00",
      status: "ACTIVE",
      createdAt: new Date("2026-01-02T03:04:05.000Z"),
    };
    this.customer = {
      customerId: 12,
      customer_id: 12,
      fullName: "Asha Sharma",
      full_name: "Asha Sharma",
      address: "1 Old Road",
      phone: "9876543210",
    };
    this.transactions = [{ transactionRef: "existing-transaction" }];
    this.failCustomerUpdate = failCustomerUpdate;
    this.failAuditWrite = failAuditWrite;
    this.auditEvents = [];
    this.commitCount = 0;
    this.rollbackCount = 0;
  }

  async execute(sql, params) {
    if (sql.includes("INSERT INTO security_audit_logs")) {
      if (this.failAuditWrite) {
        const error = new Error("simulated audit write failure");
        error.code = "TEST_AUDIT_FAILURE";
        throw error;
      }
      this.auditEvents.push({
        eventType: params[0],
        outcome: params[1],
        actorUserId: params[2],
        actorRole: params[3],
        targetType: params[4],
        targetId: params[5],
        createdAt: new Date(),
      });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("FROM accounts a") && sql.includes("WHERE a.account_number = ?")) {
      if (params[0] !== this.account.accountNumber) return [[]];
      return [[{
        accountId: this.account.accountId,
        accountNumber: this.account.accountNumber,
        balance: this.account.balance,
        status: this.account.status,
        createdAt: this.account.createdAt,
        customerId: this.customer.customerId,
        fullName: this.customer.fullName,
        address: this.customer.address,
        phone: this.customer.phone,
      }]];
    }
    throw new Error(`Unexpected customer-account pool query: ${sql}`);
  }

  async getConnection() {
    const database = this;
    let stagedCustomer;
    let stagedStatus;
    const stagedAuditEvents = [];
    return {
      async beginTransaction() {},
      async execute(sql, params) {
        if (sql.includes("INSERT INTO security_audit_logs")) {
          if (database.failAuditWrite) {
            const error = new Error("simulated audit write failure");
            error.code = "TEST_AUDIT_FAILURE";
            throw error;
          }
          stagedAuditEvents.push({
            eventType: params[0],
            outcome: params[1],
            actorUserId: params[2],
            actorRole: params[3],
            targetType: params[4],
            targetId: params[5],
            createdAt: new Date(),
          });
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("SELECT account_id, customer_id FROM accounts")) {
          return [params[0] === database.account.accountNumber
            ? [{ account_id: database.account.accountId, customer_id: database.account.customerId }]
            : []];
        }
        if (sql.includes("SELECT account_id, status FROM accounts")) {
          return [params[0] === database.account.accountNumber
            ? [{ account_id: database.account.accountId, status: database.account.status }]
            : []];
        }
        if (sql.includes("UPDATE customers SET full_name = ?")) {
          if (database.failCustomerUpdate) {
            const error = new Error("simulated customer update failure");
            error.code = "TEST_CUSTOMER_UPDATE_FAILURE";
            throw error;
          }
          stagedCustomer = {
            ...database.customer,
            fullName: params[0],
            full_name: params[0],
            address: params[1],
            phone: params[2],
          };
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("UPDATE accounts SET status = 'INACTIVE'")) {
          stagedStatus = "INACTIVE";
          return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected customer-account connection query: ${sql}`);
      },
      async commit() {
        if (stagedCustomer) database.customer = stagedCustomer;
        if (stagedStatus) database.account.status = stagedStatus;
        database.auditEvents.push(...stagedAuditEvents);
        database.commitCount += 1;
      },
      async rollback() {
        stagedCustomer = undefined;
        stagedStatus = undefined;
        stagedAuditEvents.length = 0;
        database.rollbackCount += 1;
      },
      release() {},
    };
  }
}

class FakeAuthPool {
  constructor(users) {
    this.users = users;
    this.customerUsers = [];
    this.sessions = new Map();
    this.failSessionRead = false;
    this.failAuditWrite = false;
    this.auditEvents = [];
    this.account = {
      account_id: 61,
      account_number: ACCOUNT_NUMBER,
      accountId: 61,
      accountNumber: ACCOUNT_NUMBER,
      customer_id: 62,
      customerId: 62,
      balance: "2500.00",
      status: "ACTIVE",
      createdAt: new Date("2026-01-02T03:04:05.000Z"),
    };
    this.customer = {
      customer_id: 62,
      customerId: 62,
      full_name: "Asha Sharma",
      fullName: "Asha Sharma",
      address: "1 Old Road",
      phone: "9876543210",
    };
    this.otherAccount = {
      accountId: 63,
      accountNumber: "1098765432",
      balance: "3200.00",
      status: "ACTIVE",
      createdAt: new Date("2026-01-03T03:04:05.000Z"),
      customerId: 99,
    };
    this.otherCustomer = {
      customerId: 99,
      fullName: "Other Customer",
      address: "9 Other Road",
      phone: "9876543212",
    };
    this.transactions = [];
    this.idempotencyRecords = new Map();
    this.lockTail = Promise.resolve();
  }

  async acquireLock() {
    const previous = this.lockTail;
    let unlock;
    this.lockTail = new Promise((resolve) => {
      unlock = resolve;
    });
    await previous;
    return unlock;
  }

  async getConnection() {
    const database = this;
    let unlock;
    let stagedUser;
    let stagedCustomerUser;
    const stagedAuditEvents = [];
    return {
      async beginTransaction() {
        unlock = await database.acquireLock();
      },
      async execute(sql, params) {
        if (sql.includes("INSERT INTO security_audit_logs")) {
          if (database.failAuditWrite) {
            const error = new Error("simulated audit write failure");
            error.code = "TEST_AUDIT_FAILURE";
            throw error;
          }
          stagedAuditEvents.push({
            eventType: params[0],
            outcome: params[1],
            actorUserId: params[2],
            actorRole: params[3],
            targetType: params[4],
            targetId: params[5],
            createdAt: new Date(),
          });
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("SELECT data FROM user_sessions WHERE session_id = ? AND expires > UNIX_TIMESTAMP()")) {
          const stored = database.sessions.get(params[0]);
          return [[stored && stored.expires > Math.floor(Date.now() / 1000) ? { data: stored.data } : null].filter(Boolean)];
        }
        if (sql.includes("FROM customer_users") && sql.includes("WHERE username = ?")) {
          const customerUser = database.customerUsers.find((entry) => entry.username === params[0]);
          if (!customerUser) return [[]];
          const lockUntil = customerUser.lockedUntil ? new Date(customerUser.lockedUntil) : null;
          return [[{
            customerId: customerUser.customerId,
            username: customerUser.username,
            passwordHash: customerUser.passwordHash,
            failedLoginAttempts: customerUser.failedLoginAttempts,
            lockedUntil: lockUntil,
            isActive: customerUser.isActive,
            lockActive: lockUntil && lockUntil > new Date() ? 1 : 0,
            lockExpired: lockUntil && lockUntil <= new Date() ? 1 : 0,
          }]];
        }
        if (sql.includes("WHERE username = ?")) {
          const user = database.users.find((entry) => entry.username === params[0]);
          if (!user) return [[]];
          const lockUntil = user.lockedUntil ? new Date(user.lockedUntil) : null;
          return [[{
            userId: user.userId,
            username: user.username,
            passwordHash: user.passwordHash,
            role: user.role,
            failedLoginAttempts: user.failedLoginAttempts,
            lockedUntil: lockUntil,
            isActive: user.isActive,
            lockActive: lockUntil && lockUntil > new Date() ? 1 : 0,
            lockExpired: lockUntil && lockUntil <= new Date() ? 1 : 0,
          }]];
        }
        if (sql.includes("UPDATE customer_users") && sql.includes("failed_login_attempts = ?")) {
          const customerUser = database.customerUsers.find((entry) => entry.customerId === params[3]);
          stagedCustomerUser = {
            ...customerUser,
            failedLoginAttempts: params[0],
            lockedUntil: params[1] >= params[2]
              ? new Date(Date.now() + 15 * 60 * 1000)
              : null,
          };
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("UPDATE customer_users SET failed_login_attempts = 0")) {
          const customerUser = database.customerUsers.find((entry) => entry.customerId === params[0]);
          stagedCustomerUser = { ...customerUser, failedLoginAttempts: 0, lockedUntil: null };
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("SET failed_login_attempts = ?,")) {
          assert.equal((sql.match(/\?/g) || []).length, params.length);
          const user = database.users.find((entry) => entry.userId === params[3]);
          stagedUser = {
            ...user,
            failedLoginAttempts: params[0],
            lockedUntil: params[1] >= params[2]
              ? new Date(Date.now() + 15 * 60 * 1000)
              : null,
          };
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("SET failed_login_attempts = 0")) {
          const user = database.users.find((entry) => entry.userId === params[0]);
          stagedUser = { ...user, failedLoginAttempts: 0, lockedUntil: null };
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("SELECT user_id AS userId, role, is_active AS isActive")) {
          const user = database.users.find((entry) => entry.userId === params[0]);
          return [user ? [{ userId: user.userId, role: user.role, isActive: user.isActive }] : []];
        }
        if (sql.includes("SELECT user_id FROM staff_users WHERE role = 'ADMIN'")) {
          return [[...database.users.filter((entry) => entry.role === "ADMIN" && entry.isActive)
            .map((entry) => ({ user_id: entry.userId }))]];
        }
        if (sql.includes("UPDATE staff_users SET role = ?")) {
          const user = database.users.find((entry) => entry.userId === params[1]);
          stagedUser = { ...user, role: params[0] };
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("SELECT account_id, status FROM accounts")) {
          return [[database.account.account_number === params[0]
            ? { account_id: database.account.account_id, status: database.account.status }
            : null].filter(Boolean)];
        }
        if (sql.includes("SELECT account_id, customer_id FROM accounts")) {
          return [[database.account.account_number === params[0]
            ? { account_id: database.account.account_id, customer_id: database.account.customer_id }
            : null].filter(Boolean)];
        }
        if (sql.includes("UPDATE customers SET full_name = ?")) {
          database.pendingCustomer = {
            ...database.customer,
            full_name: params[0],
            fullName: params[0],
            address: params[1],
            phone: params[2],
          };
          return [{ affectedRows: 1 }];
        }
        if (sql.includes("UPDATE accounts SET status = 'INACTIVE'")) {
          database.pendingAccountStatus = { accountId: params[0], status: "INACTIVE" };
          return [{ affectedRows: 1 }];
        }
        throw new Error(`Unexpected auth connection query: ${sql}`);
      },
      async commit() {
        if (stagedUser) {
          const index = database.users.findIndex((entry) => entry.userId === stagedUser.userId);
          database.users[index] = stagedUser;
        }
        if (stagedCustomerUser) {
          const index = database.customerUsers.findIndex(
            (entry) => entry.customerId === stagedCustomerUser.customerId
          );
          database.customerUsers[index] = stagedCustomerUser;
        }
        if (database.pendingAccountStatus) {
          database.account.status = database.pendingAccountStatus.status;
          database.pendingAccountStatus = null;
        }
        if (database.pendingCustomer) {
          database.customer = database.pendingCustomer;
          database.pendingCustomer = null;
        }
        database.auditEvents.push(...stagedAuditEvents);
      },
      async rollback() {},
      release() {
        unlock?.();
        unlock = null;
      },
    };
  }

  async execute(sql, params) {
    if (sql.includes("INSERT INTO security_audit_logs")) {
      if (this.failAuditWrite) {
        const error = new Error("simulated audit write failure");
        error.code = "TEST_AUDIT_FAILURE";
        throw error;
      }
      this.auditEvents.push({
        eventType: params[0],
        outcome: params[1],
        actorUserId: params[2],
        actorRole: params[3],
        targetType: params[4],
        targetId: params[5],
        createdAt: new Date(),
      });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("FROM security_audit_logs")) {
      return [[...this.auditEvents].reverse().slice(0, params[0])];
    }
    if (sql.includes("SELECT customer_id AS customerId, username") && sql.includes("FROM customer_users")) {
      const customerUser = this.customerUsers.find(
        (entry) => entry.customerId === Number(params[0]) && entry.isActive
      );
      return [customerUser ? [{
        customerId: customerUser.customerId,
        username: customerUser.username,
      }] : []];
    }
    if (sql.includes("SELECT customer_id FROM customers WHERE customer_id = ?")) {
      return [params[0] === this.customer.customerId ? [{ customer_id: params[0] }] : []];
    }
    if (sql.includes("SELECT user_id FROM staff_users WHERE username = ?")) {
      return [this.users.some((user) => user.username === params[0]) ? [{ user_id: 1 }] : []];
    }
    if (sql.includes("INSERT INTO customer_users")) {
      if (this.customerUsers.some((user) => user.customerId === params[0] || user.username === params[1])) {
        const error = new Error("Duplicate customer username or identity.");
        error.code = "ER_DUP_ENTRY";
        throw error;
      }
      this.customerUsers.push({
        customerId: params[0],
        username: params[1],
        passwordHash: params[2],
        failedLoginAttempts: 0,
        lockedUntil: null,
        isActive: 1,
      });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("SELECT account_number AS accountNumber, balance, status")) {
      const account = params[0] === this.account.account_number
        ? this.account
        : params[0] === this.otherAccount.accountNumber
          ? this.otherAccount
          : null;
      if (!account) return [[]];
      const accountCustomerId = account.customer_id ?? account.customerId;
      if (params[1] !== null && params[1] !== accountCustomerId) return [[]];
      return [[{
        accountNumber: account.account_number || account.accountNumber,
        balance: account.balance,
        status: account.status,
      }]];
    }
    if (sql.includes("FROM transactions") && sql.includes("account_id = (")) {
      const isOtherAccount = params[0] === this.otherAccount.accountNumber;
      if (isOtherAccount) return [[]];
      return [this.transactions.filter((transaction) =>
        params[1] === null ||
        (transaction.customerId ?? this.customer.customerId) === params[1]
      )];
    }
    if (sql.includes("FROM transactions t") && sql.includes("WHERE t.transaction_ref = ?")) {
      const transaction = this.transactions.find((item) => item.transactionRef === params[0]);
      const transactionOwner = transaction?.customerId ?? this.customer.customerId;
      if (!transaction || (params[1] !== null && transactionOwner !== params[1])) return [[]];
      return [[transaction]];
    }
    if (sql.includes("FROM accounts a") && sql.includes("ORDER BY a.created_at DESC")) {
      const search = String(params[0] || "").toLowerCase();
      const customerId = params[3];
      const accountResults = [{
        accountId: this.account.accountId,
        accountNumber: this.account.accountNumber,
        balance: this.account.balance,
        status: this.account.status,
        createdAt: this.account.createdAt,
        customerId: this.customer.customerId,
        fullName: this.customer.fullName,
        address: this.customer.address,
        phone: this.customer.phone,
      }, {
        ...this.otherAccount,
        fullName: this.otherCustomer.fullName,
        phone: this.otherCustomer.phone,
      }];
      return [accountResults.filter((account) =>
        (customerId === null || account.customerId === customerId) &&
        (!search ||
          String(account.accountNumber).toLowerCase().includes(search) ||
          String(account.fullName).toLowerCase().includes(search))
      )];
    }
    if (sql.includes("FROM accounts a") && sql.includes("WHERE a.account_number = ?")) {
      const isOwnAccount = params[0] === this.account.accountNumber;
      const isOtherAccount = params[0] === this.otherAccount.accountNumber;
      if (!isOwnAccount && !isOtherAccount) return [[]];
      const customerId = isOwnAccount ? this.customer.customerId : this.otherAccount.customerId;
      if (params[1] !== null && params[1] !== customerId) return [[]];
      return [[isOwnAccount ? {
        accountId: this.account.accountId,
        accountNumber: this.account.accountNumber,
        balance: this.account.balance,
        status: this.account.status,
        createdAt: this.account.createdAt,
        customerId: this.customer.customerId,
        fullName: this.customer.fullName,
        address: this.customer.address,
        phone: this.customer.phone,
      } : {
        ...this.otherAccount,
        address: this.otherCustomer.address,
        fullName: this.otherCustomer.fullName,
        phone: this.otherCustomer.phone,
      }]];
    }
    if (sql.includes("transactionCount")) {
      return [[{ transactionCount: 2, totalDeposits: "500.00", totalWithdrawals: "100.00" }]];
    }
    if (sql.includes("activeAccountCount")) {
      return [[{ activeAccountCount: 1, totalBalance: "500.00" }]];
    }
    if (sql.includes("SELECT data FROM user_sessions")) {
      if (this.failSessionRead) {
        const error = new Error(`Simulated session-store failure for ${params[0]}`);
        error.code = "TEST_SESSION_STORE_FAILURE";
        throw error;
      }
      const stored = this.sessions.get(params[0]);
      return [[stored && stored.expires > Math.floor(Date.now() / 1000) ? { data: stored.data } : null].filter(Boolean)];
    }
    if (sql.includes("INSERT INTO user_sessions")) {
      this.sessions.set(params[0], { expires: Number(params[1]), data: params[2] });
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("UPDATE user_sessions SET expires = ?")) {
      const stored = this.sessions.get(params[2]);
      if (stored) {
        stored.expires = Number(params[0]);
        stored.data = params[1];
      }
      return [{ affectedRows: stored ? 1 : 0 }];
    }
    if (sql.includes("DELETE FROM user_sessions WHERE session_id = ? AND expires <= UNIX_TIMESTAMP()")) {
      const stored = this.sessions.get(params[0]);
      if (stored && stored.expires <= Math.floor(Date.now() / 1000)) {
        this.sessions.delete(params[0]);
      }
      return [{ affectedRows: stored ? 1 : 0 }];
    }
    if (sql.includes("DELETE FROM user_sessions WHERE session_id")) {
      this.sessions.delete(params[0]);
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("DELETE FROM user_sessions WHERE session_id")) {
      this.sessions.delete(params[0]);
      return [{ affectedRows: 1 }];
    }
    if (sql.includes("DELETE FROM user_sessions WHERE expires <= UNIX_TIMESTAMP()")) {
      return [{ affectedRows: 0 }];
    }
    if (sql.includes("INSERT INTO staff_users")) {
      const [username, passwordHash, role] = params;
      const newUser = {
        userId: Math.max(0, ...this.users.map((user) => user.userId)) + 1,
        username,
        passwordHash,
        role,
        failedLoginAttempts: 0,
        lockedUntil: null,
        isActive: 1,
      };
      this.users.push(newUser);
      return [{ insertId: newUser.userId }];
    }
    if (sql.includes("WHERE user_id = ? AND is_active = 1")) {
      const user = this.users.find((entry) => entry.userId === Number(params[0]) && entry.isActive);
      return [user ? [{ userId: user.userId, username: user.username, role: user.role }] : []];
    }
    if (sql.includes("FROM staff_users") && sql.includes("ORDER BY username")) {
      return [[...this.users].map((user) => ({
        userId: user.userId,
        username: user.username,
        role: user.role,
        isActive: user.isActive,
        failedLoginAttempts: user.failedLoginAttempts,
        lockedUntil: user.lockedUntil,
        createdAt: new Date("2026-01-01T00:00:00.000Z"),
      }))];
    }
    throw new Error(`Unexpected auth pool query: ${sql}`);
  }

  async query(sql) {
    if (sql.includes("SELECT 1 AS connected")) return [[{ connected: 1 }]];
    throw new Error(`Unexpected auth query: ${sql}`);
  }
}

async function startApi(database, transactionReferenceGenerator, { userId = 41 } = {}) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { userId, role: "ADMIN" };
    next();
  });
  app.use("/api/transactions", createTransactionRouter(
    database,
    transactionReferenceGenerator ? { transactionReferenceGenerator } : undefined
  ));
  app.use("/api/reports", createReportRouter(database));
  const server = app.listen(0);
  await once(server, "listening");
  return {
    baseUrl: `http://127.0.0.1:${server.address().port}/api/transactions`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
}

async function withApi(database, run) {
  const api = await startApi(database);
  try {
    await run(api.baseUrl);
  } finally {
    await api.close();
  }
}

async function withAccountApi(database, run) {
  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    req.user = { userId: 41, role: "ADMIN" };
    next();
  });
  app.use("/api/accounts", createAccountRouter(database));
  const server = app.listen(0);
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}/api/accounts`;
  try {
    await run(baseUrl);
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function withAuthApi(database, run, { persistentSessions = false } = {}) {
  const sessionStore = persistentSessions
    ? new MySQLSessionStore(database, { cleanupIntervalMs: 60 * 60 * 1000 })
    : new session.MemoryStore();
  const app = createApp({
    databasePool: database,
    sessionStore,
    sessionSecret: "test-session-secret-that-is-at-least-32-characters",
    secureCookie: false,
  });
  const server = app.listen(0);
  await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${server.address().port}/api`;
  try {
    await run(baseUrl);
  } finally {
    sessionStore.close?.();
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
}

async function makeAuthUser({ role = "STAFF", failedLoginAttempts = 0, lockedUntil = null } = {}) {
  return {
    userId: 41,
    username: "operator.one",
    passwordHash: await bcrypt.hash("Correct-Horse-Battery-42!", 4),
    role,
    failedLoginAttempts,
    lockedUntil,
    isActive: 1,
  };
}

async function login(baseUrl, username = "operator.one", password = "Correct-Horse-Battery-42!") {
  return fetch(`${baseUrl}/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
  });
}

function sessionCookie(response) {
  return response.headers.get("set-cookie")?.split(";")[0];
}

async function post(baseUrl, path, body, idempotencyKey) {
  const headers = { "Content-Type": "application/json" };
  if (idempotencyKey !== undefined) headers["Idempotency-Key"] = idempotencyKey;
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

test("deposit updates the balance and returns a complete transaction receipt", async () => {
  const database = new FakePool();
  await withApi(database, async (baseUrl) => {
    const result = await post(baseUrl, "/deposit", { accountNumber: ACCOUNT_NUMBER, amount: 500.25 });
    assert.equal(result.status, 201);
    assert.equal(result.body.account.balance, "2000.25");
    assert.match(result.body.transaction.transactionRef, /^[0-9a-f-]{36}$/i);
    assert.equal(result.body.transaction.type, "DEPOSIT");
    assert.equal(result.body.transaction.amount, "500.25");
    assert.equal(result.body.transaction.balanceAfter, "2000.25");
    assert.ok(result.body.transaction.createdAt);
    assert.equal(result.body.transaction.transactionRef, database.transactions[0].transaction_ref);
    assert.equal(database.transactions.length, 1);
    assert.equal(database.transactions[0].transaction_type, "DEPOSIT");
    assert.equal(database.transactions[0].amount, "500.25");
    assert.equal(database.transactions[0].balance_after, "2000.25");
    assert.equal(database.transactionLifecycle.commits, 1);
    assert.equal(database.transactionLifecycle.rollbacks, 0);
    assert.equal(database.transactionLifecycle.releases, 1);

    const inquiry = await fetch(`${baseUrl}?accountNumber=${ACCOUNT_NUMBER}`);
    const inquiryResult = await inquiry.json();
    assert.equal(inquiry.status, 200);
    assert.deepEqual(inquiryResult.account, {
      accountNumber: ACCOUNT_NUMBER,
      balance: "2000.25",
      status: "ACTIVE",
    });
  });
});

test("zero, negative, and malformed deposit amounts are rejected", async () => {
  const database = new FakePool();
  await withApi(database, async (baseUrl) => {
    for (const amount of [0, -1, "100.00", "1e2", null, {}]) {
      const result = await post(baseUrl, "/deposit", { accountNumber: ACCOUNT_NUMBER, amount });
      assert.equal(result.status, 400);
    }
    assert.equal(database.account.balance, "1500.00");
    assert.equal(database.transactions.length, 0);
  });
});

test("amounts with more than two decimal places are rejected", async () => {
  const database = new FakePool();
  await withApi(database, async (baseUrl) => {
    const result = await post(baseUrl, "/deposit", { accountNumber: ACCOUNT_NUMBER, amount: 10.001 });
    assert.equal(result.status, 400);
    assert.equal(database.account.balance, "1500.00");
    assert.equal(database.transactions.length, 0);
  });
});

test("amounts beyond the supported monetary range are rejected", async () => {
  const database = new FakePool();
  await withApi(database, async (baseUrl) => {
    const result = await post(baseUrl, "/deposit", { accountNumber: ACCOUNT_NUMBER, amount: 10000000000 });
    assert.equal(result.status, 400);
    assert.equal(database.account.balance, "1500.00");
    assert.equal(database.transactions.length, 0);
  });
});

test("withdrawal may leave exactly the minimum balance", async () => {
  const database = new FakePool({ balance: "2500.00" });
  await withApi(database, async (baseUrl) => {
    const result = await post(baseUrl, "/withdraw", { accountNumber: ACCOUNT_NUMBER, amount: 1500 });
    assert.equal(result.status, 201);
    assert.equal(result.body.account.balance, "1000.00");
    assert.equal(result.body.transaction.amount, "1500.00");
    assert.equal(result.body.transaction.balanceAfter, "1000.00");
    assert.equal(result.body.transaction.type, "WITHDRAWAL");
    assert.ok(result.body.transaction.transactionRef);
    assert.ok(result.body.transaction.createdAt);
    assert.equal(result.body.transaction.transactionRef, database.transactions[0].transaction_ref);
    assert.equal(database.transactions[0].transaction_type, "WITHDRAWAL");
    assert.equal(database.transactions[0].amount, "1500.00");
    assert.equal(database.transactions[0].balance_after, "1000.00");
    assert.equal(database.transactionLifecycle.commits, 1);
    assert.equal(database.transactionLifecycle.rollbacks, 0);
    assert.equal(database.transactionLifecycle.releases, 1);

    const inquiry = await fetch(`${baseUrl}?accountNumber=${ACCOUNT_NUMBER}`);
    const inquiryResult = await inquiry.json();
    assert.equal(inquiry.status, 200);
    assert.deepEqual(inquiryResult.account, {
      accountNumber: ACCOUNT_NUMBER,
      balance: "1000.00",
      status: "ACTIVE",
    });
  });
});

test("duplicate transaction references are retried for deposits and withdrawals", async () => {
  const existingReference = "00000000-0000-4000-8000-000000000001";
  const newReference = "00000000-0000-4000-8000-000000000002";
  for (const [path, amount, expectedType] of [
    ["/deposit", 100, "DEPOSIT"],
    ["/withdraw", 100, "WITHDRAWAL"],
  ]) {
    const database = new FakePool({
      balance: "2500.00",
      duplicateTransactionRefs: [existingReference],
    });
    const candidates = [existingReference, newReference];
    const api = await startApi(database, () => candidates.shift());
    try {
      const result = await post(api.baseUrl, path, { accountNumber: ACCOUNT_NUMBER, amount });
      assert.equal(result.status, 201);
      assert.equal(result.body.transaction.transactionRef, newReference);
      assert.equal(result.body.transaction.type, expectedType);
      assert.equal(database.transactions.length, 1);
      assert.equal(database.transactions[0].transaction_ref, newReference);
    } finally {
      await api.close();
    }
  }
});

test("transaction-reference collisions are bounded and roll back without a receipt", async () => {
  const existingReference = "00000000-0000-4000-8000-000000000001";
  const database = new FakePool({
    balance: "2500.00",
    duplicateTransactionRefs: [existingReference],
  });
  let generatedCount = 0;
  const api = await startApi(database, () => {
    generatedCount += 1;
    return existingReference;
  });
  try {
    const result = await post(api.baseUrl, "/deposit", {
      accountNumber: ACCOUNT_NUMBER,
      amount: 100,
    });
    assert.equal(result.status, 500);
    assert.equal(generatedCount, 5);
    assert.equal(database.account.balance, "2500.00");
    assert.equal(database.transactions.length, 0);
    assert.equal(result.body.transaction, undefined);
  } finally {
    await api.close();
  }
});

test("duplicate references are rejected by the mocked transaction_ref unique index", async () => {
  const existingReference = "00000000-0000-4000-8000-000000000001";
  const database = new FakePool({
    duplicateTransactionRefs: [existingReference],
  });
  const api = await startApi(database, () => existingReference);
  try {
    const result = await post(api.baseUrl, "/deposit", {
      accountNumber: ACCOUNT_NUMBER,
      amount: 100,
    });
    assert.equal(result.status, 500);
    assert.equal(database.account.balance, "1500.00");
    assert.equal(database.transactions.length, 0);
  } finally {
    await api.close();
  }
});

test("unrelated duplicate-key errors are not retried as reference collisions", async () => {
  const existingReference = "00000000-0000-4000-8000-000000000001";
  const database = new FakePool({
    failDuplicateInsert: true,
    duplicateTransactionRefs: [existingReference],
  });
  let generatedCount = 0;
  const api = await startApi(database, () => {
    generatedCount += 1;
    return existingReference;
  });
  try {
    const result = await post(api.baseUrl, "/deposit", {
      accountNumber: ACCOUNT_NUMBER,
      amount: 100,
    });
    assert.equal(result.status, 500);
    assert.equal(generatedCount, 1);
    assert.equal(database.account.balance, "1500.00");
    assert.equal(database.transactions.length, 0);
  } finally {
    await api.close();
  }
});

test("withdrawal may leave more than the minimum balance", async () => {
  const database = new FakePool({ balance: "1500.00" });
  await withApi(database, async (baseUrl) => {
    const result = await post(baseUrl, "/withdraw", { accountNumber: ACCOUNT_NUMBER, amount: 499.99 });
    assert.equal(result.status, 201);
    assert.equal(result.body.account.balance, "1000.01");
    assert.equal(database.transactions.length, 1);
    assert.equal(database.transactions[0].balance_after, "1000.01");
  });
});

test("withdrawal below the minimum balance is rejected", async () => {
  const database = new FakePool({ balance: "1999.99" });
  await withApi(database, async (baseUrl) => {
    const result = await post(baseUrl, "/withdraw", { accountNumber: ACCOUNT_NUMBER, amount: 1000 });
    assert.equal(result.status, 422);
    assert.match(result.body.message, /below ₹1,000\.00/);
    assert.equal(database.account.balance, "1999.99");
    assert.equal(database.transactions.length, 0);
  });
});

test("withdrawal that would leave ₹999.99 is rejected without recording a transaction", async () => {
  const database = new FakePool({ balance: "1500.00" });
  await withApi(database, async (baseUrl) => {
    const result = await post(baseUrl, "/withdraw", { accountNumber: ACCOUNT_NUMBER, amount: 500.01 });
    assert.equal(result.status, 422);
    assert.equal(database.account.balance, "1500.00");
    assert.equal(database.transactions.length, 0);
  });
});

test("invalid and non-positive withdrawal amounts are rejected", async () => {
  const database = new FakePool();
  await withApi(database, async (baseUrl) => {
    for (const amount of [0, -1, 10.001, "100.00", null]) {
      const result = await post(baseUrl, "/withdraw", { accountNumber: ACCOUNT_NUMBER, amount });
      assert.equal(result.status, 400);
    }
    const missingAccountNumber = await post(baseUrl, "/withdraw", { amount: 100 });
    assert.equal(missingAccountNumber.status, 400);
    const malformedAccountNumber = await post(baseUrl, "/withdraw", { accountNumber: "123", amount: 100 });
    assert.equal(malformedAccountNumber.status, 400);
    assert.equal(database.account.balance, "1500.00");
    assert.equal(database.transactions.length, 0);
  });
});

test("malformed and injection-shaped transaction identifiers never reach the database", async () => {
  const database = new FakePool();
  await withApi(database, async (baseUrl) => {
    const invalidAccountNumber = await post(baseUrl, "/deposit", {
      accountNumber: "7811288401' OR 1=1 --",
      amount: 100,
    });
    assert.equal(invalidAccountNumber.status, 400);

    const injectedQuery = await fetch(
      `${baseUrl}?accountNumber=${encodeURIComponent("7811288401' OR 1=1 --")}`
    );
    assert.equal(injectedQuery.status, 400);

    const invalidReference = await fetch(
      `${baseUrl}/${encodeURIComponent("00000000-0000-4000-8000-000000000001' OR 1=1 --")}`
    );
    assert.equal(invalidReference.status, 400);
    assert.equal(database.transactionLifecycle.begins, 0);
    assert.equal(database.account.balance, "1500.00");
    assert.equal(database.transactions.length, 0);
  });
});

test("malformed withdrawal JSON is rejected with a client error", async () => {
  const database = new FakeAuthPool([await makeAuthUser()]);
  await withAuthApi(database, async (baseUrl) => {
    const loggedIn = await login(baseUrl);
    const response = await fetch(`${baseUrl}/transactions/withdraw`, {
      method: "POST",
      headers: {
        Cookie: sessionCookie(loggedIn),
        "Content-Type": "application/json",
      },
      body: "{",
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).message, "Invalid JSON request body.");
  });
});

test("withdrawal that would make the balance negative is rejected", async () => {
  const database = new FakePool({ balance: "1500.00" });
  await withApi(database, async (baseUrl) => {
    const result = await post(baseUrl, "/withdraw", { accountNumber: ACCOUNT_NUMBER, amount: 2000 });
    assert.equal(result.status, 422);
    assert.equal(database.account.balance, "1500.00");
  });
});

test("unknown accounts are rejected", async () => {
  const database = new FakePool();
  await withApi(database, async (baseUrl) => {
    const result = await post(baseUrl, "/deposit", { accountNumber: "0000000000", amount: 100 });
    assert.equal(result.status, 404);
    const withdrawal = await post(baseUrl, "/withdraw", { accountNumber: "0000000000", amount: 100 });
    assert.equal(withdrawal.status, 404);
    assert.equal(database.account.balance, "1500.00");
    assert.equal(database.transactions.length, 0);
  });
});

test("protected routes reject unauthenticated access, insufficient permissions, and malformed admin bodies", async () => {
  const staffDatabase = new FakeAuthPool([await makeAuthUser({ role: "STAFF" })]);
  await withAuthApi(staffDatabase, async (baseUrl) => {
    const unauthenticated = await fetch(`${baseUrl}/accounts`);
    assert.equal(unauthenticated.status, 401);

    const staffSession = await login(baseUrl);
    const insufficientPermissions = await fetch(`${baseUrl}/admin/staff`, {
      method: "POST",
      headers: {
        Cookie: sessionCookie(staffSession),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ username: "new.staff", password: "Correct-Horse-Battery-42!", role: "STAFF" }),
    });
    assert.equal(insufficientPermissions.status, 403);
  });

  const adminDatabase = new FakeAuthPool([await makeAuthUser({ role: "ADMIN" })]);
  await withAuthApi(adminDatabase, async (baseUrl) => {
    const loggedIn = await login(baseUrl);
    const malformed = await fetch(`${baseUrl}/admin/staff`, {
      method: "POST",
      headers: {
        Cookie: sessionCookie(loggedIn),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(["bad-input"]),
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.json()).message, "Provide a valid username, a password of at least 12 characters and at most 72 bytes, and an allowed role.");
  });
});

test("inactive accounts cannot transact", async () => {
  const database = new FakePool({ status: "INACTIVE" });
  await withApi(database, async (baseUrl) => {
    const result = await post(baseUrl, "/deposit", { accountNumber: ACCOUNT_NUMBER, amount: 100 });
    assert.equal(result.status, 409);
    assert.equal(database.account.balance, "1500.00");
  });
});

test("inactive accounts cannot be withdrawn from", async () => {
  const database = new FakePool({ status: "INACTIVE" });
  await withApi(database, async (baseUrl) => {
    const result = await post(baseUrl, "/withdraw", { accountNumber: ACCOUNT_NUMBER, amount: 100 });
    assert.equal(result.status, 409);
    assert.match(result.body.message, /inactive account/);
    assert.equal(database.account.balance, "1500.00");
    assert.equal(database.transactions.length, 0);
  });
});

test("failed record insertion rolls back the balance update", async () => {
  const database = new FakePool({ failInsert: true });
  await withApi(database, async (baseUrl) => {
    const result = await post(baseUrl, "/deposit", { accountNumber: ACCOUNT_NUMBER, amount: 100 });
    assert.equal(result.status, 500);
    assert.equal(result.body.transaction, undefined);
    assert.equal(database.account.balance, "1500.00");
    assert.equal(database.transactions.length, 0);
    assert.equal(database.transactionLifecycle.rollbacks, 1);
    assert.equal(database.transactionLifecycle.releases, 1);
  });
});

test("commit failures roll back without returning a receipt or logging database details", async () => {
  const database = new FakePool({ failCommit: true });
  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (...values) => loggedErrors.push(values.join(" "));

  try {
    await withApi(database, async (baseUrl) => {
      const result = await post(baseUrl, "/deposit", {
        accountNumber: ACCOUNT_NUMBER,
        amount: 100,
      });
      assert.equal(result.status, 500);
      assert.match(result.body.message, /could not be completed/i);
      assert.equal(result.body.transaction, undefined);
      assert.equal(JSON.stringify(result.body).includes("private-test-marker"), false);
      assert.equal(JSON.stringify(result.body).includes("TEST_COMMIT_FAILURE"), false);
      assert.equal(JSON.stringify(result.body).includes("stack"), false);
      assert.equal(database.account.balance, "1500.00");
      assert.equal(database.transactions.length, 0);
      assert.equal(database.transactionLifecycle.begins, 1);
      assert.equal(database.transactionLifecycle.commits, 1);
      assert.equal(database.transactionLifecycle.rollbacks, 1);
      assert.equal(database.transactionLifecycle.releases, 1);
    });
  } finally {
    console.error = originalConsoleError;
  }

  assert.ok(loggedErrors.some((message) => message.includes("TEST_COMMIT_FAILURE")));
  assert.ok(!loggedErrors.join("\n").includes("private-test-marker"));
});

test("failed receipt lookup rolls back a deposit and does not record a transaction", async () => {
  const database = new FakePool({ hideTransactionReceipt: true });
  await withApi(database, async (baseUrl) => {
    const result = await post(baseUrl, "/deposit", { accountNumber: ACCOUNT_NUMBER, amount: 100 });
    assert.equal(result.status, 500);
    assert.match(result.body.message, /could not be completed/i);
    assert.equal(database.account.balance, "1500.00");
    assert.equal(database.transactions.length, 0);
    assert.equal(database.transactionLifecycle.rollbacks, 1);
    assert.equal(database.transactionLifecycle.releases, 1);
  });
});

test("failed withdrawal record insertion rolls back the balance update", async () => {
  const database = new FakePool({ balance: "2500.00", failInsert: true });
  await withApi(database, async (baseUrl) => {
    const result = await post(baseUrl, "/withdraw", { accountNumber: ACCOUNT_NUMBER, amount: 500 });
    assert.equal(result.status, 500);
    assert.match(result.body.message, /could not be completed/i);
    assert.equal(database.account.balance, "2500.00");
    assert.equal(database.transactions.length, 0);
    assert.equal(database.transactionLifecycle.rollbacks, 1);
    assert.equal(database.transactionLifecycle.releases, 1);
  });
});

test("history returns the stored transaction records", async () => {
  const database = new FakePool();
  database.transactions.push({
    transaction_ref: "c6b7164e-10fd-46b2-8e6c-3a7fd24025ec",
    account_id: 1,
    transaction_type: "DEPOSIT",
    amount: "500.00",
    balance_after: "2000.00",
    created_at: new Date("2026-01-02T03:04:05.000Z"),
  });
  await withApi(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}?accountNumber=${ACCOUNT_NUMBER}`);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.account.balance, "1500.00");
    assert.equal(result.transactions.length, 1);
    assert.equal(result.transactions[0].transactionRef, database.transactions[0].transaction_ref);
    assert.equal(result.transactions[0].type, "DEPOSIT");
    assert.equal(result.transactions[0].amount, "500.00");
    assert.equal(result.transactions[0].balanceAfter, "2000.00");
    assert.equal(result.transactions[0].createdAt, "2026-01-02T03:04:05.000Z");
  });
});

test("history is ordered newest first with stable ties and limited to the latest 50 records", async () => {
  const database = new FakePool();
  for (let sequence = 1; sequence <= 55; sequence += 1) {
    database.transactions.push({
      transaction_ref: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
      account_id: 1,
      transaction_type: "DEPOSIT",
      amount: "1.00",
      balance_after: "1501.00",
      created_at: new Date(Date.UTC(2026, 0, 2, 3, 4, sequence === 54 ? 55 : sequence)),
    });
  }

  await withApi(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}?accountNumber=${ACCOUNT_NUMBER}`);
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.transactions.length, 50);
    assert.equal(result.transactions[0].transactionRef.endsWith("000000000055"), true);
    assert.equal(result.transactions[1].transactionRef.endsWith("000000000054"), true);
    assert.equal(result.transactions.at(-1).transactionRef.endsWith("000000000006"), true);
    assert.match(database.historyQuery.sql, /ORDER BY created_at DESC,\s*transaction_ref DESC\s+LIMIT 50/);
    assert.deepEqual(database.historyQuery.params, [ACCOUNT_NUMBER, null, null]);
  });
});

test("concurrent withdrawals cannot spend the same balance", async () => {
  const database = new FakePool({ balance: "2500.00" });
  await withApi(database, async (baseUrl) => {
    const results = await Promise.all([
      post(baseUrl, "/withdraw", { accountNumber: ACCOUNT_NUMBER, amount: 1500 }),
      post(baseUrl, "/withdraw", { accountNumber: ACCOUNT_NUMBER, amount: 1500 }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 422]);
    assert.equal(database.account.balance, "1000.00");
    assert.equal(database.transactions.length, 1);
    assert.equal(database.transactions[0].balance_after, "1000.00");
  });
});

test("concurrent deposits preserve both balance changes and transaction records", async () => {
  const database = new FakePool({ balance: "1500.00" });
  await withApi(database, async (baseUrl) => {
    const results = await Promise.all([
      post(baseUrl, "/deposit", { accountNumber: ACCOUNT_NUMBER, amount: 100 }),
      post(baseUrl, "/deposit", { accountNumber: ACCOUNT_NUMBER, amount: 200 }),
    ]);
    assert.deepEqual(results.map((result) => result.status), [201, 201]);
    assert.equal(database.account.balance, "1800.00");
    assert.equal(database.transactions.length, 2);
    assert.deepEqual(
      database.transactions.map((transaction) => transaction.balance_after).sort(),
      ["1600.00", "1800.00"]
    );
  });
});

test("concurrent withdrawals collectively preserve the minimum balance", async () => {
  const database = new FakePool({ balance: "2600.00" });
  await withApi(database, async (baseUrl) => {
    const results = await Promise.all([
      post(baseUrl, "/withdraw", { accountNumber: ACCOUNT_NUMBER, amount: 1000 }),
      post(baseUrl, "/withdraw", { accountNumber: ACCOUNT_NUMBER, amount: 1000 }),
    ]);
    assert.deepEqual(results.map((result) => result.status).sort(), [201, 422]);
    assert.equal(database.account.balance, "1600.00");
    assert.equal(database.transactions.length, 1);
    assert.equal(database.transactions[0].balance_after, "1600.00");
  });
});

test("concurrent submissions with one idempotency key commit one transaction and share its receipt", async () => {
  const database = new FakePool();
  const request = () => post(
    api.baseUrl,
    "/deposit",
    { accountNumber: ACCOUNT_NUMBER, amount: 250 },
    "same-logical-request-1"
  );
  const api = await startApi(database);
  try {
    const results = await Promise.all([request(), request()]);
    assert.deepEqual(results.map((result) => result.status), [201, 201]);
    assert.deepEqual(results[0].body, results[1].body);
    assert.equal(database.account.balance, "1750.00");
    assert.equal(database.transactions.length, 1);
    assert.equal(database.idempotencyRecords.size, 1);
  } finally {
    await api.close();
  }
});

test("repeated idempotent submissions return the original committed receipt", async () => {
  const database = new FakePool();
  const firstApi = await startApi(database);
  let original;
  try {
    original = await post(
      firstApi.baseUrl,
      "/deposit",
      { accountNumber: ACCOUNT_NUMBER, amount: 125 },
      "persisted-request-2"
    );
    assert.equal(original.status, 201);
  } finally {
    await firstApi.close();
  }

  const restartedApi = await startApi(database);
  try {
    const repeated = await post(
      restartedApi.baseUrl,
      "/deposit",
      { accountNumber: ACCOUNT_NUMBER, amount: 125 },
      "persisted-request-2"
    );
    assert.equal(repeated.status, 201);
    assert.deepEqual(repeated.body, original.body);
    assert.equal(database.account.balance, "1625.00");
    assert.equal(database.transactions.length, 1);
  } finally {
    await restartedApi.close();
  }
});

test("reusing an idempotency key with different parameters is rejected", async () => {
  const database = new FakePool();
  await withApi(database, async (baseUrl) => {
    const first = await post(
      baseUrl,
      "/deposit",
      { accountNumber: ACCOUNT_NUMBER, amount: 100 },
      "parameter-check-3"
    );
    const reused = await post(
      baseUrl,
      "/deposit",
      { accountNumber: ACCOUNT_NUMBER, amount: 200 },
      "parameter-check-3"
    );
    assert.equal(first.status, 201);
    assert.equal(reused.status, 409);
    assert.equal(reused.body.transaction, undefined);
    assert.equal(database.account.balance, "1600.00");
    assert.equal(database.transactions.length, 1);
  });
});

test("idempotency keys are scoped by operation and authenticated user", async () => {
  const database = new FakePool();
  const api = await startApi(database);
  try {
    const deposit = await post(
      api.baseUrl,
      "/deposit",
      { accountNumber: ACCOUNT_NUMBER, amount: 100 },
      "scoped-request-6"
    );
    const withdrawal = await post(
      api.baseUrl,
      "/withdraw",
      { accountNumber: ACCOUNT_NUMBER, amount: 100 },
      "scoped-request-6"
    );
    assert.equal(deposit.status, 201);
    assert.equal(withdrawal.status, 201);
  } finally {
    await api.close();
  }

  const otherUserApi = await startApi(database, undefined, { userId: 42 });
  try {
    const otherUser = await post(
      otherUserApi.baseUrl,
      "/deposit",
      { accountNumber: ACCOUNT_NUMBER, amount: 100 },
      "scoped-request-6"
    );
    assert.equal(otherUser.status, 201);
    assert.equal(database.transactions.length, 3);
    assert.equal(database.idempotencyRecords.size, 3);
  } finally {
    await otherUserApi.close();
  }
});

test("malformed idempotency keys are rejected before opening a database transaction", async () => {
  const database = new FakePool();
  await withApi(database, async (baseUrl) => {
    const whitespace = await post(
      baseUrl,
      "/deposit",
      { accountNumber: ACCOUNT_NUMBER, amount: 100 },
      "invalid key"
    );
    const tooLong = await post(
      baseUrl,
      "/deposit",
      { accountNumber: ACCOUNT_NUMBER, amount: 100 },
      "k".repeat(129)
    );
    assert.equal(whitespace.status, 400);
    assert.equal(tooLong.status, 400);
    assert.equal(database.transactionLifecycle.begins, 0);
    assert.equal(database.account.balance, "1500.00");
    assert.equal(database.transactions.length, 0);
  });
});

test("failed idempotent operations roll back the reservation with the balance update", async () => {
  const database = new FakePool({ failInsert: true });
  await withApi(database, async (baseUrl) => {
    const result = await post(
      baseUrl,
      "/deposit",
      { accountNumber: ACCOUNT_NUMBER, amount: 100 },
      "rollback-request-4"
    );
    assert.equal(result.status, 500);
    assert.equal(result.body.transaction, undefined);
    assert.equal(database.account.balance, "1500.00");
    assert.equal(database.transactions.length, 0);
    assert.equal(database.idempotencyRecords.size, 0);
  });
});

test("lock timeouts return a retry-safe error without applying a transaction", async () => {
  const database = new FakePool({ failAccountLock: true });
  await withApi(database, async (baseUrl) => {
    const result = await post(
      baseUrl,
      "/deposit",
      { accountNumber: ACCOUNT_NUMBER, amount: 100 },
      "lock-timeout-request-5"
    );
    assert.equal(result.status, 503);
    assert.equal(result.body.transaction, undefined);
    assert.equal(database.account.balance, "1500.00");
    assert.equal(database.transactions.length, 0);
    assert.equal(database.idempotencyRecords.size, 0);
    assert.equal(database.transactionLifecycle.rollbacks, 1);
    assert.equal(database.transactionLifecycle.releases, 1);
  });
});

test("reports return transaction totals and the current active account count", async () => {
  const database = new FakePool();
  await withApi(database, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl.replace("/api/transactions", "/api/reports")}?startDate=2026-01-01&endDate=2026-01-31`
    );
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.startDate, "2026-01-01");
    assert.equal(result.endDate, "2026-01-31");
    assert.equal(result.transactionCount, 4);
    assert.equal(result.totalDeposits, "1500.00");
    assert.equal(result.totalWithdrawals, "250.00");
    assert.equal(result.activeAccountCount, 3);
    assert.equal(result.totalBalance, "6250.00");
    assert.match(database.reportQuery.sql, /created_at >= \?/);
    assert.match(database.reportQuery.sql, /created_at < DATE_ADD\(\?, INTERVAL 1 DAY\)/);
    assert.deepEqual(database.reportQuery.params, ["2026-01-01", "2026-01-31"]);
    assert.match(database.reportAccountQuery.sql, /WHERE status = 'ACTIVE'/);
    assert.equal(database.reportAccountQuery.params, undefined);
  });
});

test("reports include both selected dates for same-day and multi-day ranges", async () => {
  const database = new FakePool();
  await withApi(database, async (baseUrl) => {
    const reportsUrl = baseUrl.replace("/api/transactions", "/api/reports");
    const sameDay = await fetch(`${reportsUrl}?startDate=2026-01-31&endDate=2026-01-31`);
    assert.equal(sameDay.status, 200);
    assert.deepEqual(database.reportQuery.params, ["2026-01-31", "2026-01-31"]);
    assert.match(database.reportQuery.sql, /created_at < DATE_ADD\(\?, INTERVAL 1 DAY\)/);

    const multiDay = await fetch(`${reportsUrl}?startDate=2026-01-30&endDate=2026-02-01`);
    assert.equal(multiDay.status, 200);
    assert.deepEqual(database.reportQuery.params, ["2026-01-30", "2026-02-01"]);
  });
});

test("empty report ranges return zero transaction totals and the current account count", async () => {
  const database = new FakePool({
    reportSummary: {
      transactionCount: 0,
      totalDeposits: "0.00",
      totalWithdrawals: "0.00",
    },
  });
  await withApi(database, async (baseUrl) => {
    const response = await fetch(
      `${baseUrl.replace("/api/transactions", "/api/reports")}?startDate=2026-01-01&endDate=2026-01-01`
    );
    const result = await response.json();

    assert.equal(response.status, 200);
    assert.equal(result.transactionCount, 0);
    assert.equal(result.totalDeposits, "0.00");
    assert.equal(result.totalWithdrawals, "0.00");
    assert.equal(result.activeAccountCount, 3);
  });
});

test("reports reject missing, malformed, reversed, and overlong date ranges before querying", async () => {
  const database = new FakePool();
  await withApi(database, async (baseUrl) => {
    const reportsUrl = baseUrl.replace("/api/transactions", "/api/reports");
    const invalidRanges = [
      ["", "Provide a valid start and end date, with startDate no later than endDate."],
      ["?startDate=2026-02-30&endDate=2026-03-01", "Provide a valid start and end date, with startDate no later than endDate."],
      ["?startDate=2026-03-02&endDate=2026-03-01", "Provide a valid start and end date, with startDate no later than endDate."],
      ["?startDate=2025-01-01&endDate=2026-01-03", "Report date range cannot exceed 367 days."],
      ["?startDate=2026-01-01&endDate=", "Provide a valid start and end date, with startDate no later than endDate."],
    ];

    for (const [query, message] of invalidRanges) {
      const response = await fetch(`${reportsUrl}${query}`);
      assert.equal(response.status, 400);
      assert.equal((await response.json()).message, message);
    }
    assert.equal(database.reportQuery, null);
    assert.equal(database.reportAccountQuery, null);
  });
});

test("account opening commits customer, account, and opening deposit atomically", async () => {
  const database = new FakeAccountPool();
  await withAccountApi(database, async (baseUrl) => {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "New Test Customer",
        address: "1 Test Road",
        phone: "9876543210",
        idProofType: "PAN",
        idProofNumber: "TEST12345",
        initialDeposit: 500,
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 201);
    assert.match(result.account.accountNumber, /^\d{10}$/);
    assert.equal(database.committed, true);
    assert.equal(database.accounts.length, 1);
    assert.equal(database.transactions.length, 1);
    assert.equal(result.account.balance, "500.00");

    const searchResponse = await fetch(`${baseUrl}?search=${result.account.accountNumber}`);
    const searchResult = await searchResponse.json();
    assert.equal(searchResponse.status, 200);
    assert.equal(searchResult.accounts.length, 1);
    assert.equal(searchResult.accounts[0].accountNumber, result.account.accountNumber);
  });
});

test("invalid customer and account inputs are rejected before database operations", async () => {
  const database = new FakeAccountPool();
  await withAccountApi(database, async (baseUrl) => {
    const validFields = {
      fullName: "New Test Customer",
      address: "1 Test Road",
      phone: "9876543210",
      idProofType: "PAN",
      idProofNumber: "TEST12345",
      initialDeposit: 500,
    };
    const invalidBodies = [
      { ...validFields, fullName: "  " },
      { ...validFields, fullName: "A".repeat(101) },
      { ...validFields, address: "A".repeat(256) },
      { ...validFields, address: "Road\nInjection" },
      { ...validFields, phone: "not-a-phone" },
      { ...validFields, idProofType: "PAN' OR 1=1 --" },
      { ...validFields, idProofNumber: "X".repeat(101) },
      { ...validFields, initialDeposit: 499.99 },
      { ...validFields, initialDeposit: 500.001 },
      { ...validFields, initialDeposit: 10000000000 },
      { ...validFields, initialDeposit: "500" },
    ];
    for (const body of invalidBodies) {
      const response = await fetch(baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
      assert.equal(typeof (await response.json()).message, "string");
    }

    const invalidJsonShape = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "null",
    });
    assert.equal(invalidJsonShape.status, 400);
    assert.equal(database.connectionRequests, 0);
    assert.equal(database.queryCount, 0);
    assert.equal(database.accounts.length, 0);
    assert.equal(database.transactions.length, 0);
    assert.equal(database.committed, false);
  });
});

test("duplicate ID proof registrations are rejected before any account record is created", async () => {
  class DuplicateIdProofPool extends FakeAccountPool {
    constructor() {
      super();
      this.accountInsertAttempts = 0;
    }

    async getConnection() {
      const database = this;
      let stagedAccount;
      let stagedTransaction;
      return {
        async beginTransaction() {},
        async execute(sql, params) {
          if (sql.includes("INSERT INTO customers")) {
            const error = new Error("Duplicate entry 'TEST12345' for key 'uq_customer_id_proof'");
            error.code = "ER_DUP_ENTRY";
            throw error;
          }
          if (sql.includes("INSERT INTO accounts")) {
            database.accountInsertAttempts += 1;
            stagedAccount = {
              accountId: 21,
              accountNumber: params[0],
              balance: params[2],
              status: "ACTIVE",
              customerId: 12,
              fullName: "New Test Customer",
              phone: "9876543210",
            };
            return [{ affectedRows: 1 }];
          }
          if (sql.includes("SELECT account_id FROM accounts")) return [[{ account_id: 21 }]];
          if (sql.includes("INSERT INTO transactions")) {
            stagedTransaction = {
              transactionRef: params[0],
              accountId: params[1],
              type: "DEPOSIT",
              amount: params[2],
              balanceAfter: params[3],
            };
            return [{ affectedRows: 1 }];
          }
          throw new Error(`Unexpected duplicate-ID query: ${sql}`);
        },
        async commit() {
          database.accounts.push(stagedAccount);
          database.transactions.push(stagedTransaction);
          database.committed = true;
        },
        async rollback() {
          stagedAccount = undefined;
          stagedTransaction = undefined;
        },
        release() {},
      };
    }
  }

  const database = new DuplicateIdProofPool();
  await withAccountApi(database, async (baseUrl) => {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "New Test Customer",
        address: "1 Test Road",
        phone: "9876543210",
        idProofType: "PAN",
        idProofNumber: "TEST12345",
        initialDeposit: 500,
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 409);
    assert.equal(result.message, "This ID proof is already registered.");
    assert.equal(database.accountInsertAttempts, 0);
    assert.equal(database.accounts.length, 0);
    assert.equal(database.transactions.length, 0);
    assert.equal(database.committed, false);
  });
});

test("account opening rolls back the customer and account if the opening deposit insert fails", async () => {
  class FailingOpeningPool extends FakeAccountPool {
    async getConnection() {
      const database = this;
      let stagedAccount;
      let stagedTransaction;
      return {
        async beginTransaction() {},
        async execute(sql, params) {
          if (sql.includes("INSERT INTO customers")) return [{ insertId: 12 }];
          if (sql.includes("INSERT INTO accounts")) {
            stagedAccount = {
              accountId: 21,
              accountNumber: params[0],
              balance: params[2],
              status: "ACTIVE",
              customerId: 12,
              fullName: "New Test Customer",
              phone: "9876543210",
            };
            return [{ affectedRows: 1 }];
          }
          if (sql.includes("SELECT account_id FROM accounts")) return [[{ account_id: 21 }]];
          if (sql.includes("INSERT INTO transactions")) {
            const error = new Error("simulated opening-deposit failure");
            error.code = "TEST_OPENING_FAILURE";
            throw error;
          }
          throw new Error(`Unexpected failing opening query: ${sql}`);
        },
        async commit() {
          database.accounts.push(stagedAccount);
          database.transactions.push(stagedTransaction);
          database.committed = true;
        },
        async rollback() {
          stagedAccount = undefined;
          stagedTransaction = undefined;
        },
        release() {},
      };
    }
  }

  const database = new FailingOpeningPool();
  await withAccountApi(database, async (baseUrl) => {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "New Test Customer",
        address: "1 Test Road",
        phone: "9876543210",
        idProofType: "PAN",
        idProofNumber: "TEST12345",
        initialDeposit: 500,
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 500);
    assert.equal(result.message, "Account creation failed. Please try again.");
    assert.equal(database.accounts.length, 0);
    assert.equal(database.transactions.length, 0);
    assert.equal(database.committed, false);
  });
});

test("account number collisions are retried and the final record still matches the required format", async () => {
  class CollisionAccountPool extends FakeAccountPool {
    constructor() {
      super();
      this.accountInsertAttempts = 0;
      this.attemptedAccountNumbers = [];
    }

    async getConnection() {
      const database = this;
      let stagedAccount;
      let stagedTransaction;
      return {
        async beginTransaction() {},
        async execute(sql, params) {
          if (sql.includes("INSERT INTO customers")) return [{ insertId: 12 }];
          if (sql.includes("INSERT INTO accounts")) {
            database.accountInsertAttempts += 1;
            database.attemptedAccountNumbers.push(params[0]);
            if (database.accountInsertAttempts === 1) {
              const error = new Error("Duplicate entry '7811288401' for key 'uq_account_number'");
              error.code = "ER_DUP_ENTRY";
              throw error;
            }
            stagedAccount = {
              accountId: 21,
              accountNumber: params[0],
              balance: params[2],
              status: "ACTIVE",
              customerId: 12,
              fullName: "New Test Customer",
              phone: "9876543210",
            };
            return [{ affectedRows: 1 }];
          }
          if (sql.includes("SELECT account_id FROM accounts")) return [[{ account_id: 21 }]];
          if (sql.includes("INSERT INTO transactions")) {
            stagedTransaction = {
              transactionRef: params[0],
              accountId: params[1],
              type: "DEPOSIT",
              amount: params[2],
              balanceAfter: params[3],
            };
            return [{ affectedRows: 1 }];
          }
          throw new Error(`Unexpected collision query: ${sql}`);
        },
        async commit() {
          database.accounts.push(stagedAccount);
          database.transactions.push(stagedTransaction);
          database.committed = true;
        },
        async rollback() {
          stagedAccount = undefined;
          stagedTransaction = undefined;
        },
        release() {},
      };
    }
  }

  const database = new CollisionAccountPool();
  await withAccountApi(database, async (baseUrl) => {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "New Test Customer",
        address: "1 Test Road",
        phone: "9876543210",
        idProofType: "PAN",
        idProofNumber: "TEST12345",
        initialDeposit: 500,
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 201);
    assert.match(result.account.accountNumber, /^\d{10}$/);
    assert.equal(database.accountInsertAttempts, 2);
    assert.equal(database.attemptedAccountNumbers.length, 2);
    assert.ok(database.attemptedAccountNumbers.every((number) => /^\d{10}$/.test(number)));
    assert.equal(database.accounts.length, 1);
    assert.equal(database.transactions.length, 1);
    assert.equal(database.committed, true);
  });
});

test("account-number retry limit rolls back the opening transaction after five collisions", async () => {
  class RepeatedCollisionPool extends FakeAccountPool {
    constructor() {
      super();
      this.customers = [];
      this.accountInsertAttempts = 0;
      this.rollbackCount = 0;
    }

    async getConnection() {
      const database = this;
      let stagedCustomer;
      let stagedAccount;
      let stagedTransaction;
      return {
        async beginTransaction() {},
        async execute(sql) {
          if (sql.includes("INSERT INTO customers")) {
            stagedCustomer = { customerId: 12 };
            return [{ insertId: 12 }];
          }
          if (sql.includes("INSERT INTO accounts")) {
            database.accountInsertAttempts += 1;
            const error = new Error("Duplicate entry for key 'uq_account_number'");
            error.code = "ER_DUP_ENTRY";
            throw error;
          }
          if (sql.includes("SELECT account_id FROM accounts")) return [[{ account_id: 21 }]];
          if (sql.includes("INSERT INTO transactions")) {
            stagedTransaction = { transactionRef: "unexpected" };
            return [{ affectedRows: 1 }];
          }
          throw new Error(`Unexpected retry-limit query: ${sql}`);
        },
        async commit() {
          database.customers.push(stagedCustomer);
          database.accounts.push(stagedAccount);
          database.transactions.push(stagedTransaction);
          database.committed = true;
        },
        async rollback() {
          database.rollbackCount += 1;
          stagedCustomer = undefined;
          stagedAccount = undefined;
          stagedTransaction = undefined;
        },
        release() {},
      };
    }
  }

  const database = new RepeatedCollisionPool();
  await withAccountApi(database, async (baseUrl) => {
    const response = await fetch(baseUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "New Test Customer",
        address: "1 Test Road",
        phone: "9876543210",
        idProofType: "PAN",
        idProofNumber: "TEST12345",
        initialDeposit: 500,
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 503);
    assert.equal(result.message, "Could not generate an account number. Please retry.");
    assert.equal(database.accountInsertAttempts, 5);
    assert.equal(database.rollbackCount, 1);
    assert.equal(database.customers.length, 0);
    assert.equal(database.accounts.length, 0);
    assert.equal(database.transactions.length, 0);
    assert.equal(database.committed, false);
  });
});

test("account directory searches by account number or customer name", async () => {
  const database = new FakeAccountPool();
  database.accounts = [
    { accountId: 1, accountNumber: "7811288401", fullName: "Asha Sharma" },
    { accountId: 2, accountNumber: "7811288402", fullName: "Ravi Kumar" },
  ];

  await withAccountApi(database, async (baseUrl) => {
    const accountSearch = await fetch(`${baseUrl}?search=88401`);
    assert.equal(accountSearch.status, 200);
    assert.deepEqual(
      (await accountSearch.json()).accounts.map((account) => account.accountNumber),
      ["7811288401"]
    );

    const nameSearch = await fetch(`${baseUrl}?search=asha`);
    assert.equal(nameSearch.status, 200);
    assert.deepEqual(
      (await nameSearch.json()).accounts.map((account) => account.fullName),
      ["Asha Sharma"]
    );

    const tooLongSearch = await fetch(`${baseUrl}?search=${"a".repeat(101)}`);
    assert.equal(tooLongSearch.status, 400);
    assert.match((await tooLongSearch.json()).message, /100 characters or fewer/);
  });
});

test("account directory rejects repeated search values before querying", async () => {
  const database = new FakeAccountPool();
  await withAccountApi(database, async (baseUrl) => {
    const repeatedSearch = await fetch(`${baseUrl}?search=asha&search=1`);
    assert.equal(repeatedSearch.status, 400);
    assert.equal(database.queryCount, 0);
  });
});

test("account details return customer and account fields and missing accounts return 404", async () => {
  const database = new FakeCustomerAccountPool();
  await withAccountApi(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/${ACCOUNT_NUMBER}`);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result.account, {
      accountId: 21,
      accountNumber: ACCOUNT_NUMBER,
      balance: "2500.00",
      status: "ACTIVE",
      createdAt: database.account.createdAt.toISOString(),
      customerId: 12,
      fullName: "Asha Sharma",
      address: "1 Old Road",
      phone: "9876543210",
    });

    const missing = await fetch(`${baseUrl}/0000000000`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).message, "Account not found.");
  });
});

test("customer detail updates persist supported fields without changing account identifiers", async () => {
  const database = new FakeCustomerAccountPool();
  await withAccountApi(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/${ACCOUNT_NUMBER}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        fullName: "Asha Patel",
        address: "2 New Road",
        phone: "+91 (987) 654-3210",
        accountNumber: "0000000000",
        customerId: 999,
      }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result.account, {
      accountNumber: ACCOUNT_NUMBER,
      customerId: 12,
      fullName: "Asha Patel",
      address: "2 New Road",
      phone: "+919876543210",
    });
    assert.equal(database.customer.fullName, "Asha Patel");
    assert.equal(database.customer.address, "2 New Road");
    assert.equal(database.customer.phone, "+919876543210");
    assert.equal(database.account.accountNumber, ACCOUNT_NUMBER);
    assert.equal(database.account.customerId, 12);
    assert.equal(database.commitCount, 1);
    assert.deepEqual(database.auditEvents.map((event) => ({
      eventType: event.eventType,
      outcome: event.outcome,
      actorUserId: event.actorUserId,
      actorRole: event.actorRole,
      targetType: event.targetType,
      targetId: event.targetId,
    })), [{
      eventType: "ACCOUNT_EDIT_SUCCESS",
      outcome: "SUCCESS",
      actorUserId: 41,
      actorRole: "ADMIN",
      targetType: "account",
      targetId: ACCOUNT_NUMBER,
    }]);

    const refreshed = await fetch(`${baseUrl}/${ACCOUNT_NUMBER}`);
    const refreshedResult = await refreshed.json();
    assert.equal(refreshedResult.account.fullName, "Asha Patel");
    assert.equal(refreshedResult.account.address, "2 New Road");
    assert.equal(refreshedResult.account.phone, "+919876543210");
  });
});

test("customer detail updates reject invalid fields and missing accounts without committing", async () => {
  const database = new FakeCustomerAccountPool();
  await withAccountApi(database, async (baseUrl) => {
    const invalidBodies = [
      { fullName: "", address: "New Road", phone: "9876543210" },
      { fullName: "Asha", address: "New Road", phone: "not-a-phone" },
      { fullName: "Asha", address: "New Road", phone: "+123456789012345" },
      { fullName: "A".repeat(101), address: "New Road", phone: "9876543210" },
    ];
    for (const body of invalidBodies) {
      const response = await fetch(`${baseUrl}/${ACCOUNT_NUMBER}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      assert.equal(response.status, 400);
    }

    const missing = await fetch(`${baseUrl}/0000000000`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Asha", address: "New Road", phone: "9876543210" }),
    });
    assert.equal(missing.status, 404);
    assert.equal(database.customer.fullName, "Asha Sharma");
    assert.equal(database.customer.address, "1 Old Road");
    assert.equal(database.commitCount, 0);
  });
});

test("failed customer detail updates roll back without partial changes", async () => {
  const database = new FakeCustomerAccountPool({ failCustomerUpdate: true });
  await withAccountApi(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/${ACCOUNT_NUMBER}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Changed Name", address: "Changed Road", phone: "9876543211" }),
    });
    assert.equal(response.status, 500);
    assert.equal(database.customer.fullName, "Asha Sharma");
    assert.equal(database.customer.address, "1 Old Road");
    assert.equal(database.customer.phone, "9876543210");
    assert.equal(database.commitCount, 0);
    assert.equal(database.rollbackCount, 1);
  });
});

test("account edits roll back when their audit event cannot be persisted", async () => {
  const database = new FakeCustomerAccountPool({ failAuditWrite: true });
  await withAccountApi(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/${ACCOUNT_NUMBER}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fullName: "Changed Name", address: "Changed Road", phone: "9876543211" }),
    });
    assert.equal(response.status, 500);
    assert.equal(database.customer.fullName, "Asha Sharma");
    assert.equal(database.commitCount, 0);
    assert.equal(database.rollbackCount, 1);
    assert.deepEqual(database.auditEvents, []);
  });
});

test("account deactivation preserves customer and history and rejects repeats or missing accounts", async () => {
  const database = new FakeCustomerAccountPool();
  await withAccountApi(database, async (baseUrl) => {
    const deactivate = (accountNumber) => fetch(`${baseUrl}/${accountNumber}/deactivate`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    const response = await deactivate(ACCOUNT_NUMBER);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "INACTIVE");
    assert.equal(database.account.status, "INACTIVE");
    assert.equal(database.customer.fullName, "Asha Sharma");
    assert.equal(database.transactions.length, 1);
    assert.deepEqual(database.auditEvents.map((event) => ({
      eventType: event.eventType,
      outcome: event.outcome,
      actorUserId: event.actorUserId,
      actorRole: event.actorRole,
      targetType: event.targetType,
      targetId: event.targetId,
    })), [{
      eventType: "ACCOUNT_DEACTIVATION_SUCCESS",
      outcome: "SUCCESS",
      actorUserId: 41,
      actorRole: "ADMIN",
      targetType: "account",
      targetId: ACCOUNT_NUMBER,
    }]);

    const repeated = await deactivate(ACCOUNT_NUMBER);
    assert.equal(repeated.status, 409);
    const missing = await deactivate("0000000000");
    assert.equal(missing.status, 404);
    assert.equal(database.commitCount, 1);
  });
});

test("inactive accounts retain accessible transaction history", async () => {
  const database = new FakePool({ status: "INACTIVE" });
  database.transactions.push({
    transaction_ref: "c6b7164e-10fd-46b2-8e6c-3a7fd24025ec",
    account_id: 1,
    transaction_type: "DEPOSIT",
    amount: "500.00",
    balance_after: "2000.00",
    created_at: new Date("2026-01-02T03:04:05.000Z"),
  });
  await withApi(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}?accountNumber=${ACCOUNT_NUMBER}`);
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.account.status, "INACTIVE");
    assert.equal(result.transactions.length, 1);
  });
});

test("authenticated staff can view, edit, and deactivate customer accounts", async () => {
  const database = new FakeAuthPool([await makeAuthUser()]);
  await withAuthApi(database, async (baseUrl) => {
    const loggedIn = await login(baseUrl);
    const headers = { Cookie: sessionCookie(loggedIn), "Content-Type": "application/json" };

    const viewed = await fetch(`${baseUrl}/accounts/${ACCOUNT_NUMBER}`, { headers });
    assert.equal(viewed.status, 200);
    assert.equal((await viewed.json()).account.fullName, "Asha Sharma");

    const edited = await fetch(`${baseUrl}/accounts/${ACCOUNT_NUMBER}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ fullName: "Asha Patel", address: "2 New Road", phone: "9876543211" }),
    });
    assert.equal(edited.status, 200);
    assert.equal(database.customer.full_name, "Asha Patel");

    const deactivated = await fetch(`${baseUrl}/accounts/${ACCOUNT_NUMBER}/deactivate`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(deactivated.status, 200);
    assert.equal(database.account.status, "INACTIVE");
  });
});

test("missing or unsupported roles cannot access banking or administrative routes", async () => {
  for (const invalidRole of [null, "SUPERADMIN"]) {
    const user = await makeAuthUser({ role: invalidRole });
    if (invalidRole === null) user.role = undefined;
    const database = new FakeAuthPool([user]);
    await withAuthApi(database, async (baseUrl) => {
      const loggedIn = await login(baseUrl);
      assert.equal(loggedIn.status, 200);
      const headers = {
        Cookie: sessionCookie(loggedIn),
        "Content-Type": "application/json",
      };
      const requests = [
        fetch(`${baseUrl}/accounts`, { headers }),
        fetch(`${baseUrl}/accounts/${ACCOUNT_NUMBER}`, { headers }),
        fetch(`${baseUrl}/transactions?accountNumber=${ACCOUNT_NUMBER}`, { headers }),
        fetch(`${baseUrl}/transactions/00000000-0000-4000-8000-000000000001`, { headers }),
        fetch(`${baseUrl}/reports?startDate=2026-01-01&endDate=2026-01-31`, { headers }),
        fetch(`${baseUrl}/admin/staff`, { headers }),
        fetch(`${baseUrl}/accounts/${ACCOUNT_NUMBER}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({
            fullName: "Unauthorized Change",
            address: "2 New Road",
            phone: "9876543211",
          }),
        }),
        fetch(`${baseUrl}/accounts/${ACCOUNT_NUMBER}/deactivate`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ confirm: true }),
        }),
        fetch(`${baseUrl}/transactions/deposit`, {
          method: "POST",
          headers,
          body: JSON.stringify({ accountNumber: ACCOUNT_NUMBER, amount: 100 }),
        }),
        fetch(`${baseUrl}/transactions/withdraw`, {
          method: "POST",
          headers,
          body: JSON.stringify({ accountNumber: ACCOUNT_NUMBER, amount: 100 }),
        }),
        fetch(`${baseUrl}/admin/accounts/${ACCOUNT_NUMBER}/deactivate`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ confirm: true }),
        }),
      ];
      const responses = await Promise.all(requests);
      assert.ok(responses.every((response) => response.status === 403));
      assert.equal(database.account.balance, "2500.00");
      assert.equal(database.account.status, "ACTIVE");
      assert.equal(database.customer.fullName, "Asha Sharma");
      assert.equal(database.transactions.length, 0);
    });
  }
});

test("customer sessions can read only their own account and transaction history", async () => {
  const customerPassword = "Customer-Strong-Password-42!";
  const database = new FakeAuthPool([await makeAuthUser()]);
  database.customerUsers.push({
    customerId: 62,
    username: "asha.customer",
    passwordHash: await bcrypt.hash(customerPassword, 4),
    failedLoginAttempts: 0,
    lockedUntil: null,
    isActive: 1,
  });
  database.transactions.push({
    transactionRef: "c6b7164e-10fd-46b2-8e6c-3a7fd24025ec",
    type: "DEPOSIT",
    amount: "500.00",
    balanceAfter: "2500.00",
    createdAt: new Date("2026-01-02T03:04:05.000Z"),
    customerId: 62,
  }, {
    transactionRef: "e6b7164e-10fd-46b2-8e6c-3a7fd24025ec",
    type: "DEPOSIT",
    amount: "300.00",
    balanceAfter: "3200.00",
    createdAt: new Date("2026-01-03T03:04:05.000Z"),
    customerId: 99,
  });

  await withAuthApi(database, async (baseUrl) => {
    const loggedIn = await login(baseUrl, "asha.customer", customerPassword);
    const result = await loggedIn.json();
    assert.equal(loggedIn.status, 200);
    assert.deepEqual(result.user, {
      userId: 62,
      customerId: 62,
      username: "asha.customer",
      role: "CUSTOMER",
    });

    const cookie = sessionCookie(loggedIn);
    const sessionResponse = await fetch(`${baseUrl}/auth/session`, {
      headers: { Cookie: cookie },
    });
    assert.deepEqual((await sessionResponse.json()).user, result.user);

    const accountsResponse = await fetch(`${baseUrl}/accounts`, {
      headers: { Cookie: cookie },
    });
    const accounts = await accountsResponse.json();
    assert.equal(accountsResponse.status, 200);
    assert.deepEqual(accounts.accounts.map((account) => account.accountNumber), [ACCOUNT_NUMBER]);

    const otherCustomerSearch = await fetch(
      `${baseUrl}/accounts?search=${encodeURIComponent(database.otherCustomer.fullName)}`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(otherCustomerSearch.status, 200);
    assert.deepEqual((await otherCustomerSearch.json()).accounts, []);

    const ownedAccount = await fetch(`${baseUrl}/accounts/${ACCOUNT_NUMBER}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(ownedAccount.status, 200);

    const otherAccount = await fetch(`${baseUrl}/accounts/${database.otherAccount.accountNumber}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(otherAccount.status, 404);
    assert.equal((await otherAccount.json()).message, "Account not found.");

    const ownedHistory = await fetch(`${baseUrl}/transactions?accountNumber=${ACCOUNT_NUMBER}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(ownedHistory.status, 200);
    assert.equal((await ownedHistory.json()).transactions.length, 1);

    const otherHistory = await fetch(
      `${baseUrl}/transactions?accountNumber=${database.otherAccount.accountNumber}`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(otherHistory.status, 404);
    assert.equal((await otherHistory.json()).message, "Account not found.");

    const ownedReceipt = await fetch(
      `${baseUrl}/transactions/c6b7164e-10fd-46b2-8e6c-3a7fd24025ec`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(ownedReceipt.status, 200);

    const otherReceipt = await fetch(
      `${baseUrl}/transactions/e6b7164e-10fd-46b2-8e6c-3a7fd24025ec`,
      { headers: { Cookie: cookie } }
    );
    assert.equal(otherReceipt.status, 404);
    assert.equal((await otherReceipt.json()).message, "Transaction not found.");

    const forbiddenRequests = [
      fetch(`${baseUrl}/accounts/${ACCOUNT_NUMBER}`, {
        method: "PATCH",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: "Unauthorized Change",
          address: "2 New Road",
          phone: "9876543211",
        }),
      }),
      fetch(`${baseUrl}/accounts/${ACCOUNT_NUMBER}/deactivate`, {
        method: "PATCH",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
      fetch(`${baseUrl}/accounts`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({
          fullName: "Unauthorized Account",
          address: "2 New Road",
          phone: "9876543211",
          idProofType: "PAN",
          idProofNumber: "ABCDE1234F",
          initialDeposit: 500,
        }),
      }),
      fetch(`${baseUrl}/transactions/deposit`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ accountNumber: ACCOUNT_NUMBER, amount: 100 }),
      }),
      fetch(`${baseUrl}/transactions/withdraw`, {
        method: "POST",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ accountNumber: database.otherAccount.accountNumber, amount: 100 }),
      }),
      fetch(`${baseUrl}/reports?startDate=2026-01-01&endDate=2026-01-31`, {
        headers: { Cookie: cookie },
      }),
      fetch(`${baseUrl}/admin/staff`, { headers: { Cookie: cookie } }),
      fetch(`${baseUrl}/admin/accounts/${ACCOUNT_NUMBER}/deactivate`, {
        method: "PATCH",
        headers: { Cookie: cookie, "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
    ];
    const responses = await Promise.all(forbiddenRequests);
    assert.ok(responses.every((response) => response.status === 403));
    assert.equal(database.account.balance, "2500.00");
    assert.equal(database.account.status, "ACTIVE");
    assert.equal(database.customer.fullName, "Asha Sharma");
    assert.equal(database.transactions.length, 2);
  });
});

test("administrator can provision a hashed customer login but staff cannot", async () => {
  const database = new FakeAuthPool([await makeAuthUser()]);
  await withAuthApi(database, async (baseUrl) => {
    const staffLogin = await login(baseUrl);
    const staffResponse = await fetch(`${baseUrl}/admin/customer-users`, {
      method: "POST",
      headers: {
        Cookie: sessionCookie(staffLogin),
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        customerId: 62,
        username: "asha.customer",
        password: "Customer-Strong-Password-42!",
      }),
    });
    assert.equal(staffResponse.status, 403);

    const adminDatabase = new FakeAuthPool([await makeAuthUser({ role: "ADMIN" })]);
    await withAuthApi(adminDatabase, async (adminBaseUrl) => {
      const adminLogin = await login(adminBaseUrl);
      const response = await fetch(`${adminBaseUrl}/admin/customer-users`, {
        method: "POST",
        headers: {
          Cookie: sessionCookie(adminLogin),
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          customerId: 62,
          username: "asha.customer",
          password: "Customer-Strong-Password-42!",
        }),
      });
      const body = await response.json();
      assert.equal(response.status, 201);
      assert.deepEqual(body.customer, {
        customerId: 62,
        username: "asha.customer",
        role: "CUSTOMER",
      });
      assert.equal(adminDatabase.customerUsers.length, 1);
      assert.notEqual(adminDatabase.customerUsers[0].passwordHash, "Customer-Strong-Password-42!");
      assert.equal(
        await bcrypt.compare("Customer-Strong-Password-42!", adminDatabase.customerUsers[0].passwordHash),
        true
      );
    });
  });
});

test("successful login returns a safe user and HTTP-only session cookie", async () => {
  const database = new FakeAuthPool([await makeAuthUser()]);
  await withAuthApi(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/auth/login`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: "securebank.sid=attacker-controlled-session-id",
      },
      body: JSON.stringify({ username: "operator.one", password: "Correct-Horse-Battery-42!" }),
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result.user, { userId: 41, username: "operator.one", role: "STAFF" });
    assert.match(response.headers.get("set-cookie"), /HttpOnly/i);
    assert.match(response.headers.get("set-cookie"), /SameSite=Lax/i);
    const cookieExpiry = new Date(response.headers.get("set-cookie").match(/Expires=([^;]+)/i)[1]).getTime();
    const remainingLifetime = cookieExpiry - Date.now();
    assert.ok(remainingLifetime <= 30 * 60 * 1000);
    assert.ok(remainingLifetime >= 29 * 60 * 1000);
    assert.notEqual(sessionCookie(response).split("=")[1], "attacker-controlled-session-id");
    assert.equal(JSON.stringify(result).includes("passwordHash"), false);
    assert.equal(JSON.stringify(result).includes(sessionCookie(response).split("=")[1]), false);
    assert.equal(database.auditEvents.length, 1);
    assert.equal(database.auditEvents[0].eventType, "AUTH_LOGIN_SUCCESS");
    assert.equal(database.auditEvents[0].outcome, "SUCCESS");
    assert.equal(database.auditEvents[0].actorUserId, 41);
    assert.equal(database.auditEvents[0].actorRole, "STAFF");
    assert.equal(database.auditEvents[0].targetId, null);
    assert.ok(database.auditEvents[0].createdAt instanceof Date);
    assert.equal(JSON.stringify(database.auditEvents).includes(sessionCookie(response).split("=")[1]), false);
  });
});

test("invalid credentials use the same response for unknown usernames", async () => {
  const database = new FakeAuthPool([await makeAuthUser()]);
  await withAuthApi(database, async (baseUrl) => {
    const wrongPassword = await login(baseUrl, "operator.one", "wrong-password");
    const unknownUser = await login(baseUrl, "unknown.user", "wrong-password");
    assert.equal(wrongPassword.status, 401);
    assert.equal(unknownUser.status, 401);
    assert.deepEqual(await wrongPassword.json(), await unknownUser.json());
    assert.deepEqual(database.auditEvents.map(({ eventType, outcome, actorUserId }) => ({
      eventType,
      outcome,
      actorUserId,
    })), [
      { eventType: "AUTH_LOGIN_FAILURE", outcome: "FAILURE", actorUserId: 41 },
      { eventType: "AUTH_LOGIN_FAILURE", outcome: "FAILURE", actorUserId: null },
    ]);
    assert.equal(JSON.stringify(database.auditEvents).includes("wrong-password"), false);
    assert.equal(JSON.stringify(database.auditEvents).includes("operator.one"), false);
  });
});

test("audit write failures reject login without creating a session", async () => {
  const database = new FakeAuthPool([await makeAuthUser()]);
  database.failAuditWrite = true;
  await withAuthApi(database, async (baseUrl) => {
    const response = await login(baseUrl);
    assert.equal(response.status, 503);
    assert.equal(database.sessions.size, 0);
    assert.equal(database.auditEvents.length, 0);
    assert.equal(database.users[0].failedLoginAttempts, 0);
  });
});

test("malformed login credentials are rejected with the generic response", async () => {
  const database = new FakeAuthPool([await makeAuthUser()]);
  await withAuthApi(database, async (baseUrl) => {
    const responses = await Promise.all([
      fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: 123, password: "wrong-password" }),
      }),
      fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "x", password: "wrong-password" }),
      }),
      fetch(`${baseUrl}/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "operator.one", password: "a".repeat(73) }),
      }),
    ]);
    const bodies = await Promise.all(responses.map((response) => response.json()));
    assert.deepEqual(responses.map((response) => response.status), [401, 401, 401, 401]);
    assert.ok(bodies.every((body) => body.message === bodies[0].message));
    assert.equal(database.users[0].failedLoginAttempts, 0);
    assert.equal(database.sessions.size, 0);
    assert.equal(database.auditEvents.length, 4);
    assert.ok(database.auditEvents.every((event) =>
      event.eventType === "AUTH_LOGIN_FAILURE" &&
      event.outcome === "FAILURE"
    ));
  });
});

test("three failed logins lock the user and requests are rejected during the lock", async () => {
  const user = await makeAuthUser();
  const database = new FakeAuthPool([user]);
  await withAuthApi(database, async (baseUrl) => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await login(baseUrl, user.username, "wrong-password");
      assert.equal(response.status, 401);
      assert.equal(database.users[0].failedLoginAttempts, attempt + 1);
    }
    assert.equal(database.users[0].failedLoginAttempts, 3);
    const lockDuration = database.users[0].lockedUntil.getTime() - Date.now();
    assert.ok(lockDuration > 14 * 60 * 1000);
    assert.ok(lockDuration <= 15 * 60 * 1000);
    const correctDuringLock = await login(baseUrl);
    assert.equal(correctDuringLock.status, 401);
    assert.ok(database.auditEvents.some((event) =>
      event.eventType === "AUTH_ACCOUNT_LOCKED" &&
      event.outcome === "DENIED" &&
      event.actorUserId === user.userId
    ));
  });
});

test("concurrent failed logins cannot bypass the three-attempt lock", async () => {
  const database = new FakeAuthPool([await makeAuthUser()]);
  await withAuthApi(database, async (baseUrl) => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => login(baseUrl, "operator.one", "wrong-password"))
    );
    assert.ok(responses.every((response) => response.status === 401));
    assert.equal(database.users[0].failedLoginAttempts, 3);
    const lockDuration = database.users[0].lockedUntil.getTime() - Date.now();
    assert.ok(lockDuration > 14 * 60 * 1000);
    assert.ok(lockDuration <= 15 * 60 * 1000);
    assert.equal(database.sessions.size, 0);
  });
});
test("successful login resets prior failures and an expired lock", async () => {
  const user = await makeAuthUser({
    failedLoginAttempts: 2,
    lockedUntil: new Date(Date.now() - 60_000),
  });
  const database = new FakeAuthPool([user]);
  await withAuthApi(database, async (baseUrl) => {
    const response = await login(baseUrl);
    assert.equal(response.status, 200);
    assert.equal(database.users[0].failedLoginAttempts, 0);
    assert.equal(database.users[0].lockedUntil, null);
  });
});

test("protected endpoints reject unauthenticated requests", async () => {
  const database = new FakeAuthPool([await makeAuthUser()]);
  await withAuthApi(database, async (baseUrl) => {
    const requests = [
      fetch(`${baseUrl}/accounts`),
      fetch(`${baseUrl}/accounts/${ACCOUNT_NUMBER}`),
      fetch(`${baseUrl}/accounts`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({}),
      }),
      fetch(`${baseUrl}/accounts/${ACCOUNT_NUMBER}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName: "Asha", address: "New Road", phone: "9876543210" }),
      }),
      fetch(`${baseUrl}/accounts/${ACCOUNT_NUMBER}/deactivate`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ confirm: true }),
      }),
      fetch(`${baseUrl}/transactions?accountNumber=${ACCOUNT_NUMBER}`),
      fetch(`${baseUrl}/transactions/deposit`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accountNumber: ACCOUNT_NUMBER, amount: 100 }),
      }),
      fetch(`${baseUrl}/reports?startDate=2026-01-01&endDate=2026-01-31`),
      fetch(`${baseUrl}/admin/staff`),
    ];
    const responses = await Promise.all(requests);
    assert.deepEqual(responses.map((response) => response.status), [401, 401, 401, 401, 401, 401, 401, 401, 401]);
    assert.equal((await responses[0].json()).code, "AUTH_REQUIRED");
    assert.equal(database.account.status, "ACTIVE");
    assert.equal(database.users[0].failedLoginAttempts, 0);
  });
});

test("authenticated staff can inquire about a valid account balance", async () => {
  const database = new FakeAuthPool([await makeAuthUser()]);
  await withAuthApi(database, async (baseUrl) => {
    const loggedIn = await login(baseUrl);
    assert.equal(loggedIn.status, 200);

    const response = await fetch(
      `${baseUrl}/transactions?accountNumber=${ACCOUNT_NUMBER}`,
      { headers: { Cookie: sessionCookie(loggedIn) } }
    );
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.deepEqual(result.account, {
      accountNumber: ACCOUNT_NUMBER,
      balance: "2500.00",
      status: "ACTIVE",
    });
    assert.deepEqual(result.transactions, []);

    const missing = await fetch(
      `${baseUrl}/transactions?accountNumber=0000000000`,
      { headers: { Cookie: sessionCookie(loggedIn) } }
    );
    assert.equal(missing.status, 404);

    database.account.status = "INACTIVE";
    const inactive = await fetch(
      `${baseUrl}/transactions?accountNumber=${ACCOUNT_NUMBER}`,
      { headers: { Cookie: sessionCookie(loggedIn) } }
    );
    const inactiveResult = await inactive.json();
    assert.equal(inactive.status, 200);
    assert.equal(inactiveResult.account.balance, "2500.00");
    assert.equal(inactiveResult.account.status, "INACTIVE");
  });
});

test("staff cannot access admin endpoints while admins can", async () => {
  const staffDatabase = new FakeAuthPool([await makeAuthUser()]);
  await withAuthApi(staffDatabase, async (baseUrl) => {
    const loggedIn = await login(baseUrl);
    const response = await fetch(`${baseUrl}/admin/staff`, {
      headers: { Cookie: sessionCookie(loggedIn) },
    });
    assert.equal(response.status, 403);
    const reports = await fetch(`${baseUrl}/reports?startDate=2026-01-01&endDate=2026-01-31`, {
      headers: { Cookie: sessionCookie(loggedIn) },
    });
    assert.equal(reports.status, 403);
    const auditLogs = await fetch(`${baseUrl}/admin/audit-logs`, {
      headers: { Cookie: sessionCookie(loggedIn) },
    });
    assert.equal(auditLogs.status, 403);
    assert.ok(staffDatabase.auditEvents.some((event) =>
      event.eventType === "AUTHORIZATION_DENIED" &&
      event.outcome === "DENIED" &&
      event.actorUserId === 41
    ));
    staffDatabase.failAuditWrite = true;
    const stillDenied = await fetch(`${baseUrl}/admin/audit-logs`, {
      headers: { Cookie: sessionCookie(loggedIn) },
    });
    assert.equal(stillDenied.status, 403);
  });

  const adminDatabase = new FakeAuthPool([await makeAuthUser({ role: "ADMIN" })]);
  await withAuthApi(adminDatabase, async (baseUrl) => {
    const loggedIn = await login(baseUrl);
    const response = await fetch(`${baseUrl}/admin/staff`, {
      headers: { Cookie: sessionCookie(loggedIn) },
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).staff.length, 1);
    const reports = await fetch(`${baseUrl}/reports?startDate=2026-01-01&endDate=2026-01-31`, {
      headers: { Cookie: sessionCookie(loggedIn) },
    });
    assert.equal(reports.status, 200);
    const auditLogs = await fetch(`${baseUrl}/admin/audit-logs?limit=10`, {
      headers: { Cookie: sessionCookie(loggedIn) },
    });
    assert.equal(auditLogs.status, 200);
    const auditResult = await auditLogs.json();
    assert.deepEqual(auditResult.auditLogs.map((event) => event.eventType),
      adminDatabase.auditEvents.slice(-10).reverse().map((event) => event.eventType));
    const invalidLimit = await fetch(`${baseUrl}/admin/audit-logs?limit=101`, {
      headers: { Cookie: sessionCookie(loggedIn) },
    });
    assert.equal(invalidLimit.status, 400);
  });
});

test("logout destroys the session and prevents later access", async () => {
  const database = new FakeAuthPool([await makeAuthUser()]);
  await withAuthApi(database, async (baseUrl) => {
    const loggedIn = await login(baseUrl);
    const cookie = sessionCookie(loggedIn);
    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    assert.equal(logout.status, 200);
    const protectedResponses = await Promise.all([
      fetch(`${baseUrl}/accounts`, { headers: { Cookie: cookie } }),
      fetch(`${baseUrl}/transactions?accountNumber=${ACCOUNT_NUMBER}`, { headers: { Cookie: cookie } }),
      fetch(`${baseUrl}/reports?startDate=2026-01-01&endDate=2026-01-31`, { headers: { Cookie: cookie } }),
      fetch(`${baseUrl}/admin/staff`, { headers: { Cookie: cookie } }),
    ]);
    assert.ok(protectedResponses.every((response) => response.status === 401));
    assert.ok(database.auditEvents.some((event) =>
      event.eventType === "AUTH_LOGOUT" &&
      event.actorUserId === 41
    ));
  });
});

test("MySQL session store persists, reads, touches, and destroys sessions", async () => {
  const database = new FakeAuthPool([await makeAuthUser()]);
  await withAuthApi(database, async (baseUrl) => {
    const loggedIn = await login(baseUrl);
    const cookie = sessionCookie(loggedIn);
    assert.equal(database.sessions.size, 1);
    assert.ok(Number.isInteger([...database.sessions.values()][0].expires));
    assert.match([...database.sessions.values()][0].data, /"userId":41/);
    const checked = await fetch(`${baseUrl}/auth/session`, { headers: { Cookie: cookie } });
    assert.equal(checked.status, 200);
    assert.equal((await checked.json()).user.username, "operator.one");
    const logout = await fetch(`${baseUrl}/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    assert.equal(logout.status, 200);
    assert.equal(database.sessions.size, 0);
  }, { persistentSessions: true });
});

test("expired sessions are rejected across protected routes and only their record is removed", async () => {
  const staff = await makeAuthUser();
  const otherStaff = {
    ...await makeAuthUser(),
    userId: 42,
    username: "staff.member",
  };
  const database = new FakeAuthPool([staff, otherStaff]);
  await withAuthApi(database, async (baseUrl) => {
    const expiredLogin = await login(baseUrl, "operator.one");
    const activeLogin = await login(baseUrl, "staff.member");
    const expiredCookie = sessionCookie(expiredLogin);
    const activeCookie = sessionCookie(activeLogin);
    const expiredSessionId = decodeURIComponent(expiredCookie.split("=")[1]).slice(2).split(".")[0];
    const activeSessionId = decodeURIComponent(activeCookie.split("=")[1]).slice(2).split(".")[0];
    assert.equal(expiredLogin.status, 200);
    assert.equal(activeLogin.status, 200);
    assert.equal(database.sessions.size, 2);

    database.sessions.get(expiredSessionId).expires = Math.floor(Date.now() / 1000) - 1;

    const protectedResponses = await Promise.all([
      fetch(`${baseUrl}/accounts`, { headers: { Cookie: expiredCookie } }),
      fetch(`${baseUrl}/transactions?accountNumber=${ACCOUNT_NUMBER}`, { headers: { Cookie: expiredCookie } }),
      fetch(`${baseUrl}/reports?startDate=2026-01-01&endDate=2026-01-31`, { headers: { Cookie: expiredCookie } }),
      fetch(`${baseUrl}/admin/staff`, { headers: { Cookie: expiredCookie } }),
    ]);
    assert.ok(protectedResponses.every((response) => response.status === 401));
    assert.equal(database.sessions.has(expiredSessionId), false);
    assert.equal(database.sessions.has(activeSessionId), true);

    const activeResponse = await fetch(
      `${baseUrl}/transactions?accountNumber=${ACCOUNT_NUMBER}`,
      { headers: { Cookie: activeCookie } }
    );
    assert.equal(activeResponse.status, 200);
  }, { persistentSessions: true });
});

test("invalid session identifiers are rejected by protected routes", async () => {
  const database = new FakeAuthPool([await makeAuthUser()]);
  await withAuthApi(database, async (baseUrl) => {
    const cookie = "securebank.sid=invalid-session-signature";
    const responses = await Promise.all([
      fetch(`${baseUrl}/accounts`, { headers: { Cookie: cookie } }),
      fetch(`${baseUrl}/transactions?accountNumber=${ACCOUNT_NUMBER}`, { headers: { Cookie: cookie } }),
      fetch(`${baseUrl}/reports?startDate=2026-01-01&endDate=2026-01-31`, { headers: { Cookie: cookie } }),
    ]);
    assert.ok(responses.every((response) => response.status === 401));
  });
});

test("session identifiers are not returned in response bodies or server logs", async () => {
  const database = new FakeAuthPool([await makeAuthUser()]);
  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (...args) => loggedErrors.push(args.join(" "));
  try {
    await withAuthApi(database, async (baseUrl) => {
      const loggedIn = await login(baseUrl);
      const sessionId = sessionCookie(loggedIn).split("=")[1];
      const body = await loggedIn.json();
      assert.equal(JSON.stringify(body).includes(sessionId), false);

      database.failSessionRead = true;
      const failedRequest = await fetch(`${baseUrl}/accounts`, {
        headers: { Cookie: sessionCookie(loggedIn) },
      });
      const failureBody = await failedRequest.text();
      assert.equal(failedRequest.status, 500);
      assert.equal(failureBody.includes(sessionId), false);
      assert.equal(loggedErrors.join(" ").includes(sessionId), false);
    }, { persistentSessions: true });
  } finally {
    console.error = originalConsoleError;
  }
});

test("admin can create staff, change another user's role, and deactivate an account", async () => {
  const admin = await makeAuthUser({ role: "ADMIN" });
  const staff = { ...await makeAuthUser(), userId: 42, username: "staff.member" };
  const database = new FakeAuthPool([admin, staff]);
  await withAuthApi(database, async (baseUrl) => {
    const loggedIn = await login(baseUrl);
    const cookie = sessionCookie(loggedIn);
    const headers = { Cookie: cookie, "Content-Type": "application/json" };

    const created = await fetch(`${baseUrl}/admin/staff`, {
      method: "POST",
      headers,
      body: JSON.stringify({ username: "new.staff", password: "Long-Unique-Password-123", role: "STAFF" }),
    });
    assert.equal(created.status, 201);
    assert.notEqual(database.users[2].passwordHash, "Long-Unique-Password-123");
    assert.equal(await bcrypt.compare("Long-Unique-Password-123", database.users[2].passwordHash), true);

    const changedRole = await fetch(`${baseUrl}/admin/staff/42/role`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ role: "ADMIN" }),
    });
    assert.equal(changedRole.status, 200);
    assert.equal(database.users[1].role, "ADMIN");

    const deactivated = await fetch(`${baseUrl}/admin/accounts/${ACCOUNT_NUMBER}/deactivate`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ confirm: true }),
    });
    assert.equal(deactivated.status, 200);
    assert.equal(database.account.status, "INACTIVE");
  });
});

test("session check reports a stale session cookie explicitly", async () => {
  const database = new FakeAuthPool([await makeAuthUser()]);
  await withAuthApi(database, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/auth/session`, {
      headers: { Cookie: "securebank.sid=invalid-session-signature" },
    });
    const result = await response.json();
    assert.equal(response.status, 200);
    assert.equal(result.user, null);
    assert.equal(result.sessionExpired, true);
  });
});

test("admin staff creation rejects passwords exceeding bcrypt's byte limit", async () => {
  const database = new FakeAuthPool([await makeAuthUser({ role: "ADMIN" })]);
  await withAuthApi(database, async (baseUrl) => {
    const loggedIn = await login(baseUrl);
    const response = await fetch(`${baseUrl}/admin/staff`, {
      method: "POST",
      headers: { Cookie: sessionCookie(loggedIn), "Content-Type": "application/json" },
      body: JSON.stringify({ username: "long.pass", password: "a".repeat(73), role: "STAFF" }),
    });
    assert.equal(response.status, 400);
    assert.equal(database.users.length, 1);
  });
});
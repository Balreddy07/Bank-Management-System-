const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { once } = require("node:events");
const bcrypt = require("bcrypt");
const session = require("express-session");
const test = require("node:test");
const { createApp } = require("../src/app");

const SEED_PASSWORD = "security-seed-password";
const CREATED_PASSWORD = "security-created-password";
const seedPasswordHash = bcrypt.hash(SEED_PASSWORD, 12);

class MemorySessionStore extends session.Store {
  constructor() {
    super();
    this.sessions = new Map();
  }

  get(sessionId, callback) {
    callback(null, structuredClone(this.sessions.get(sessionId) || null));
  }

  set(sessionId, sessionData, callback) {
    this.sessions.set(sessionId, structuredClone(sessionData));
    callback?.(null);
  }

  touch(sessionId, sessionData, callback) {
    this.sessions.set(sessionId, structuredClone(sessionData));
    callback?.(null);
  }

  destroy(sessionId, callback) {
    this.sessions.delete(sessionId);
    callback?.(null);
  }
}

function createSecurityDatabase(passwordHash) {
  const staffUsers = [
    {
      userId: 1,
      username: "admin.test",
      passwordHash,
      role: "ADMIN",
      failedLoginAttempts: 0,
      lockedUntil: null,
      isActive: 1,
    },
    {
      userId: 2,
      username: "staff.test",
      passwordHash,
      role: "STAFF",
      failedLoginAttempts: 0,
      lockedUntil: null,
      isActive: 1,
    },
  ];
  const customerUsers = [{
    customerId: 101,
    username: "customer.test",
    passwordHash,
    failedLoginAttempts: 0,
    lockedUntil: null,
    isActive: 1,
  }];
  const accounts = [
    {
      accountId: 201,
      accountNumber: "1000000001",
      customerId: 101,
      balance: "500.00",
      status: "ACTIVE",
      fullName: "Synthetic Customer One",
      address: "Test Address One",
      phone: "9000000001",
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      accountId: 202,
      accountNumber: "1000000002",
      customerId: 102,
      balance: "900.00",
      status: "ACTIVE",
      fullName: "Synthetic Customer Two",
      address: "Test Address Two",
      phone: "9000000002",
      createdAt: "2026-01-02T00:00:00.000Z",
    },
  ];
  const calls = [];
  const auditEvents = [];
  let failAccountQuery = false;

  async function execute(statement, parameters = []) {
    const sql = statement.replace(/\s+/g, " ").trim();
    calls.push({ sql, parameters });

    if (sql.startsWith("INSERT INTO security_audit_logs")) {
      auditEvents.push(parameters);
      return [{ affectedRows: 1 }, []];
    }

    if (sql.startsWith("SELECT") && sql.includes("FROM staff_users") && sql.includes("WHERE username = ?")) {
      const user = staffUsers.find((candidate) => candidate.username === parameters[0]);
      return [[user ? {
        userId: user.userId,
        username: user.username,
        passwordHash: user.passwordHash,
        role: user.role,
        failedLoginAttempts: user.failedLoginAttempts,
        lockedUntil: user.lockedUntil,
        isActive: user.isActive,
        lockActive: 0,
        lockExpired: 0,
      } : null].filter(Boolean), []];
    }

    if (sql.startsWith("SELECT") && sql.includes("FROM customer_users") && sql.includes("WHERE username = ?")) {
      const user = customerUsers.find((candidate) => candidate.username === parameters[0]);
      return [[user ? {
        customerId: user.customerId,
        username: user.username,
        passwordHash: user.passwordHash,
        failedLoginAttempts: user.failedLoginAttempts,
        lockedUntil: user.lockedUntil,
        isActive: user.isActive,
        lockActive: 0,
        lockExpired: 0,
      } : null].filter(Boolean), []];
    }

    if (sql.startsWith("SELECT customer_id FROM customers WHERE customer_id = ?")) {
      return [[parameters[0] === 102 ? { customer_id: parameters[0] } : null].filter(Boolean), []];
    }

    if (sql.startsWith("UPDATE staff_users SET failed_login_attempts = 0")) {
      const user = staffUsers.find((candidate) => candidate.userId === parameters[0]);
      if (user) user.failedLoginAttempts = 0;
      return [{ affectedRows: user ? 1 : 0 }, []];
    }

    if (sql.startsWith("UPDATE customer_users SET failed_login_attempts = 0")) {
      const user = customerUsers.find((candidate) => candidate.customerId === parameters[0]);
      if (user) user.failedLoginAttempts = 0;
      return [{ affectedRows: user ? 1 : 0 }, []];
    }

    if (sql.startsWith("UPDATE staff_users SET failed_login_attempts = ?")) {
      const user = staffUsers.find((candidate) => candidate.userId === parameters[3]);
      if (user) user.failedLoginAttempts = parameters[0];
      return [{ affectedRows: user ? 1 : 0 }, []];
    }

    if (sql.startsWith("UPDATE customer_users SET failed_login_attempts = ?")) {
      const user = customerUsers.find((candidate) => candidate.customerId === parameters[3]);
      if (user) user.failedLoginAttempts = parameters[0];
      return [{ affectedRows: user ? 1 : 0 }, []];
    }

    if (sql.startsWith("SELECT") && sql.includes("FROM staff_users") && sql.includes("WHERE user_id = ?")) {
      const user = staffUsers.find((candidate) => candidate.userId === parameters[0] && candidate.isActive === 1);
      return [[user ? {
        userId: user.userId,
        username: user.username,
        role: user.role,
      } : null].filter(Boolean), []];
    }

    if (sql.startsWith("SELECT") && sql.includes("FROM customer_users") && sql.includes("WHERE customer_id = ?")) {
      const user = customerUsers.find((candidate) => candidate.customerId === parameters[0] && candidate.isActive === 1);
      return [[user ? {
        customerId: user.customerId,
        username: user.username,
      } : null].filter(Boolean), []];
    }

    if (sql.startsWith("INSERT INTO staff_users")) {
      const [username, passwordHashValue, role] = parameters;
      if (staffUsers.some((candidate) => candidate.username === username)) {
        throw Object.assign(new Error("Duplicate username"), { code: "ER_DUP_ENTRY" });
      }
      const user = {
        userId: staffUsers.length + 1,
        username,
        passwordHash: passwordHashValue,
        role,
        failedLoginAttempts: 0,
        lockedUntil: null,
        isActive: 1,
      };
      staffUsers.push(user);
      return [{ affectedRows: 1, insertId: user.userId }, []];
    }

    if (sql.startsWith("INSERT INTO customer_users")) {
      const [customerId, username, passwordHashValue] = parameters;
      const user = {
        customerId,
        username,
        passwordHash: passwordHashValue,
        failedLoginAttempts: 0,
        lockedUntil: null,
        isActive: 1,
      };
      customerUsers.push(user);
      return [{ affectedRows: 1, insertId: customerId }, []];
    }

    if (sql.startsWith("SELECT") && sql.includes("FROM staff_users") && sql.includes("ORDER BY username")) {
      return [[...staffUsers]
        .sort((left, right) => left.username.localeCompare(right.username))
        .map(({ userId, username, role, isActive, failedLoginAttempts, lockedUntil }) => ({
          userId,
          username,
          role,
          isActive,
          failedLoginAttempts,
          lockedUntil,
        })), []];
    }

    if (sql.startsWith("SELECT") && sql.includes("FROM accounts a")) {
      if (failAccountQuery) {
        throw Object.assign(
          new Error("SQL details and database password must not reach the client."),
          { code: "ER_PARSE_ERROR" }
        );
      }

      const customerId = sql.includes("OR a.account_number LIKE ?")
        ? parameters[3]
        : parameters[1];
      let matches;
      if (sql.includes("a.account_number = ?")) {
        matches = accounts.filter((account) =>
          account.accountNumber === parameters[0] &&
          (customerId === null || account.customerId === customerId)
        );
      } else {
        const [search, , , , , status] = parameters;
        const normalizedSearch = search.toLowerCase();
        matches = accounts.filter((account) =>
          (customerId === null || account.customerId === customerId) &&
          (!search ||
            account.accountNumber.includes(search) ||
            account.fullName.toLowerCase().includes(normalizedSearch)) &&
          (!status || account.status === status)
        );
      }
      return [matches.map((account) => ({
        accountId: account.accountId,
        accountNumber: account.accountNumber,
        customerId: account.customerId,
        balance: account.balance,
        status: account.status,
        fullName: account.fullName,
        address: account.address,
        phone: account.phone,
        createdAt: account.createdAt,
      })), []];
    }

    throw Object.assign(new Error(`Unexpected isolated-test query: ${sql}`), {
      code: "TEST_UNEXPECTED_QUERY",
    });
  }

  const databasePool = {
    execute,
    async getConnection() {
      return {
        beginTransaction: async () => {},
        commit: async () => {},
        rollback: async () => {},
        release: () => {},
        execute,
      };
    },
  };

  return {
    databasePool,
    staffUsers,
    customerUsers,
    accounts,
    calls,
    auditEvents,
    set failAccountQuery(value) {
      failAccountQuery = value;
    },
  };
}

async function startSecurityServer(t, { secureCookie = false, trustProxy = false } = {}) {
  const passwordHash = await seedPasswordHash;
  const database = createSecurityDatabase(passwordHash);
  const sessionStore = new MemorySessionStore();
  const app = createApp({
    databasePool: database.databasePool,
    sessionStore,
    sessionSecret: "security-test-session-secret-not-for-deployment",
    secureCookie,
    sameSite: "strict",
    loginRateLimit: 100,
  });
  if (trustProxy) app.set("trust proxy", 1);
  const server = createServer(app);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  return {
    database,
    sessionStore,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
  };
}

async function request(context, path, { method = "GET", body, cookie, headers = {} } = {}) {
  const requestHeaders = { ...headers };
  if (body !== undefined) requestHeaders["Content-Type"] = "application/json";
  if (cookie) requestHeaders.Cookie = cookie;
  const response = await fetch(`${context.baseUrl}${path}`, {
    method,
    headers: requestHeaders,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return {
    response,
    body: await response.json(),
  };
}

async function login(context, username, password = SEED_PASSWORD, options = {}) {
  const result = await request(context, "/api/auth/login", {
    method: "POST",
    body: { username, password },
    ...options,
  });
  const cookie = result.response.headers.get("set-cookie")?.split(";")[0];
  return { ...result, cookie };
}

test("staff and customer password creation hash before persistence and never return hashes", async (t) => {
  const context = await startSecurityServer(t);
  const admin = await login(context, "admin.test");
  assert.equal(admin.response.status, 200);

  const created = await request(context, "/api/admin/staff", {
    method: "POST",
    cookie: admin.cookie,
    body: {
      username: "new.staff",
      password: CREATED_PASSWORD,
      role: "STAFF",
    },
  });
  assert.equal(created.response.status, 201);
  assert.equal(JSON.stringify(created.body).includes(CREATED_PASSWORD), false);

  const storedUser = context.database.staffUsers.find((user) => user.username === "new.staff");
  assert.match(storedUser.passwordHash, /^\$2[aby]\$12\$/);
  assert.notEqual(storedUser.passwordHash, CREATED_PASSWORD);
  assert.equal(await bcrypt.compare(CREATED_PASSWORD, storedUser.passwordHash), true);

  const listing = await request(context, "/api/admin/staff", { cookie: admin.cookie });
  assert.equal(listing.response.status, 200);
  assert.equal(JSON.stringify(listing.body).includes(storedUser.passwordHash), false);
  assert.equal(JSON.stringify(listing.body).includes("passwordHash"), false);

  const newUser = await login(context, "new.staff", CREATED_PASSWORD);
  assert.equal(newUser.response.status, 200);
  assert.equal(JSON.stringify(newUser.body).includes(storedUser.passwordHash), false);
  assert.equal(JSON.stringify(newUser.body).includes(CREATED_PASSWORD), false);

  const createdCustomer = await request(context, "/api/admin/customer-users", {
    method: "POST",
    cookie: admin.cookie,
    body: {
      customerId: 102,
      username: "new.customer",
      password: CREATED_PASSWORD,
    },
  });
  assert.equal(createdCustomer.response.status, 201);
  assert.equal(JSON.stringify(createdCustomer.body).includes(CREATED_PASSWORD), false);
  const storedCustomer = context.database.customerUsers.find((user) => user.username === "new.customer");
  assert.match(storedCustomer.passwordHash, /^\$2[aby]\$12\$/);
  assert.notEqual(storedCustomer.passwordHash, CREATED_PASSWORD);
  assert.equal(await bcrypt.compare(CREATED_PASSWORD, storedCustomer.passwordHash), true);

  const newCustomer = await login(context, "new.customer", CREATED_PASSWORD);
  assert.equal(newCustomer.response.status, 200);
  assert.equal(JSON.stringify(newCustomer.body).includes(storedCustomer.passwordHash), false);
});

test("login verifies passwords, rejects invalid credentials, and excludes secrets from audit data", async (t) => {
  const context = await startSecurityServer(t);

  const validLogin = await login(context, "admin.test");
  assert.equal(validLogin.response.status, 200);
  assert.equal(JSON.stringify(validLogin.body).includes(SEED_PASSWORD), false);
  assert.equal(JSON.stringify(validLogin.body).includes("passwordHash"), false);

  const invalidPassword = await login(context, "admin.test", "wrong-password");
  assert.equal(invalidPassword.response.status, 401);
  assert.equal(invalidPassword.body.message, "Invalid username or password, or account temporarily unavailable.");
  assert.equal(JSON.stringify(invalidPassword.body).includes("wrong-password"), false);

  const missingCredentials = await request(context, "/api/auth/login", {
    method: "POST",
    body: { username: "admin.test" },
  });
  assert.equal(missingCredentials.response.status, 401);
  assert.equal(missingCredentials.body.message, invalidPassword.body.message);

  const injection = await login(context, "admin' OR '1'='1 --", "wrong-password");
  assert.equal(injection.response.status, 401);
  assert.equal(injection.body.message, invalidPassword.body.message);
  assert.equal(context.database.calls.some(({ sql, parameters }) =>
    sql.includes("WHERE username = ?") && parameters[0] === "admin' OR '1'='1 --"
  ), false);
  assert.equal(JSON.stringify(context.database.auditEvents).includes("wrong-password"), false);
});

test("protected endpoints reject missing and invalid sessions and enforce administrator roles", async (t) => {
  const context = await startSecurityServer(t);

  const anonymousAccounts = await request(context, "/api/accounts");
  assert.equal(anonymousAccounts.response.status, 401);
  const anonymousAdmin = await request(context, "/api/admin/staff");
  assert.equal(anonymousAdmin.response.status, 401);

  const invalidSession = await request(context, "/api/auth/session", {
    cookie: "securebank.sid=invalid-session-id",
  });
  assert.equal(invalidSession.response.status, 200);
  assert.deepEqual(invalidSession.body, { user: null, sessionExpired: true });

  const staff = await login(context, "staff.test");
  const forbidden = await request(context, "/api/admin/staff", { cookie: staff.cookie });
  assert.equal(forbidden.response.status, 403);
  const allowed = await request(context, "/api/accounts", { cookie: staff.cookie });
  assert.equal(allowed.response.status, 200);
});

test("account lookups enforce ownership and search input remains a bound SQL parameter", async (t) => {
  const context = await startSecurityServer(t);
  const customer = await login(context, "customer.test");

  const ownAccount = await request(context, "/api/accounts/1000000001", { cookie: customer.cookie });
  assert.equal(ownAccount.response.status, 200);
  assert.equal(ownAccount.body.account.customerId, 101);

  const otherAccount = await request(context, "/api/accounts/1000000002", { cookie: customer.cookie });
  assert.equal(otherAccount.response.status, 404);
  assert.doesNotMatch(JSON.stringify(otherAccount.body), /Synthetic Customer Two|900\.00/);

  const injection = "' OR 1=1 --";
  const search = await request(
    context,
    `/api/accounts?search=${encodeURIComponent(injection)}`,
    { cookie: customer.cookie }
  );
  assert.equal(search.response.status, 200);
  assert.deepEqual(search.body, { accounts: [] });
  const searchQuery = context.database.calls.find(({ sql, parameters }) =>
    sql.includes("FROM accounts a") &&
    sql.includes("OR a.account_number LIKE ?") &&
    parameters.includes(`%${injection}%`)
  );
  assert.ok(searchQuery);
  assert.equal(searchQuery.sql.includes(injection), false);

  const attemptedModification = await request(context, "/api/accounts/1000000002", {
    method: "PATCH",
    cookie: customer.cookie,
    body: {
      fullName: "Attacker Modified Name",
      address: "Attacker Address",
      phone: "9000000010",
    },
  });
  assert.equal(attemptedModification.response.status, 403);

  const malformedLookup = await request(context, "/api/accounts/1000000001%27%20OR%201%3D1", {
    cookie: customer.cookie,
  });
  assert.equal(malformedLookup.response.status, 400);
});

test("sessions rotate at login, use hardened cookies, and logout invalidates access", async (t) => {
  const context = await startSecurityServer(t);
  const loginResult = await login(context, "admin.test", SEED_PASSWORD, {
    cookie: "securebank.sid=attacker-controlled-id",
  });
  assert.equal(loginResult.response.status, 200);
  assert.ok(loginResult.cookie);
  assert.notEqual(loginResult.cookie, "securebank.sid=attacker-controlled-id");

  const setCookie = loginResult.response.headers.get("set-cookie");
  assert.match(setCookie, /HttpOnly/i);
  assert.doesNotMatch(setCookie, /(?:^|;\s*)Secure(?:;|$)/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Expires=/i);
  const expiration = Date.parse(setCookie.match(/Expires=([^;]+)/i)[1]);
  assert.ok(expiration > Date.now() + 28 * 60 * 1000);
  assert.ok(expiration < Date.now() + 32 * 60 * 1000);

  const activeAccess = await request(context, "/api/accounts", { cookie: loginResult.cookie });
  assert.equal(activeAccess.response.status, 200);

  const logout = await request(context, "/api/auth/logout", {
    method: "POST",
    cookie: loginResult.cookie,
  });
  assert.equal(logout.response.status, 200);
  const invalidatedAccess = await request(context, "/api/accounts", { cookie: loginResult.cookie });
  assert.equal(invalidatedAccess.response.status, 401);
});

test("Secure cookies are emitted for HTTPS when secure-cookie mode is enabled", async (t) => {
  const context = await startSecurityServer(t, {
    secureCookie: true,
    trustProxy: true,
  });
  const result = await login(context, "admin.test", SEED_PASSWORD, {
    headers: { "X-Forwarded-Proto": "https" },
  });

  assert.equal(result.response.status, 200);
  assert.match(result.response.headers.get("set-cookie"), /(?:^|;\s*)Secure(?:;|$)/i);
  assert.match(result.response.headers.get("set-cookie"), /HttpOnly/i);
});

test("database failures return generic errors and log no SQL details or credentials", async (t) => {
  const context = await startSecurityServer(t);
  const user = await login(context, "staff.test");
  context.database.failAccountQuery = true;

  const loggedErrors = [];
  const originalConsoleError = console.error;
  console.error = (...values) => loggedErrors.push(values.join(" "));
  let result;
  try {
    result = await request(context, "/api/accounts", { cookie: user.cookie });
  } finally {
    console.error = originalConsoleError;
  }

  assert.equal(result.response.status, 500);
  assert.deepEqual(result.body, { message: "Unable to retrieve accounts." });
  assert.equal(JSON.stringify(result.body).includes("SQL details"), false);
  assert.equal(loggedErrors.join(" ").includes("SQL details"), false);
  assert.equal(loggedErrors.join(" ").includes("database password"), false);
  assert.match(loggedErrors.join(" "), /ER_PARSE_ERROR/);
});

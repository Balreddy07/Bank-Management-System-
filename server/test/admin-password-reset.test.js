const assert = require("node:assert/strict");
const test = require("node:test");
const {
  resetAdminPassword,
  validatePassword,
  validateUsername,
} = require("../src/scripts/reset-admin-password");

test("administrator recovery enforces the existing username and password rules", () => {
  assert.doesNotThrow(() => validateUsername("admin.user"));
  assert.throws(() => validateUsername("Admin User"), /valid format/);
  assert.doesNotThrow(() => validatePassword("a-secure-password"));
  assert.throws(() => validatePassword("short"), /at least 12 characters/);
  assert.throws(() => validatePassword("é".repeat(37)), /72 UTF-8 bytes/);
});

test("administrator recovery updates exactly the named active admin transactionally", async () => {
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push(["begin"]); },
    async execute(sql, params) {
      calls.push(["execute", sql, params]);
      if (sql.startsWith("SELECT")) {
        return [[{ userId: 42, role: "ADMIN", isActive: 1 }]];
      }
      return [{ affectedRows: 1 }];
    },
    async commit() { calls.push(["commit"]); },
    async rollback() { calls.push(["rollback"]); },
    release() { calls.push(["release"]); },
  };
  const databasePool = { async getConnection() { return connection; } };
  const bcryptImpl = {
    async hash(password, cost) {
      calls.push(["hash", password, cost]);
      return "test-hash";
    },
  };

  await resetAdminPassword({
    databasePool,
    username: "admin.user",
    password: "a-secure-password",
    bcryptImpl,
  });

  const update = calls.find((call) => call[0] === "execute" && call[1].startsWith("UPDATE"));
  assert.deepEqual(update[2], ["test-hash", 42, "admin.user"]);
  assert.match(update[1], /failed_login_attempts = 0, locked_until = NULL/);
  assert.deepEqual(calls.find((call) => call[0] === "hash"), ["hash", "a-secure-password", 12]);
  assert.deepEqual(calls.map((call) => call[0]), ["begin", "execute", "hash", "execute", "commit", "release"]);
});

test("administrator recovery rejects a non-admin and rolls back without updating", async () => {
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push("begin"); },
    async execute(sql) {
      calls.push(sql.startsWith("UPDATE") ? "update" : "select");
      return [[{ userId: 42, role: "STAFF", isActive: 1 }]];
    },
    async commit() { calls.push("commit"); },
    async rollback() { calls.push("rollback"); },
    release() { calls.push("release"); },
  };
  const databasePool = { async getConnection() { return connection; } };

  await assert.rejects(
    resetAdminPassword({ databasePool, username: "admin.user", password: "a-secure-password" }),
    /No single active administrator/
  );
  assert.deepEqual(calls, ["begin", "select", "rollback", "release"]);
});

test("administrator recovery rolls back if the guarded update does not affect exactly one row", async () => {
  const calls = [];
  const connection = {
    async beginTransaction() { calls.push("begin"); },
    async execute(sql) {
      if (sql.startsWith("SELECT")) return [[{ userId: 42, role: "ADMIN", isActive: 1 }]];
      return [{ affectedRows: 0 }];
    },
    async commit() { calls.push("commit"); },
    async rollback() { calls.push("rollback"); },
    release() { calls.push("release"); },
  };
  const databasePool = { async getConnection() { return connection; } };
  const bcryptImpl = { async hash() { return "test-hash"; } };

  await assert.rejects(
    resetAdminPassword({
      databasePool,
      username: "admin.user",
      password: "a-secure-password",
      bcryptImpl,
    }),
    /not updated exactly once/
  );
  assert.deepEqual(calls, ["begin", "rollback", "release"]);
});

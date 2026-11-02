const assert = require("node:assert/strict");
const test = require("node:test");

const {
  getDatabaseConfig,
  getRuntimeConfig,
  sanitizeConfigValue,
} = require("../src/config");

test("valid database configuration is accepted and normalized", () => {
  const config = getDatabaseConfig({
    DB_HOST: "db.internal",
    DB_PORT: "3307",
    DB_USER: "bank_app",
    DB_PASSWORD: "local-secret",
    DB_NAME: "bank_management_system",
  });

  assert.deepEqual(config, {
    host: "db.internal",
    port: 3307,
    user: "bank_app",
    password: "local-secret",
    database: "bank_management_system",
  });
});

test("missing required variables fail fast with clear errors", () => {
  assert.throws(() => getDatabaseConfig({ DB_HOST: "localhost", DB_USER: "", DB_NAME: "bank_management_system" }), /DB_USER cannot be blank/i);
  assert.throws(() => getDatabaseConfig({ DB_HOST: "localhost", DB_USER: "bank_app", DB_NAME: "" }), /DB_NAME is required/i);
  assert.throws(() => getDatabaseConfig({ DB_HOST: "localhost", DB_USER: "bank_app", DB_NAME: "bad-name!" }), /DB_NAME is invalid/i);
});

test("runtime configuration enforces production values and environment-specific settings", () => {
  const runtime = getRuntimeConfig({
    NODE_ENV: "production",
    PORT: "8080",
    DB_HOST: "localhost",
    DB_PORT: "3306",
    DB_USER: "bank_app",
    DB_PASSWORD: "strong-password",
    DB_NAME: "bank_management_system",
    SESSION_SECRET: "a".repeat(64),
    SESSION_COOKIE_SECURE: "true",
    SESSION_COOKIE_SAME_SITE: "none",
    CORS_ORIGINS: "https://app.example.com,https://admin.example.com",
    LOGIN_RATE_LIMIT: "15",
  });

  assert.equal(runtime.port, 8080);
  assert.equal(runtime.loginRateLimit, 15);
  assert.deepEqual(runtime.corsOrigins, ["https://app.example.com", "https://admin.example.com"]);

  assert.throws(() => getRuntimeConfig({
    NODE_ENV: "production",
    DB_HOST: "localhost",
    DB_PORT: "3306",
    DB_USER: "bank_app",
    DB_PASSWORD: "strong-password",
    DB_NAME: "bank_management_system",
    SESSION_SECRET: "short",
    SESSION_COOKIE_SECURE: "true",
    SESSION_COOKIE_SAME_SITE: "lax",
  }), /SESSION_SECRET must be at least 32 characters/i);
});

test("sensitive values are scrubbed before outputting logs", () => {
  const scrubbed = sanitizeConfigValue("DB_PASSWORD=super-secret-value SESSION_SECRET=server-secret");
  assert.equal(scrubbed.includes("super-secret-value"), false);
  assert.equal(scrubbed.includes("server-secret"), false);
  assert.match(scrubbed, /\[REDACTED\]/);
});

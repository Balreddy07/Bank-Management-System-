const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const SAFE_DATABASE_NAME = /^[A-Za-z0-9_]+$/;
const DEFAULT_PORT = 5000;
const DEFAULT_LOGIN_RATE_LIMIT = 20;

function loadEnvironmentFile(filePath = path.resolve(__dirname, "..", ".env")) {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  require("dotenv").config({ path: filePath });
  return process.env;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value ?? fallback);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    return fallback;
  }
  return parsed;
}

function sanitizeConfigValue(value) {
  if (typeof value !== "string") return "";

  return value
    .replace(/(DB_PASSWORD\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/(SESSION_SECRET\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/(password\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]")
    .replace(/(secret\s*[:=]\s*)([^\s,;]+)/gi, "$1[REDACTED]");
}

function getDatabaseConfig(env = process.env) {
  const host = String(env.DB_HOST || "localhost").trim();
  const port = Number(env.DB_PORT || 3306);
  const user = String(env.DB_USER ?? "root").trim();
  const password = env.DB_PASSWORD ?? "";
  const database = String(env.DB_NAME ?? "bank_management_system").trim();

  if (!user) {
    throw new Error("DB_USER cannot be blank. Set it in the local .env file before starting the API.");
  }

  if (!database) {
    throw new Error("DB_NAME is required. Set it in the local .env file before starting the API.");
  }

  if (!SAFE_DATABASE_NAME.test(database)) {
    throw new Error("DB_NAME is invalid. Use only letters, numbers, and underscores.");
  }

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("DB_PORT must be a valid TCP port number.");
  }

  return {
    host,
    port,
    user,
    password,
    database,
  };
}

function parseAllowedOrigins(value) {
  if (!value) return ["http://localhost:5173", "http://127.0.0.1:5173"];

  return value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function getRuntimeConfig(env = process.env) {
  const database = getDatabaseConfig(env);
  const port = Number(env.PORT || DEFAULT_PORT);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PORT must be a valid TCP port number.");
  }

  const sessionSecret = env.SESSION_SECRET || "";
  if (env.NODE_ENV === "production" && sessionSecret.length < 32) {
    throw new Error("SESSION_SECRET must be at least 32 characters long in production.");
  }

  const sameSite = String(env.SESSION_COOKIE_SAME_SITE || "lax").toLowerCase();
  if (!['lax', 'strict', 'none'].includes(sameSite)) {
    throw new Error("SESSION_COOKIE_SAME_SITE must be one of: lax, strict, none.");
  }

  const secureCookie = String(env.SESSION_COOKIE_SECURE || (env.NODE_ENV === "production" ? "true" : "false")).toLowerCase() === "true";
  if (sameSite === "none" && !secureCookie) {
    throw new Error("SESSION_COOKIE_SECURE=true is required when SESSION_COOKIE_SAME_SITE=none.");
  }

  return {
    database,
    port,
    sessionSecret: sessionSecret || crypto.randomBytes(48).toString("hex"),
    sameSite,
    secureCookie,
    loginRateLimit: parsePositiveInteger(env.LOGIN_RATE_LIMIT, DEFAULT_LOGIN_RATE_LIMIT),
    corsOrigins: parseAllowedOrigins(env.CORS_ORIGINS),
  };
}

module.exports = {
  DEFAULT_PORT,
  DEFAULT_LOGIN_RATE_LIMIT,
  getDatabaseConfig,
  getRuntimeConfig,
  loadEnvironmentFile,
  parseAllowedOrigins,
  parsePositiveInteger,
  sanitizeConfigValue,
};


const crypto = require("node:crypto");
const cors = require("cors");
const express = require("express");
const session = require("express-session");
const { rateLimit } = require("express-rate-limit");
const pool = require("./db");
const MySQLSessionStore = require("./auth/mysql-session-store");
const { createAuthRouter } = require("./auth/routes");
const { createAuthMiddleware, requireRole } = require("./auth/middleware");
const { createAuditLogger } = require("./audit-logger");
const { createAccountRouter } = require("./routes/accounts");
const { createTransactionRouter } = require("./routes/transactions");
const { createReportRouter } = require("./routes/reports");
const { createAdminRouter } = require("./routes/admin");

const DEFAULT_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

function createErrorHandler() {
  return (receivedError, req, res, next) => {
    const error = receivedError instanceof Error
      ? receivedError
      : new Error("Unhandled application failure.");
    if (res.headersSent) return next(error);

    if (error.type === "entity.too.large") {
      return res.status(413).json({ message: "Request body is too large." });
    }
    if (error instanceof SyntaxError && error.status === 400 && "body" in error) {
      return res.status(400).json({ message: "Invalid JSON request body." });
    }

    const statusMessages = {
      400: "Invalid request. Check the submitted data and try again.",
      401: "Please sign in to continue.",
      403: "You do not have permission to perform this action.",
      404: "The requested resource was not found.",
      413: "Request body is too large.",
      415: "Unsupported request content type.",
      422: "Some submitted information is invalid. Check your input and try again.",
      429: "Too many requests. Please wait and try again.",
    };
    const status = Number(error.status || error.statusCode);
    if (statusMessages[status]) {
      return res.status(status).json({ message: statusMessages[status] });
    }

    const stackFrames = typeof error.stack === "string"
      ? error.stack.split("\n").slice(1, 6).map((frame) => frame.trim().slice(0, 240))
      : [];
    const code = typeof error.code === "string" && /^[A-Za-z0-9_-]{1,64}$/.test(error.code)
      ? error.code
      : "UNKNOWN";
    const name = typeof error.name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(error.name)
      ? error.name
      : "Error";
    console.error("Application error:", {
      name,
      code,
      stackFrames,
    });
    return res.status(500).json({ message: "Something went wrong. Please try again." });
  };
}

function createSessionStore(databasePool) {
  return new MySQLSessionStore(databasePool);
}

function createApp({
  databasePool = pool,
  sessionStore = createSessionStore(databasePool),
  sessionSecret = process.env.SESSION_SECRET,
  secureCookie = process.env.SESSION_COOKIE_SECURE === "true" || process.env.NODE_ENV === "production",
  sameSite = process.env.SESSION_COOKIE_SAME_SITE || "lax",
  allowedOrigins = process.env.CORS_ORIGINS
    ? process.env.CORS_ORIGINS.split(",").map((origin) => origin.trim()).filter(Boolean)
    : DEFAULT_ORIGINS,
} = {}) {
  if (process.env.NODE_ENV === "production" && (!sessionSecret || sessionSecret.length < 32)) {
    throw new Error("SESSION_SECRET must contain at least 32 characters in production.");
  }
  if (!["lax", "strict", "none"].includes(sameSite.toLowerCase())) {
    throw new Error("SESSION_COOKIE_SAME_SITE must be lax, strict, or none.");
  }
  if (sameSite.toLowerCase() === "none" && !secureCookie) {
    throw new Error("SESSION_COOKIE_SECURE=true is required when SESSION_COOKIE_SAME_SITE=none.");
  }

  const app = express();
  const secret = sessionSecret || crypto.randomBytes(48).toString("hex");
  const auditLogger = createAuditLogger(databasePool);
  app.locals.auditLogger = auditLogger;

  app.use(cors({
    origin(origin, callback) {
      callback(null, !origin || allowedOrigins.includes(origin));
    },
    credentials: true,
  }));
  app.use((req, res, next) => {
    const origin = req.get("origin");
    if (origin && !allowedOrigins.includes(origin)) {
      return res.status(403).json({ message: "Request origin is not allowed." });
    }
    return next();
  });
  app.use(express.json({ limit: "10kb" }));
  app.use(session({
    name: "securebank.sid",
    secret,
    store: sessionStore,
    resave: false,
    saveUninitialized: false,
    rolling: true,
    genid: () => crypto.randomBytes(32).toString("hex"),
    cookie: {
      httpOnly: true,
      secure: secureCookie,
      sameSite: sameSite.toLowerCase(),
      maxAge: SESSION_IDLE_TIMEOUT_MS,
      path: "/",
    },
  }));

  const loginLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { message: "Too many login attempts. Try again later." },
  });

  app.get("/api/health", (req, res) => {
    res.status(200).json({ status: "ok", message: "Bank Management System API is running" });
  });

  app.get("/api/health/db", async (req, res) => {
    try {
      const [rows] = await databasePool.query("SELECT 1 AS connected");
      return res.status(200).json({ status: "ok", database: "connected", result: rows[0].connected });
    } catch (error) {
      console.error("Database health check failed:", error.code || "unknown error");
      return res.status(503).json({ status: "error", database: "unavailable" });
    }
  });

  app.use("/api/auth", createAuthRouter({
    databasePool,
    loginLimiter,
    secureCookie,
    sameSite: sameSite.toLowerCase(),
    auditLogger,
  }));

  const { requireAuth } = createAuthMiddleware(databasePool);
  app.use("/api/admin", requireAuth, requireRole("ADMIN"), createAdminRouter({ databasePool }));
  app.use(
    "/api/accounts",
    requireAuth,
    requireRole("ADMIN", "STAFF", "CUSTOMER"),
    createAccountRouter(databasePool)
  );
  app.use(
    "/api/transactions",
    requireAuth,
    requireRole("ADMIN", "STAFF", "CUSTOMER"),
    createTransactionRouter(databasePool)
  );
  app.use("/api/reports", requireAuth, requireRole("ADMIN"), createReportRouter(databasePool));

  app.use("/api", (req, res) => {
    res.status(404).json({ message: "API endpoint not found" });
  });

  app.use(createErrorHandler());

  return app;
}

module.exports = { createApp, createErrorHandler };

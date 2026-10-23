
const crypto = require("node:crypto");
const cors = require("cors");
const express = require("express");
const session = require("express-session");
const { rateLimit } = require("express-rate-limit");
const pool = require("./db");
const MySQLSessionStore = require("./auth/mysql-session-store");
const { createAuthRouter } = require("./auth/routes");
const { createAuthMiddleware, requireRole } = require("./auth/middleware");
const { createAccountRouter } = require("./routes/accounts");
const { createTransactionRouter } = require("./routes/transactions");
const { createReportRouter } = require("./routes/reports");
const { createAdminRouter } = require("./routes/admin");

const DEFAULT_ORIGINS = ["http://localhost:5173", "http://127.0.0.1:5173"];

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
      maxAge: 8 * 60 * 60 * 1000,
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
  }));

  const { requireAuth } = createAuthMiddleware(databasePool);
  app.use("/api/admin", requireAuth, requireRole("ADMIN"), createAdminRouter({ databasePool }));
  app.use("/api/accounts", requireAuth, createAccountRouter(databasePool));
  app.use("/api/transactions", requireAuth, createTransactionRouter(databasePool));
  app.use("/api/reports", requireAuth, requireRole("ADMIN"), createReportRouter(databasePool));

  app.use("/api", (req, res) => {
    res.status(404).json({ message: "API endpoint not found" });
  });

  app.use((err, req, res, next) => {
    if (res.headersSent) return next(err);
    if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
      return res.status(400).json({ message: "Invalid JSON request body" });
    }
    console.error("Application error:", err.code || "unknown error");
    return res.status(500).json({ message: "Internal server error" });
  });

  return app;
}

module.exports = { createApp };

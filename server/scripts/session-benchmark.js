#!/usr/bin/env node

const { performance } = require("node:perf_hooks");

const MAX_TARGET_SESSIONS = 5000;
const MAX_CONCURRENCY = 1000;
const MAX_DURATION_MS = 60 * 60 * 1000;
const MAX_REQUEST_TIMEOUT_MS = 120000;
const RESPONSE_TIME_LIMIT_MS = 4000;
const ERROR_SAMPLE_LIMIT = 20;

function parseInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function getConfiguration(argv = [], environment = process.env) {
  const values = {
    apiBaseUrl: environment.LOAD_TEST_API_BASE_URL || environment.API_BASE_URL || "http://127.0.0.1:5000",
    username: environment.LOAD_TEST_USERNAME || "",
    password: environment.LOAD_TEST_PASSWORD || "",
    targetSessions: environment.LOAD_TEST_TARGET_SESSIONS || "1000",
    concurrency: environment.LOAD_TEST_CONCURRENCY || "50",
    durationMs: environment.LOAD_TEST_DURATION_MS || "30000",
    rampUpMs: environment.LOAD_TEST_RAMP_UP_MS || "5000",
    requestIntervalMs: environment.LOAD_TEST_REQUEST_INTERVAL_MS || "1000",
    requestTimeoutMs: environment.LOAD_TEST_REQUEST_TIMEOUT_MS || "10000",
    protectedPath: environment.LOAD_TEST_PROTECTED_PATH || "/api/accounts",
    allowRemote: environment.LOAD_TEST_ALLOW_REMOTE === "true",
    targetEnvironment: (environment.LOAD_TEST_TARGET_ENVIRONMENT || "").toLowerCase(),
    dryRun: false,
    help: false,
  };

  const options = new Map([
    ["--base-url", "apiBaseUrl"],
    ["--username", "username"],
    ["--password", "password"],
    ["--target-sessions", "targetSessions"],
    ["--concurrency", "concurrency"],
    ["--duration-ms", "durationMs"],
    ["--ramp-up-ms", "rampUpMs"],
    ["--request-interval-ms", "requestIntervalMs"],
    ["--request-timeout-ms", "requestTimeoutMs"],
    ["--protected-path", "protectedPath"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    if (option === "--help" || option === "-h") {
      values.help = true;
    } else if (option === "--dry-run") {
      values.dryRun = true;
    } else if (option === "--allow-remote") {
      values.allowRemote = true;
    } else if (options.has(option)) {
      if (index + 1 >= argv.length) throw new Error(`${option} requires a value.`);
      values[options.get(option)] = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown option: ${option}`);
    }
  }

  let apiBaseUrl;
  try {
    apiBaseUrl = new URL(values.apiBaseUrl);
  } catch {
    throw new Error("LOAD_TEST_API_BASE_URL must be an absolute HTTP or HTTPS URL.");
  }
  if (!["http:", "https:"].includes(apiBaseUrl.protocol) || apiBaseUrl.username || apiBaseUrl.password) {
    throw new Error("Use an HTTP or HTTPS API URL without embedded credentials.");
  }
  apiBaseUrl.hash = "";
  apiBaseUrl.search = "";
  const basePath = apiBaseUrl.pathname.replace(/\/+$/, "");
  apiBaseUrl.pathname = `${basePath.endsWith("/api") ? basePath : `${basePath}/api`}/`;

  const hostname = apiBaseUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname.split(/[.-]/).some((label) => label === "prod" || label === "production")) {
    throw new Error("Production-looking targets are blocked; use a dedicated local, test, or staging system.");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const isLocal = localHosts.has(hostname);
  if (!isLocal && (!values.allowRemote || !["test", "staging"].includes(values.targetEnvironment))) {
    throw new Error("Remote targets require explicit opt-in and LOAD_TEST_TARGET_ENVIRONMENT=test or staging.");
  }
  if (values.targetEnvironment === "production") {
    throw new Error("Production targets are not permitted.");
  }
  if (!/^\/api\/[A-Za-z0-9_./?=&%-]*$/.test(values.protectedPath) || values.protectedPath.includes("..")) {
    throw new Error("LOAD_TEST_PROTECTED_PATH must be a local /api/ path.");
  }

  const config = {
    apiBaseUrl: apiBaseUrl.href,
    username: values.username,
    password: values.password,
    targetSessions: parseInteger(values.targetSessions, "LOAD_TEST_TARGET_SESSIONS", 1, MAX_TARGET_SESSIONS),
    concurrency: parseInteger(values.concurrency, "LOAD_TEST_CONCURRENCY", 1, MAX_CONCURRENCY),
    durationMs: parseInteger(values.durationMs, "LOAD_TEST_DURATION_MS", 1000, MAX_DURATION_MS),
    rampUpMs: parseInteger(values.rampUpMs, "LOAD_TEST_RAMP_UP_MS", 0, MAX_DURATION_MS),
    requestIntervalMs: parseInteger(values.requestIntervalMs, "LOAD_TEST_REQUEST_INTERVAL_MS", 100, MAX_DURATION_MS),
    requestTimeoutMs: parseInteger(values.requestTimeoutMs, "LOAD_TEST_REQUEST_TIMEOUT_MS", 100, MAX_REQUEST_TIMEOUT_MS),
    protectedPath: values.protectedPath,
    allowRemote: values.allowRemote,
    targetEnvironment: values.targetEnvironment || (isLocal ? "local" : ""),
    dryRun: values.dryRun,
    help: values.help,
  };
  if (config.rampUpMs > config.durationMs) {
    throw new Error("LOAD_TEST_RAMP_UP_MS must not exceed LOAD_TEST_DURATION_MS.");
  }
  return config;
}

function redactSecrets(value) {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [
      key,
      ["password", "username", "authorization", "cookie", "set-cookie", "session", "sessionid", "session_id"].includes(key.toLowerCase())
        ? "[REDACTED]"
        : redactSecrets(child),
    ]));
  }
  return value;
}

function summarizeLatency(samples) {
  if (!samples.length) {
    return { count: 0, averageMs: null, medianMs: null, p95Ms: null, p99Ms: null, minMs: null, maxMs: null };
  }
  const sorted = [...samples].sort((left, right) => left - right);
  const percentile = (fraction) => sorted[Math.min(sorted.length - 1, Math.ceil(fraction * sorted.length) - 1)];
  const rounded = (value) => Number(value.toFixed(2));
  return {
    count: sorted.length,
    averageMs: rounded(sorted.reduce((sum, value) => sum + value, 0) / sorted.length),
    medianMs: rounded(percentile(0.5)),
    p95Ms: rounded(percentile(0.95)),
    p99Ms: rounded(percentile(0.99)),
    minMs: rounded(sorted[0]),
    maxMs: rounded(sorted[sorted.length - 1]),
  };
}

function getSessionCookie(response) {
  const values = response.headers?.getSetCookie?.() || [response.headers?.get?.("set-cookie") || ""];
  for (const header of values) {
    const cookie = String(header).split(";")[0].trim();
    if (cookie.toLowerCase().startsWith("securebank.sid=")) return cookie;
  }
  return "";
}

function createSemaphore(limit) {
  let inUse = 0;
  const waiting = [];
  return async function use(operation) {
    if (inUse >= limit) await new Promise((resolve) => waiting.push(resolve));
    inUse += 1;
    try {
      return await operation();
    } finally {
      inUse -= 1;
      waiting.shift()?.();
    }
  };
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function consumeResponseBody(response) {
  const reader = response.body?.getReader?.();
  if (reader) {
    while (!(await reader.read()).done) {
      // Consume the stream without buffering full response bodies in memory.
    }
  } else if (typeof response.arrayBuffer === "function") {
    await response.arrayBuffer();
  }
}

async function runSessionLoadTest(configuration, dependencies = {}) {
  const config = configuration;
  const fetchImpl = dependencies.fetch || globalThis.fetch;
  const wait = dependencies.sleep || sleep;
  const now = dependencies.now || (() => performance.now());
  const wallClock = dependencies.wallClock || (() => new Date().toISOString());

  if (config.dryRun) {
    return {
      mode: "dry-run",
      status: "not-run",
      config: redactSecrets(config),
      targetSessions: config.targetSessions,
      achievedPeakActiveConcurrency: 0,
      targetMet: null,
      errors: [],
      explanation: "No network requests were made. A live result requires an authorized local or staging API and dedicated test-user credentials.",
    };
  }
  if (typeof fetchImpl !== "function") throw new Error("This Node.js runtime does not provide fetch.");
  if (!config.username || !config.password) {
    throw new Error("Set LOAD_TEST_USERNAME and LOAD_TEST_PASSWORD before running the live session benchmark.");
  }

  const startedAt = now();
  const startTime = wallClock();
  const deadline = startedAt + config.durationMs;
  const gate = createSemaphore(config.concurrency);
  const activeSessions = new Set();
  const protectedLatency = [];
  const loginLatency = [];
  const logoutLatency = [];
  let peakActiveSessions = 0;
  let activeRequests = 0;
  let maxInFlightRequests = 0;
  let successfulAuthentication = 0;
  let failedAuthentication = 0;
  let successfulProtectedRequests = 0;
  let failedProtectedRequests = 0;
  let successfulLogouts = 0;
  let failedLogouts = 0;
  let nextErrorId = 0;
  const errors = [];
  const cpuStart = process.cpuUsage();
  const memoryStart = process.memoryUsage();
  let peakHeapUsedBytes = memoryStart.heapUsed;
  let peakRssBytes = memoryStart.rss;
  const sampleResources = () => {
    const memory = process.memoryUsage();
    peakHeapUsedBytes = Math.max(peakHeapUsedBytes, memory.heapUsed);
    peakRssBytes = Math.max(peakRssBytes, memory.rss);
  };
  const resourceTimer = setInterval(sampleResources, 250);
  resourceTimer.unref?.();

  const recordError = (kind, status = null) => {
    nextErrorId += 1;
    if (errors.length < ERROR_SAMPLE_LIMIT) errors.push({ id: nextErrorId, kind, status });
  };
  const measuredFetch = async (url, options, samples) => {
    let requestStarted;
    try {
      return await gate(async () => {
        activeRequests += 1;
        maxInFlightRequests = Math.max(maxInFlightRequests, activeRequests);
        requestStarted = now();
        try {
          const response = await fetchImpl(url, {
            ...options,
            signal: options.signal || AbortSignal.timeout(config.requestTimeoutMs),
          });
          await consumeResponseBody(response);
          return response;
        } finally {
          samples.push(Math.max(0, now() - requestStarted));
          activeRequests -= 1;
        }
      });
    } catch {
      if (requestStarted === undefined) samples.push(0);
      return null;
    }
  };

  const authenticate = async () => {
    const response = await measuredFetch(
      new URL("auth/login", config.apiBaseUrl),
      {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ username: config.username, password: config.password }),
      },
      loginLatency
    );
    if (!response?.ok) {
      failedAuthentication += 1;
      recordError(response ? "authentication-rejected" : "authentication-request-failed", response?.status ?? null);
      return "";
    }
    const cookie = getSessionCookie(response);
    if (!cookie) {
      failedAuthentication += 1;
      recordError("authentication-session-cookie-missing", response.status);
      return "";
    }
    successfulAuthentication += 1;
    return cookie;
  };

  const protectedRequest = async (cookie) => {
    const response = await measuredFetch(
      new URL(config.protectedPath, config.apiBaseUrl),
      { method: "GET", headers: { Cookie: cookie, Accept: "application/json" } },
      protectedLatency
    );
    if (!response?.ok) {
      failedProtectedRequests += 1;
      recordError(response ? "protected-request-rejected" : "protected-request-failed", response?.status ?? null);
      return false;
    }
    successfulProtectedRequests += 1;
    return true;
  };
  const logout = async (cookie) => {
    const response = await measuredFetch(
      new URL("auth/logout", config.apiBaseUrl),
      { method: "POST", headers: { Cookie: cookie, Accept: "application/json" } },
      logoutLatency
    );
    if (!response?.ok) {
      failedLogouts += 1;
      recordError(response ? "session-cleanup-rejected" : "session-cleanup-failed", response?.status ?? null);
      return;
    }
    successfulLogouts += 1;
  };

  const runSession = async (index) => {
    const launchDelay = config.targetSessions > 1
      ? Math.floor(config.rampUpMs * index / (config.targetSessions - 1))
      : 0;
    if (launchDelay > 0) await wait(launchDelay);
    if (now() >= deadline) {
      return;
    }

    const cookie = await authenticate();
    if (!cookie) return;
    try {
      if (!await protectedRequest(cookie)) return;
      activeSessions.add(index);
      peakActiveSessions = Math.max(peakActiveSessions, activeSessions.size);
      while (now() < deadline) {
        await wait(Math.min(config.requestIntervalMs, Math.max(0, deadline - now())));
        if (now() >= deadline) break;
        if (!await protectedRequest(cookie)) return;
      }
    } finally {
      activeSessions.delete(index);
      await logout(cookie);
    }
  };

  try {
    await Promise.all(Array.from({ length: config.targetSessions }, (_, index) => runSession(index)));
  } finally {
    clearInterval(resourceTimer);
  }

  sampleResources();
  const elapsedMs = Math.max(0, now() - startedAt);
  const protectedSummary = summarizeLatency(protectedLatency);
  const targetMet = peakActiveSessions >= config.targetSessions
    && protectedSummary.p95Ms !== null
    && protectedSummary.p95Ms <= RESPONSE_TIME_LIMIT_MS;
  const errorCount = failedAuthentication + failedProtectedRequests + failedLogouts;
  const cpu = process.cpuUsage(cpuStart);
  const memoryEnd = process.memoryUsage();
  const cpuTimeMs = (cpu.user + cpu.system) / 1000;
  const measurementWindowMs = Math.max(0, Math.min(config.durationMs, elapsedMs));

  return {
    mode: "live",
    status: targetMet && errorCount === 0 ? "passed" : "failed",
    startedAt: startTime,
    elapsedMs: Number(elapsedMs.toFixed(2)),
    measurementWindowMs: Number(measurementWindowMs.toFixed(2)),
    config: redactSecrets(config),
    workload: {
      targetSessions: config.targetSessions,
      configuredRequestConcurrency: config.concurrency,
      achievedPeakActiveConcurrency: peakActiveSessions,
      maxInFlightRequests,
      durationMs: config.durationMs,
      rampUpMs: config.rampUpMs,
    },
    authentication: {
      attempted: successfulAuthentication + failedAuthentication,
      successful: successfulAuthentication,
      failed: failedAuthentication,
      latency: summarizeLatency(loginLatency),
    },
    protectedRequests: {
      attempted: successfulProtectedRequests + failedProtectedRequests,
      successful: successfulProtectedRequests,
      failed: failedProtectedRequests,
      throughputPerSecond: Number((successfulProtectedRequests / Math.max(measurementWindowMs / 1000, 0.001)).toFixed(2)),
      latency: protectedSummary,
    },
    sessionCleanup: {
      successfulLogouts,
      failedLogouts,
      latency: summarizeLatency(logoutLatency),
    },
    criteria: {
      issueWording: "The issue specifies a four-second response-time target without defining a percentile.",
      projectEvaluation: "This benchmark explicitly evaluates the four-second target using p95 protected-request latency.",
      responseTimeLimitMs: RESPONSE_TIME_LIMIT_MS,
      targetMet,
      targetFailureReasons: [
        ...(peakActiveSessions < config.targetSessions ? ["peak authenticated active sessions were below target"] : []),
        ...(protectedSummary.p95Ms === null ? ["no protected-request latency measurements were collected"] : []),
        ...(protectedSummary.p95Ms !== null && protectedSummary.p95Ms > RESPONSE_TIME_LIMIT_MS ? ["p95 protected-request latency exceeded 4000 ms"] : []),
      ],
    },
    resourceUsage: {
      scope: "benchmark client process only; target server and database host metrics are not available through this HTTP benchmark",
      cpuTimeMs: Number(cpuTimeMs.toFixed(2)),
      cpuPercentOfOneCore: elapsedMs > 0 ? Number((cpuTimeMs / elapsedMs * 100).toFixed(2)) : 0,
      heapUsedStartBytes: memoryStart.heapUsed,
      heapUsedEndBytes: memoryEnd.heapUsed,
      peakHeapUsedBytes,
      rssStartBytes: memoryStart.rss,
      rssEndBytes: memoryEnd.rss,
      peakRssBytes,
    },
    errors: {
      count: errorCount,
      samples: errors,
      samplesTruncated: errorCount > errors.length,
    },
  };
}

function printUsage() {
  console.log(`Usage: node scripts/session-benchmark.js [options]
  --base-url http://127.0.0.1:5000
  --username <dedicated-test-user>
  --password <dedicated-test-password>
  --target-sessions 1000
  --concurrency 50
  --duration-ms 30000
  --ramp-up-ms 5000
  --request-interval-ms 1000
  --request-timeout-ms 10000
  --protected-path /api/accounts
  --allow-remote (requires LOAD_TEST_TARGET_ENVIRONMENT=test|staging)
  --dry-run`);
}

function getExitCode(report) {
  return report.mode === "live" && (report.status !== "passed" || report.errors.count > 0) ? 1 : 0;
}

async function main() {
  let config;
  try {
    config = getConfiguration(process.argv.slice(2));
    if (config.help) {
      printUsage();
      return;
    }
    const report = await runSessionLoadTest(config);
    console.log(JSON.stringify(report, null, 2));
    if (getExitCode(report) !== 0) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

if (require.main === module) main();

module.exports = {
  getConfiguration,
  getExitCode,
  redactSecrets,
  runSessionLoadTest,
  summarizeLatency,
};

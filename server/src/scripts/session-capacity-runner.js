
const os = require("node:os");
const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");

const MAX_CLIENTS = 1000;
const MAX_DURATION_SECONDS = 3600;
const RESPONSE_TIME_TARGET_MS = 4000;
const SUCCESS_WITHIN_TARGET_PERCENT = 95;

function parseInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function getConfiguration(environment = process.env) {
  const password = environment.CONCURRENT_SESSIONS_PASSWORD;
  const usernamePrefix = environment.CONCURRENT_SESSIONS_USERNAME_PREFIX || "sessionload";
  const legacyUsername = environment.CONCURRENT_SESSIONS_USERNAME;

  if (!password) {
    throw new Error("Set CONCURRENT_SESSIONS_PASSWORD to dedicated test credentials.");
  }

  const useUniqueUsers = environment.CONCURRENT_SESSIONS_USE_UNIQUE_USERS !== "false";

  if (
    useUniqueUsers &&
    !/^[a-z0-9._-]{3,54}$/.test(usernamePrefix)
  ) {
    throw new Error("CONCURRENT_SESSIONS_USERNAME_PREFIX must be 3–54 lowercase letters, digits, dots, underscores, or hyphens.");
  }

  if (!useUniqueUsers && !legacyUsername) {
    throw new Error("Set CONCURRENT_SESSIONS_USERNAME when unique users are disabled.");
  }

  let apiUrl;
  try {
    apiUrl = new URL(environment.CONCURRENT_SESSIONS_API_URL || "http://127.0.0.1:5000/api");
  } catch {
    throw new Error("CONCURRENT_SESSIONS_API_URL must be an absolute HTTP or HTTPS URL.");
  }

  if (!["http:", "https:"].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password) {
    throw new Error("Use an HTTP or HTTPS API URL without embedded credentials.");
  }
  if (apiUrl.pathname !== "/" && !apiUrl.pathname.endsWith("/")) apiUrl.pathname += "/";

  const hostname = apiUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname.split(/[.-]/).some((label) => label === "prod" || label === "production")) {
    throw new Error("Production-looking targets are blocked; use a dedicated local, test, or staging system.");
  }

  const isLocal = ["localhost", "127.0.0.1", "::1"].includes(hostname);
  const targetEnvironment = String(
    environment.CONCURRENT_SESSIONS_TARGET_ENVIRONMENT || (isLocal ? "local" : "")
  ).toLowerCase();

  if (targetEnvironment === "production") {
    throw new Error("Production targets are not permitted.");
  }

  if (!isLocal && (
    environment.CONCURRENT_SESSIONS_ALLOW_REMOTE !== "true" ||
    !["test", "staging"].includes(targetEnvironment)
  )) {
    throw new Error("Remote targets require explicit opt-in and CONCURRENT_SESSIONS_TARGET_ENVIRONMENT=test or staging.");
  }

  const protectedPath = environment.CONCURRENT_SESSIONS_PROTECTED_PATH || "accounts";
  let decodedProtectedPath = "";
  try {
    decodedProtectedPath = decodeURIComponent(protectedPath);
  } catch {
    throw new Error("CONCURRENT_SESSIONS_PROTECTED_PATH must be a relative API path without invalid encoding.");
  }

  if (
    typeof protectedPath !== "string" ||
    !protectedPath.trim() ||
    protectedPath.startsWith("/") ||
    protectedPath.includes("\\") ||
    protectedPath.includes("?") ||
    protectedPath.includes("#") ||
    decodedProtectedPath.split(/[\\/]/).some((part) => part === "..")
  ) {
    throw new Error("CONCURRENT_SESSIONS_PROTECTED_PATH must be a relative API path without query or traversal segments.");
  }

  const clients = parseInteger(
    environment.CONCURRENT_SESSIONS_CLIENTS || 10,
    "CONCURRENT_SESSIONS_CLIENTS",
    1,
    MAX_CLIENTS
  );

  const durationSeconds = parseInteger(
    environment.CONCURRENT_SESSIONS_DURATION_SECONDS || 30,
    "CONCURRENT_SESSIONS_DURATION_SECONDS",
    1,
    MAX_DURATION_SECONDS
  );

  const rampUpSeconds = parseInteger(
    environment.CONCURRENT_SESSIONS_RAMP_UP_SECONDS || 10,
    "CONCURRENT_SESSIONS_RAMP_UP_SECONDS",
    0,
    MAX_DURATION_SECONDS
  );

  if (rampUpSeconds > durationSeconds) {
    throw new Error("CONCURRENT_SESSIONS_RAMP_UP_SECONDS must not exceed the duration.");
  }

  return {
    apiUrl,
    password,
    usernamePrefix,
    legacyUsername,
    useUniqueUsers,
    clients,
    durationSeconds,
    rampUpSeconds,
    warmupRequests: parseInteger(
      environment.CONCURRENT_SESSIONS_WARMUP_REQUESTS || 1,
      "CONCURRENT_SESSIONS_WARMUP_REQUESTS",
      0,
      10
    ),
    timeoutMs: parseInteger(
      environment.CONCURRENT_SESSIONS_TIMEOUT_MS || 10000,
      "CONCURRENT_SESSIONS_TIMEOUT_MS",
      100,
      120000
    ),
    protectedPath: protectedPath.trim(),
    targetEnvironment,
    reportDirectory: environment.CONCURRENT_SESSIONS_REPORT_DIR || "reports/session-capacity",
  };
}

function usernameForClient(configuration, index) {
  if (!configuration.useUniqueUsers) return configuration.legacyUsername;
  return `${configuration.usernamePrefix}${String(index + 1).padStart(4, "0")}`;
}

function summarizeLatency(samples) {
  if (samples.length === 0) {
    return {
      requests: 0,
      successfulRequests: 0,
      failedRequests: 0,
      meanMs: null,
      p50Ms: null,
      p95Ms: null,
      p99Ms: null,
      maxMs: null,
      successfulWithinTarget: 0,
      successfulWithinTargetPercent: null,
      targetMs: RESPONSE_TIME_TARGET_MS,
    };
  }

  const sorted = samples.map((sample) => sample.durationMs).sort((a, b) => a - b);
  const percentile = (percent) => sorted[Math.ceil((percent / 100) * sorted.length) - 1];
  const successfulRequests = samples.filter((sample) => sample.success).length;
  const successfulWithinTarget = samples.filter(
    (sample) => sample.success && sample.durationMs <= RESPONSE_TIME_TARGET_MS
  ).length;

  return {
    requests: samples.length,
    successfulRequests,
    failedRequests: samples.length - successfulRequests,
    meanMs: Number((sorted.reduce((sum, duration) => sum + duration, 0) / sorted.length).toFixed(3)),
    p50Ms: Number(percentile(50).toFixed(3)),
    p95Ms: Number(percentile(95).toFixed(3)),
    p99Ms: Number(percentile(99).toFixed(3)),
    maxMs: Number(sorted.at(-1).toFixed(3)),
    successfulWithinTarget,
    successfulWithinTargetPercent: Number((successfulWithinTarget / samples.length * 100).toFixed(2)),
    targetMs: RESPONSE_TIME_TARGET_MS,
  };
}

function statusBreakdown(samples) {
  return samples.reduce((counts, sample) => {
    const key = String(sample.status);
    counts[key] = (counts[key] || 0) + 1;
    return counts;
  }, {});
}

function createMarkdownReport(report) {
  const protectedLatency = report.latency.protectedRequests;
  const formatMetric = (value) => value === null ? "n/a" : `${value} ms`;

  return [
    "# Session capacity and response-time report",
    "",
    `- Run: ${report.generatedAt}`,
    `- Target: ${report.target.environment} (${report.target.origin})`,
    `- Scenario: ${report.scenario}`,
    `- Authentication mode: ${report.workload.authenticationMode}`,
    `- Workload: ${report.workload.requestedClients} clients; ${report.workload.rampUpSeconds}s ramp-up; ${report.workload.durationSeconds}s workload duration`,
    `- Independent sessions achieved: ${report.capacity.peakConcurrentAuthenticatedClients} peak concurrent clients from ${report.capacity.successfullyAuthenticatedClients} successful logins`,
    `- 1,000-session target: **${report.acceptance.oneThousandSessionsAchieved ? "PASS" : "NOT MET"}**`,
    "",
    "## Authentication and protected requests",
    "",
    "| Measure | Result |",
    "| --- | ---: |",
    `| Authentication attempts / successes | ${report.authentication.attempts} / ${report.authentication.successes} |`,
    `| Authentication success rate | ${report.authentication.successRatePercent}% |`,
    `| Authentication latency p50 / p95 / p99 | ${report.latency.authentication.p50Ms ?? "n/a"} / ${report.latency.authentication.p95Ms ?? "n/a"} / ${report.latency.authentication.p99Ms ?? "n/a"} ms |`,
    `| Protected requests / successes / failures | ${protectedLatency.requests} / ${protectedLatency.successfulRequests} / ${protectedLatency.failedRequests} |`,
    `| Protected latency mean / max | ${formatMetric(protectedLatency.meanMs)} / ${formatMetric(protectedLatency.maxMs)} |`,
    `| Protected latency p50 / p95 / p99 | ${protectedLatency.p50Ms ?? "n/a"} / ${protectedLatency.p95Ms ?? "n/a"} / ${protectedLatency.p99Ms ?? "n/a"} ms |`,
    `| Successful protected requests within 4,000 ms | ${protectedLatency.successfulWithinTarget} (${protectedLatency.successfulWithinTargetPercent ?? "n/a"}%) |`,
    `| Four-second target | **${report.acceptance.fourSecondResponseTimeTargetPassed ? "PASS" : "FAIL"}** — ${report.acceptance.responseTimePassRule} |`,
    `| Total requests / successful / failed | ${report.workload.totalRequests} / ${report.workload.successfulRequests} / ${report.workload.failedRequests} |`,
    `| Timeouts / network failures | ${report.workload.timedOutRequests} / ${report.workload.networkFailures} |`,
    `| Requests per second | ${report.workload.requestsPerSecond} |`,
    `| Expected unauthenticated guard | HTTP ${report.authenticationGuard.unauthenticatedStatus} |`,
    `| HTTP status counts | ${JSON.stringify(report.statusCounts)} |`,
    "",
    "## Resource observations and limitations",
    "",
    `- Load-generator CPU time: ${report.resources.loadGenerator.cpuTimeMs} ms.`,
    `- Load-generator RSS: ${report.resources.loadGenerator.rssBeforeBytes} bytes before, ${report.resources.loadGenerator.rssAfterBytes} bytes after.`,
    `- Load-generator heap used: ${report.resources.loadGenerator.heapUsedBeforeBytes} bytes before, ${report.resources.loadGenerator.heapUsedAfterBytes} bytes after.`,
    `- API server resources: ${report.resources.apiServer.observation}.`,
    `- Database resources: ${report.resources.database.observation}.`,
    `- Errors: ${JSON.stringify(report.errors)}${report.omittedErrorCount ? ` (${report.omittedErrorCount} additional errors omitted)` : ""}.`,
    "",
    "The four-second rule is at least 95% of measured protected requests returning a successful 2xx response within 4,000 ms. A NOT MET session target is not evidence that the runner could not be configured for 1,000 clients; review authentication throttling, achieved concurrency, and failures.",
    "",
  ].join("\n");
}

function addRequest(context, category, sample) {
  context.samples.push({ category, ...sample });
  if (!sample.success) {
    if (context.errors.length < 50) {
      context.errors.push({ category, status: sample.status });
    } else {
      context.omittedErrorCount += 1;
    }
  }
}

async function request(context, category, target, { method = "GET", cookie, body } = {}) {
  const startedAt = process.hrtime.bigint();

  try {
    const headers = {};
    if (cookie) headers.Cookie = cookie;
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await context.fetchImpl(target, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(context.configuration.timeoutMs),
    });

    const responseBody = await response.text();
    let payload = null;

    try {
      payload = responseBody ? JSON.parse(responseBody) : null;
    } catch {
      payload = null;
    }

    return {
      result: {
        status: response.status,
        success: response.ok,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      },
      payload,
      response,
    };
  } catch (error) {
    return {
      result: {
        status: error.name === "TimeoutError" || error.name === "AbortError"
          ? "TIMEOUT"
          : "NETWORK_ERROR",
        success: false,
        durationMs: Number(process.hrtime.bigint() - startedAt) / 1e6,
      },
      payload: null,
      response: null,
    };
  }
}

function readSessionCookie(response) {
  const cookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") || ""];

  for (const header of cookies) {
    const cookie = header.split(";", 1)[0].trim();
    if (cookie.startsWith("securebank.sid=") && cookie.length > "securebank.sid=".length) {
      return cookie;
    }
  }
  return null;
}

async function runSessionCapacityTest(configuration, { fetchImpl = fetch } = {}) {
  const startedAt = Date.now();
  const startedAtHighResolution = process.hrtime.bigint();
  const cpuBefore = process.cpuUsage();
  const memoryBefore = process.memoryUsage();

  const context = {
    configuration,
    fetchImpl,
    samples: [],
    errors: [],
    omittedErrorCount: 0,
    sessionCookies: new Set(),
    authenticatedClients: 0,
    activeAuthenticatedClients: 0,
    peakConcurrentAuthenticatedClients: 0,
  };

  const protectedUrl = new URL(configuration.protectedPath, configuration.apiUrl);

  const unauthenticated = await request(context, "invalid-authentication-check", protectedUrl);
  if (unauthenticated.result.status !== 401) {
    throw new Error(
      `Protected endpoint preflight expected HTTP 401 without a cookie, received ${unauthenticated.result.status}; no load was started.`
    );
  }

  context.samples.push({
    category: "authentication-guard",
    ...unauthenticated.result,
    expectedFailure: true,
  });

  const endAt = startedAt + (configuration.rampUpSeconds + configuration.durationSeconds) * 1000;
  const spacingMs = configuration.clients > 1
    ? configuration.rampUpSeconds * 1000 / configuration.clients
    : 0;

  async function clientWorker(index) {
    const scheduledStart = startedAt + index * spacingMs;
    const waitMs = scheduledStart - Date.now();
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));

    const username = usernameForClient(configuration, index);

    const login = await request(
      context,
      "authentication",
      new URL("auth/login", configuration.apiUrl),
      {
        method: "POST",
        body: { username, password: configuration.password },
      }
    );

    const cookie = login.response ? readSessionCookie(login.response) : null;
    const userRole = login.payload?.user?.role;
    const authenticatedResponse = Boolean(
      login.result.success &&
      ["ADMIN", "STAFF", "CUSTOMER"].includes(userRole) &&
      cookie
    );

    login.result.success = authenticatedResponse;
    if (authenticatedResponse && context.sessionCookies.has(cookie)) {
      login.result.success = false;
      login.result.status = "DUPLICATE_SESSION_COOKIE";
    } else if (authenticatedResponse) {
      context.sessionCookies.add(cookie);
    }

    if (login.response?.ok && !authenticatedResponse) {
      login.result.status = cookie ? "INVALID_LOGIN_RESPONSE" : "MISSING_SESSION_COOKIE";
    }

    addRequest(context, "authentication", login.result);
    if (!login.result.success) return;

    context.authenticatedClients += 1;
    const withinTestWindow = Date.now() < endAt;

    if (withinTestWindow) {
      context.activeAuthenticatedClients += 1;
      context.peakConcurrentAuthenticatedClients = Math.max(
        context.peakConcurrentAuthenticatedClients,
        context.activeAuthenticatedClients
      );
    }

    try {
      for (
        let warmup = 0;
        withinTestWindow && warmup < configuration.warmupRequests;
        warmup += 1
      ) {
        const result = await request(context, "warmup", protectedUrl, { cookie });
        addRequest(context, "warmup", result.result);
      }

      while (Date.now() < endAt) {
        const result = await request(context, "protected-request", protectedUrl, { cookie });
        addRequest(context, "protected-request", result.result);
      }
    } finally {
      if (withinTestWindow) context.activeAuthenticatedClients -= 1;

      const logout = await request(
        context,
        "logout",
        new URL("auth/logout", configuration.apiUrl),
        { method: "POST", cookie }
      );
      addRequest(context, "logout", logout.result);
    }
  }

  await Promise.all(
    Array.from({ length: configuration.clients }, (_, index) => clientWorker(index))
  );

  const elapsedMs = Number(process.hrtime.bigint() - startedAtHighResolution) / 1e6;
  const memoryAfter = process.memoryUsage();
  const cpuAfter = process.cpuUsage(cpuBefore);

  const authenticationSamples = context.samples.filter((sample) => sample.category === "authentication");
  const protectedSamples = context.samples.filter((sample) => sample.category === "protected-request");
  const authenticationSuccesses = authenticationSamples.filter((sample) => sample.success).length;
  const protectedLatency = summarizeLatency(protectedSamples);
  const statusCounts = statusBreakdown(context.samples);
  const successfulWithinTargetPercent = protectedLatency.successfulWithinTargetPercent ?? 0;

  const report = {
    scenario: "independent-authenticated-cookie-session-capacity",
    generatedAt: new Date().toISOString(),
    target: {
      environment: configuration.targetEnvironment,
      origin: configuration.apiUrl.origin,
    },
    system: {
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    workload: {
      requestedClients: configuration.clients,
      authenticationMode: configuration.useUniqueUsers
        ? `unique users with prefix ${configuration.usernamePrefix}`
        : "shared account (legacy mode)",
      durationSeconds: configuration.durationSeconds,
      rampUpSeconds: configuration.rampUpSeconds,
      warmupRequestsPerAuthenticatedClient: configuration.warmupRequests,
      timeoutMs: configuration.timeoutMs,
      elapsedMs: Number(elapsedMs.toFixed(3)),
      totalRequests: context.samples.length,
      successfulRequests: context.samples.filter((sample) => sample.success).length,
      failedRequests: context.samples.filter((sample) => !sample.success && !sample.expectedFailure).length,
      expectedFailureRequests: context.samples.filter((sample) => sample.expectedFailure).length,
      timedOutRequests: context.samples.filter((sample) => sample.status === "TIMEOUT").length,
      networkFailures: context.samples.filter((sample) => sample.status === "NETWORK_ERROR").length,
      requestsPerSecond: Number((context.samples.length / (elapsedMs / 1000)).toFixed(3)),
    },
    capacity: {
      successfullyAuthenticatedClients: context.authenticatedClients,
      distinctSessionCookies: context.sessionCookies.size,
      peakConcurrentAuthenticatedClients: context.peakConcurrentAuthenticatedClients,
      requestedConcurrencyAchieved: context.peakConcurrentAuthenticatedClients >= configuration.clients,
    },
    authenticationGuard: {
      endpoint: configuration.protectedPath,
      unauthenticatedStatus: unauthenticated.result.status,
      protectedEndpointVerified: true,
    },
    authentication: {
      attempts: authenticationSamples.length,
      successes: authenticationSuccesses,
      failures: authenticationSamples.length - authenticationSuccesses,
      successRatePercent: authenticationSamples.length
        ? Number((authenticationSuccesses / authenticationSamples.length * 100).toFixed(2))
        : 0,
      statusCounts: statusBreakdown(authenticationSamples),
    },
    latency: {
      authentication: summarizeLatency(authenticationSamples),
      protectedRequests: protectedLatency,
    },
    statusCounts,
    acceptance: {
      oneThousandSessionsAchieved: context.peakConcurrentAuthenticatedClients >= MAX_CLIENTS,
      fourSecondResponseTimeTargetPassed:
        protectedSamples.length > 0 &&
        successfulWithinTargetPercent >= SUCCESS_WITHIN_TARGET_PERCENT,
      responseTimePassRule:
        `at least ${SUCCESS_WITHIN_TARGET_PERCENT}% of measured protected requests must return 2xx within ${RESPONSE_TIME_TARGET_MS} ms`,
    },
    resources: {
      loadGenerator: {
        cpuTimeMs: Number(((cpuAfter.user + cpuAfter.system) / 1000).toFixed(3)),
        rssBeforeBytes: memoryBefore.rss,
        rssAfterBytes: memoryAfter.rss,
        heapUsedBeforeBytes: memoryBefore.heapUsed,
        heapUsedAfterBytes: memoryAfter.heapUsed,
      },
      apiServer: { observation: "Not measurable from the separate HTTP load-generator process." },
      database: { observation: "Not measurable through the HTTP API; no database resource metrics were collected." },
    },
    errors: context.errors,
    omittedErrorCount: context.omittedErrorCount,
  };

  return report;
}

async function writeReports(report, reportDirectory) {
  const resolvedDirectory = path.resolve(reportDirectory);
  await mkdir(resolvedDirectory, { recursive: true });

  const fileStem = `session-capacity-${report.generatedAt.replace(/[:.]/g, "-")}`;
  const jsonPath = path.join(resolvedDirectory, `${fileStem}.json`);
  const markdownPath = path.join(resolvedDirectory, `${fileStem}.md`);

  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  await writeFile(markdownPath, createMarkdownReport(report), { flag: "wx" });

  return { jsonPath, markdownPath };
}

async function main() {
  require("dotenv").config();
  const configuration = getConfiguration();

  if (configuration.useUniqueUsers) {
    console.log(
      `Using unique test users ${usernameForClient(configuration, 0)} through ${usernameForClient(configuration, configuration.clients - 1)}`
    );
  } else {
    console.warn("WARNING: shared-account mode is enabled; this is not an independent-user capacity test.");
  }

  const report = await runSessionCapacityTest(configuration);
  const reportPaths = await writeReports(report, configuration.reportDirectory);

  console.log(JSON.stringify({ report, reportPaths }, null, 2));

  if (
    report.workload.failedRequests > 0 ||
    !report.acceptance.oneThousandSessionsAchieved ||
    !report.acceptance.fourSecondResponseTimeTargetPassed
  ) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Session-capacity test could not complete: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  MAX_CLIENTS,
  createMarkdownReport,
  getConfiguration,
  runSessionCapacityTest,
  summarizeLatency,
  usernameForClient,
  writeReports,
};

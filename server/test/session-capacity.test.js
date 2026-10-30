const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { once } = require("node:events");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const {
  createMarkdownReport,
  getConfiguration,
  runSessionCapacityTest,
  summarizeLatency,
  writeReports,
} = require("../src/scripts/session-capacity-runner");

function validEnvironment(overrides = {}) {
  return {
    CONCURRENT_SESSIONS_USERNAME: "load.test.operator",
    CONCURRENT_SESSIONS_PASSWORD: "test-only-password",
    CONCURRENT_SESSIONS_CLIENTS: "2",
    CONCURRENT_SESSIONS_DURATION_SECONDS: "1",
    CONCURRENT_SESSIONS_RAMP_UP_SECONDS: "0",
    CONCURRENT_SESSIONS_WARMUP_REQUESTS: "0",
    ...overrides,
  };
}

async function createFakeApi({ loginStatus = 200, rejectProtected = false, responseDelayMs = 0 } = {}) {
  let nextSession = 0;
  const sessions = new Set();
  const server = createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    const send = (status, payload, headers = {}) => {
      response.writeHead(status, { "Content-Type": "application/json", ...headers });
      response.end(JSON.stringify(payload));
    };

    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      request.resume();
      if (loginStatus !== 200) return send(loginStatus, { message: "Invalid credentials." });
      nextSession += 1;
      const sessionId = `session-${nextSession}`;
      sessions.add(sessionId);
      return send(200, { user: { role: "STAFF" } }, {
        "Set-Cookie": `securebank.sid=${sessionId}; Path=/; HttpOnly`,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/auth/logout") {
      const sessionId = (request.headers.cookie || "").replace("securebank.sid=", "");
      sessions.delete(sessionId);
      return send(200, { message: "Signed out." });
    }

    if (request.method === "GET" && url.pathname === "/api/accounts") {
      const sessionId = (request.headers.cookie || "").replace("securebank.sid=", "");
      if (!sessionId || !sessions.has(sessionId) || rejectProtected) {
        return send(401, { message: "Session expired." });
      }
      if (responseDelayMs) {
        return setTimeout(() => send(200, { accounts: [] }), responseDelayMs);
      }
      return send(200, { accounts: [] });
    }

    return send(404, { message: "Not found." });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    apiUrl: `http://127.0.0.1:${server.address().port}/api`,
    server,
    sessions,
  };
}

async function closeServer(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

test("session capacity configuration accepts 1,000 clients and rejects invalid settings", () => {
  const configuration = getConfiguration(validEnvironment({
    CONCURRENT_SESSIONS_CLIENTS: "1000",
  }));
  assert.equal(configuration.clients, 1000);
  assert.equal(configuration.durationSeconds, 1);
  assert.equal(configuration.targetEnvironment, "local");
  assert.throws(
    () => getConfiguration(validEnvironment({ CONCURRENT_SESSIONS_CLIENTS: "1001" })),
    /between 1 and 1000/
  );
  assert.throws(
    () => getConfiguration(validEnvironment({ CONCURRENT_SESSIONS_TIMEOUT_MS: "99" })),
    /between 100 and 120000/
  );
  assert.throws(
    () => getConfiguration(validEnvironment({
      CONCURRENT_SESSIONS_DURATION_SECONDS: "5",
      CONCURRENT_SESSIONS_RAMP_UP_SECONDS: "6",
    })),
    /must not exceed the duration/
  );
  assert.throws(
    () => getConfiguration(validEnvironment({ CONCURRENT_SESSIONS_PASSWORD: "" })),
    /dedicated test credentials/
  );
  assert.throws(
    () => getConfiguration(validEnvironment({ CONCURRENT_SESSIONS_PROTECTED_PATH: "..\\admin" })),
    /relative API path/
  );
});

test("session capacity configuration protects production and remote targets", () => {
  assert.throws(
    () => getConfiguration(validEnvironment({
      CONCURRENT_SESSIONS_API_URL: "https://production.example.net/api",
      CONCURRENT_SESSIONS_ALLOW_REMOTE: "true",
      CONCURRENT_SESSIONS_TARGET_ENVIRONMENT: "staging",
    })),
    /Production-looking/
  );
  assert.throws(
    () => getConfiguration(validEnvironment({
      CONCURRENT_SESSIONS_API_URL: "https://test.example.net/api",
    })),
    /explicit opt-in/
  );
  assert.throws(
    () => getConfiguration(validEnvironment({
      CONCURRENT_SESSIONS_API_URL: "http://staging.example.net/api",
      CONCURRENT_SESSIONS_ALLOW_REMOTE: "true",
      CONCURRENT_SESSIONS_TARGET_ENVIRONMENT: "staging",
    })),
    /must use HTTPS/
  );
  assert.doesNotThrow(() => getConfiguration(validEnvironment({
    CONCURRENT_SESSIONS_API_URL: "https://staging.example.net/api",
    CONCURRENT_SESSIONS_ALLOW_REMOTE: "true",
    CONCURRENT_SESSIONS_TARGET_ENVIRONMENT: "staging",
  })));
  assert.doesNotThrow(() => getConfiguration(validEnvironment({
    CONCURRENT_SESSIONS_API_URL: "http://127.0.0.1:5000/api",
  })));
});

test("load runner creates independent cookie sessions and exercises only protected GETs", async () => {
  const api = await createFakeApi();
  const configuration = getConfiguration({
    ...validEnvironment(),
    CONCURRENT_SESSIONS_API_URL: api.apiUrl,
  });

  try {
    const report = await runSessionCapacityTest(configuration);
    assert.equal(report.workload.requestedClients, 2);
    assert.equal(report.capacity.successfullyAuthenticatedClients, 2);
    assert.equal(report.capacity.distinctSessionCookies, 2);
    assert.equal(report.capacity.peakConcurrentAuthenticatedClients, 2);
    assert.equal(report.authentication.successes, 2);
    assert.equal(report.capacity.requestedConcurrencyAchieved, true);
    assert.equal(report.workload.expectedFailureRequests, 1);
    assert.equal(
      report.workload.totalRequests,
      report.workload.successfulRequests + report.workload.failedRequests + 1
    );
    assert.ok(report.latency.protectedRequests.successfulRequests > 0);
    assert.equal(report.acceptance.oneThousandSessionsAchieved, false);
    assert.equal(report.acceptance.fourSecondResponseTimeTargetPassed, true);
    assert.equal(report.authenticationGuard.unauthenticatedStatus, 401);
    assert.equal(api.sessions.size, 0);
    assert.equal(report.errors.length, 0);
  } finally {
    await closeServer(api.server);
  }
});

test("mocked 1,000-client run reaches 1,000 distinct concurrent authenticated sessions", async () => {
  let nextSession = 0;
  const fetchImpl = async (input, options = {}) => {
    const url = new URL(input);
    if (url.pathname === "/api/auth/login" && options.method === "POST") {
      nextSession += 1;
      return new Response(JSON.stringify({ user: { role: "STAFF" } }), {
        status: 200,
        headers: { "Content-Type": "application/json", "Set-Cookie": `securebank.sid=session-${nextSession}; Path=/` },
      });
    }
    if (url.pathname === "/api/auth/logout" && options.method === "POST") {
      return new Response(JSON.stringify({ message: "Signed out." }), { status: 200 });
    }
    if (url.pathname === "/api/accounts" && !options.headers.Cookie) {
      return new Response(JSON.stringify({ message: "Authentication required." }), { status: 401 });
    }
    if (url.pathname === "/api/accounts") {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return new Response(JSON.stringify({ accounts: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ message: "Not found." }), { status: 404 });
  };
  const configuration = getConfiguration(validEnvironment({
    CONCURRENT_SESSIONS_CLIENTS: "1000",
  }));

  const report = await runSessionCapacityTest(configuration, { fetchImpl });
  assert.equal(report.workload.requestedClients, 1000);
  assert.equal(report.capacity.successfullyAuthenticatedClients, 1000);
  assert.equal(report.capacity.distinctSessionCookies, 1000);
  assert.equal(report.capacity.peakConcurrentAuthenticatedClients, 1000);
  assert.equal(report.acceptance.oneThousandSessionsAchieved, true);
  assert.ok(report.latency.protectedRequests.successfulRequests > 0);
});

test("login failures are reported without protected load and expired sessions are counted as failures", async () => {
  const invalidLoginApi = await createFakeApi({ loginStatus: 401 });
  try {
    const report = await runSessionCapacityTest(getConfiguration({
      ...validEnvironment(),
      CONCURRENT_SESSIONS_API_URL: invalidLoginApi.apiUrl,
    }));
    assert.equal(report.authentication.failures, 2);
    assert.equal(report.authentication.statusCounts["401"], 2);
    assert.equal(report.workload.failedRequests, 2);
    assert.equal(report.workload.expectedFailureRequests, 1);
    assert.equal(report.latency.protectedRequests.requests, 0);
    assert.equal(report.acceptance.fourSecondResponseTimeTargetPassed, false);
  } finally {
    await closeServer(invalidLoginApi.server);
  }

  const expiredSessionApi = await createFakeApi({ rejectProtected: true });
  try {
    const report = await runSessionCapacityTest(getConfiguration({
      ...validEnvironment(),
      CONCURRENT_SESSIONS_API_URL: expiredSessionApi.apiUrl,
    }));
    assert.equal(report.capacity.successfullyAuthenticatedClients, 2);
    assert.ok(report.latency.protectedRequests.failedRequests > 0);
    assert.ok(report.statusCounts["401"] > 0);
    assert.equal(report.acceptance.fourSecondResponseTimeTargetPassed, false);
  } finally {
    await closeServer(expiredSessionApi.server);
  }
});

test("load runner reports simulated timeout and network failures without leaking credentials", async () => {
  const api = await createFakeApi();
  const configuration = getConfiguration({
    ...validEnvironment(),
    CONCURRENT_SESSIONS_API_URL: api.apiUrl,
  });
  let protectedRequests = 0;
  const fetchImpl = async (url, options) => {
    if (options.headers.Cookie && new URL(url).pathname === "/api/accounts") {
      protectedRequests += 1;
      if (protectedRequests === 1) {
        throw Object.assign(new Error("simulated timeout"), { name: "TimeoutError" });
      }
      if (protectedRequests === 2) {
        throw Object.assign(new Error("simulated reset"), { code: "ECONNRESET" });
      }
    }
    return fetch(url, options);
  };

  try {
    const report = await runSessionCapacityTest(configuration, { fetchImpl });
    assert.ok(report.statusCounts.TIMEOUT >= 1);
    assert.ok(report.statusCounts.NETWORK_ERROR >= 1);
    assert.ok(report.errors.some((entry) => entry.status === "TIMEOUT"));
    const serialized = JSON.stringify(report);
    assert.equal(serialized.includes(configuration.password), false);
    assert.equal(serialized.includes(configuration.username), false);
  } finally {
    await closeServer(api.server);
  }
});

test("latency summary calculates mean, nearest-rank percentiles, threshold success, and empty results", () => {
  const summary = summarizeLatency([
    { success: true, durationMs: 100 },
    { success: true, durationMs: 2000 },
    { success: false, durationMs: 4000 },
    { success: true, durationMs: 5000 },
  ]);
  assert.equal(summary.meanMs, 2775);
  assert.equal(summary.p50Ms, 2000);
  assert.equal(summary.p95Ms, 5000);
  assert.equal(summary.p99Ms, 5000);
  assert.equal(summary.maxMs, 5000);
  assert.equal(summary.successfulWithinTarget, 2);
  assert.equal(summary.successfulWithinTargetPercent, 50);
  assert.deepEqual(summarizeLatency([]), {
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
    targetMs: 4000,
  });
});

test("report generation writes JSON and Markdown with explicit response-time rule", async () => {
  const api = await createFakeApi();
  const configuration = getConfiguration({
    ...validEnvironment(),
    CONCURRENT_SESSIONS_API_URL: api.apiUrl,
  });
  const reportDirectory = await mkdtemp(path.join(os.tmpdir(), "session-capacity-test-"));

  try {
    const report = await runSessionCapacityTest(configuration);
    const markdown = createMarkdownReport(report);
    assert.match(markdown, /at least 95%/);
    assert.match(markdown, /1,000-session target/);
    const files = await writeReports(report, reportDirectory);
    const jsonReport = JSON.parse(await readFile(files.jsonPath, "utf8"));
    const markdownReport = await readFile(files.markdownPath, "utf8");
    assert.equal(jsonReport.capacity.peakConcurrentAuthenticatedClients, 2);
    assert.match(markdownReport, /Four-second target/);
    assert.equal(path.dirname(files.jsonPath), reportDirectory);
  } finally {
    await closeServer(api.server);
    await rm(reportDirectory, { recursive: true, force: true });
  }
});

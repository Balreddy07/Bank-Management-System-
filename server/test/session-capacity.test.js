const assert = require("node:assert/strict");
const test = require("node:test");
const { performance } = require("node:perf_hooks");
const {
  getConfiguration,
  getExitCode,
  runSessionLoadTest,
  summarizeLatency,
} = require("../scripts/session-benchmark");

function config(overrides = {}) {
  return {
    apiBaseUrl: "http://127.0.0.1:5000/api/",
    username: "test-user",
    password: "test-password",
    targetSessions: 2,
    concurrency: 2,
    durationMs: 1000,
    rampUpMs: 0,
    requestIntervalMs: 100,
    requestTimeoutMs: 1000,
    protectedPath: "/api/accounts",
    allowRemote: false,
    targetEnvironment: "local",
    dryRun: false,
    ...overrides,
  };
}

function response({ status = 200, cookie = "" } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      getSetCookie: () => cookie ? [`securebank.sid=${cookie}; Path=/; HttpOnly`] : [],
      get: () => null,
    },
  };
}

test("configuration parses session target, request concurrency, duration and ramp-up", () => {
  const parsed = getConfiguration([
    "--target-sessions", "12",
    "--concurrency", "4",
    "--duration-ms", "5000",
    "--ramp-up-ms", "1000",
    "--request-interval-ms", "250",
  ], {
    LOAD_TEST_USERNAME: "operator",
    LOAD_TEST_PASSWORD: "secret",
  });

  assert.equal(parsed.targetSessions, 12);
  assert.equal(parsed.concurrency, 4);
  assert.equal(parsed.durationMs, 5000);
  assert.equal(parsed.rampUpMs, 1000);
  assert.equal(parsed.requestIntervalMs, 250);
  assert.equal(parsed.apiBaseUrl, "http://127.0.0.1:5000/api/");
});

test("configuration rejects invalid values and unsafe remote targets", () => {
  assert.throws(() => getConfiguration(["--concurrency", "0"]), /LOAD_TEST_CONCURRENCY/);
  assert.throws(() => getConfiguration(["--ramp-up-ms", "2000", "--duration-ms", "1000"]), /must not exceed/);
  assert.throws(() => getConfiguration(["--base-url", "https://production.example.com"]), /Production-looking/);
  assert.throws(() => getConfiguration(["--base-url", "https://staging.example.com"]), /Remote targets require/);
});

test("dry-run makes no requests and reports no measured success", async () => {
  let requestCount = 0;
  const report = await runSessionLoadTest(config({
    dryRun: true,
    password: "do-not-print",
  }), {
    fetch: async () => {
      requestCount += 1;
      throw new Error("Dry-run must not make requests.");
    },
  });

  assert.equal(requestCount, 0);
  assert.equal(report.mode, "dry-run");
  assert.equal(report.status, "not-run");
  assert.equal(report.targetMet, null);
  assert.equal(report.config.password, "[REDACTED]");
  assert.equal(report.config.username, "[REDACTED]");
  assert.equal(report.achievedPeakActiveConcurrency, 0);
  assert.equal(getExitCode(report), 0);
});

test("live run measures active authenticated sessions, throughput, latency, and client resources", async () => {
  let cookieIndex = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  const fetch = async (url, options) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 2));
    inFlight -= 1;
    if (String(url).endsWith("/auth/login")) {
      cookieIndex += 1;
      return response({ cookie: `session-${cookieIndex}` });
    }
    assert.match(options.headers.Cookie, /^securebank\.sid=session-/);
    return response();
  };

  const report = await runSessionLoadTest(config({
    durationMs: 120,
    requestIntervalMs: 10,
    requestTimeoutMs: 500,
  }), { fetch });

  assert.equal(report.mode, "live");
  assert.equal(report.status, "passed");
  assert.equal(report.criteria.targetMet, true);
  assert.equal(getExitCode(report), 0);
  assert.equal(report.workload.achievedPeakActiveConcurrency, 2);
  assert.equal(report.authentication.successful, 2);
  assert.equal(report.authentication.failed, 0);
  assert.ok(report.protectedRequests.successful >= 2);
  assert.ok(report.protectedRequests.throughputPerSecond > 0);
  assert.ok(report.protectedRequests.latency.p95Ms <= 4000);
  assert.ok(report.workload.maxInFlightRequests <= 2);
  assert.ok(maxInFlight <= 2);
  assert.ok(report.resourceUsage.cpuTimeMs >= 0);
  assert.ok(report.resourceUsage.peakRssBytes > 0);
  assert.match(report.criteria.projectEvaluation, /p95/);
  assert.match(report.criteria.issueWording, /without defining a percentile/);
});

test("ramp-up staggers session creation instead of starting every login at once", async () => {
  const loginStartedAt = [];
  const fetch = async (url) => {
    if (String(url).endsWith("/auth/login")) {
      loginStartedAt.push(performance.now());
      return response({ cookie: `session-${loginStartedAt.length}` });
    }
    return response();
  };
  const report = await runSessionLoadTest(config({
    targetSessions: 3,
    durationMs: 400,
    rampUpMs: 120,
    requestIntervalMs: 500,
  }), { fetch });

  assert.equal(report.authentication.successful, 3);
  assert.equal(report.workload.achievedPeakActiveConcurrency, 3);
  assert.equal(loginStartedAt.length, 3);
  assert.ok(loginStartedAt[2] - loginStartedAt[0] >= 90);
});

test("protected-request latency includes streaming the full response body", async () => {
  const report = await runSessionLoadTest(config({
    targetSessions: 1,
    durationMs: 80,
    requestIntervalMs: 100,
  }), {
    fetch: async (url) => {
      if (String(url).endsWith("/auth/login")) return response({ cookie: "body-test-session" });
      if (String(url).endsWith("/auth/logout")) return response();
      return new Response(new ReadableStream({
        start(controller) {
          setTimeout(() => {
            controller.enqueue(new TextEncoder().encode("protected response"));
            controller.close();
          }, 20);
        },
      }));
    },
  });

  assert.equal(report.protectedRequests.successful, 1);
  assert.ok(report.protectedRequests.latency.p95Ms >= 15);
});

test("authentication rejection and missing session cookie are measured as failures", async () => {
  let loginCount = 0;
  const report = await runSessionLoadTest(config({
    targetSessions: 3,
    durationMs: 1000,
  }), {
    fetch: async (url) => {
      if (!String(url).endsWith("/auth/login")) throw new Error("Unexpected protected request.");
      loginCount += 1;
      if (loginCount === 1) return response({ status: 429 });
      if (loginCount === 2) return response();
      throw new Error("A network error must not be copied to the report.");
    },
  });

  assert.equal(report.status, "failed");
  assert.equal(getExitCode(report), 1);
  assert.equal(report.criteria.targetMet, false);
  assert.equal(report.authentication.attempted, 3);
  assert.equal(report.authentication.failed, 3);
  assert.equal(report.protectedRequests.attempted, 0);
  assert.equal(report.errors.count, 3);
  assert.ok(report.errors.samples.some((entry) => entry.status === 429));
  assert.ok(report.errors.samples.some((entry) => entry.kind === "authentication-request-failed"));
});

test("protected-request failures end a session and fail the measured target", async () => {
  const report = await runSessionLoadTest(config({
    targetSessions: 1,
    durationMs: 1000,
  }), {
    fetch: async (url) => {
      if (String(url).endsWith("/auth/login")) return response({ cookie: "valid-session" });
      if (String(url).endsWith("/auth/logout")) return response();
      return response({ status: 401 });
    },
  });

  assert.equal(report.status, "failed");
  assert.equal(getExitCode(report), 1);
  assert.equal(report.workload.achievedPeakActiveConcurrency, 0);
  assert.equal(report.authentication.successful, 1);
  assert.equal(report.protectedRequests.failed, 1);
  assert.equal(report.sessionCleanup.successfulLogouts, 1);
  assert.equal(report.errors.samples[0].kind, "protected-request-rejected");
});

test("latency summary uses nearest-rank percentiles and empty samples remain unmeasured", () => {
  assert.deepEqual(summarizeLatency([1, 2, 3, 4, 5]), {
    count: 5,
    averageMs: 3,
    medianMs: 3,
    p95Ms: 5,
    p99Ms: 5,
    minMs: 1,
    maxMs: 5,
  });
  assert.equal(summarizeLatency([]).p95Ms, null);
});

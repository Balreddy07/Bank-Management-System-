const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { once } = require("node:events");
const { randomUUID } = require("node:crypto");
const test = require("node:test");
const { getConfiguration, runLoadTest } = require("../src/scripts/concurrent-load-runner");

const ACCOUNT_NUMBER = "7811288401";

function validEnvironment(overrides = {}) {
  return {
    CONCURRENT_LOAD_ALLOW_MUTATIONS: "true",
    CONCURRENT_LOAD_ACCOUNT_NUMBER: ACCOUNT_NUMBER,
    CONCURRENT_LOAD_USERNAME: "load.test.operator",
    CONCURRENT_LOAD_PASSWORD: "test-only-password",
    ...overrides,
  };
}

function sendJson(response, status, value, headers = {}) {
  response.writeHead(status, { "Content-Type": "application/json", ...headers });
  response.end(JSON.stringify(value));
}

async function createFakeApi() {
  let balanceCents = 250000n;
  const transactions = [];
  const idempotencyRecords = new Map();
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (request.method === "POST" && url.pathname === "/api/auth/login") {
      request.resume();
      return sendJson(response, 200, { user: { role: "STAFF" } }, {
        "Set-Cookie": "securebank.sid=test-session; Path=/; HttpOnly",
      });
    }
    if (request.headers.cookie !== "securebank.sid=test-session") {
      return sendJson(response, 401, { message: "Authentication required." });
    }

    if (request.method === "GET" && url.pathname === `/api/accounts/${ACCOUNT_NUMBER}`) {
      return sendJson(response, 200, {
        account: { accountNumber: ACCOUNT_NUMBER, balance: formatBalance(balanceCents), status: "ACTIVE" },
      });
    }

    if (request.method === "POST" && /^\/api\/transactions\/(deposit|withdraw)$/.test(url.pathname)) {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const key = request.headers["idempotency-key"];
      const cached = idempotencyRecords.get(key);
      if (cached) {
        return sendJson(response, 201, {
          account: { accountNumber: ACCOUNT_NUMBER, balance: cached.balanceAfter },
          transaction: cached,
        });
      }

      const operation = url.pathname.endsWith("/deposit") ? "DEPOSIT" : "WITHDRAWAL";
      const amountCents = BigInt(Math.round(body.amount * 100));
      const nextBalanceCents = operation === "DEPOSIT"
        ? balanceCents + amountCents
        : balanceCents - amountCents;
      if (operation === "WITHDRAWAL" && nextBalanceCents < 100000n) {
        return sendJson(response, 422, { message: "Minimum balance required." });
      }
      balanceCents = nextBalanceCents;
      const receipt = {
        transactionRef: randomUUID(),
        type: operation,
        amount: (Number(amountCents) / 100).toFixed(2),
        balanceAfter: formatBalance(balanceCents),
        createdAt: new Date("2026-10-28T12:00:00.000Z").toISOString(),
      };
      transactions.push(receipt);
      idempotencyRecords.set(key, receipt);
      return sendJson(response, 201, {
        account: { accountNumber: ACCOUNT_NUMBER, balance: receipt.balanceAfter },
        transaction: receipt,
      });
    }

    if (request.method === "GET" && url.pathname === "/api/transactions") {
      return sendJson(response, 200, {
        account: { accountNumber: ACCOUNT_NUMBER, balance: formatBalance(balanceCents), status: "ACTIVE" },
        transactions: [...transactions].reverse().slice(0, 50),
      });
    }

    const receiptMatch = /^\/api\/transactions\/([0-9a-f-]{36})$/i.exec(url.pathname);
    if (request.method === "GET" && receiptMatch) {
      const transaction = transactions.find((item) => item.transactionRef === receiptMatch[1]);
      return transaction
        ? sendJson(response, 200, { transaction: { ...transaction, accountNumber: ACCOUNT_NUMBER } })
        : sendJson(response, 404, { message: "Not found." });
    }

    return sendJson(response, 404, { message: "Not found." });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    apiUrl: `http://127.0.0.1:${server.address().port}/api`,
    server,
    transactions,
    get balance() { return formatBalance(balanceCents); },
  };
}

function formatBalance(cents) {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

test("concurrent-load configuration requires explicit mutation opt-in and accepts 500 VUs", () => {
  assert.throws(() => getConfiguration({}), /ALLOW_MUTATIONS/);
  const configuration = getConfiguration(validEnvironment({ CONCURRENT_LOAD_VUS: "500" }));
  assert.equal(configuration.virtualUsers, 500);
  assert.equal(configuration.durationSeconds, 30);
  assert.equal(configuration.rampUpSeconds, 10);
  assert.throws(
    () => getConfiguration(validEnvironment({ CONCURRENT_LOAD_VUS: "501" })),
    /between 1 and 500/
  );
  assert.throws(() => getConfiguration(validEnvironment({
    CONCURRENT_LOAD_DURATION_SECONDS: "5",
    CONCURRENT_LOAD_RAMP_UP_SECONDS: "6",
  })), /must not exceed the duration/);
});

test("remote and production load-test targets are guarded", () => {
  assert.throws(() => getConfiguration(validEnvironment({
    CONCURRENT_LOAD_API_URL: "https://test.example.net/api",
  })), /explicit opt-in/);
  assert.throws(() => getConfiguration(validEnvironment({
    CONCURRENT_LOAD_API_URL: "https://api.example.net/api",
    CONCURRENT_LOAD_ALLOW_REMOTE: "true",
    CONCURRENT_LOAD_TARGET_ENVIRONMENT: "production",
  })), /Production/);
  assert.throws(() => getConfiguration(validEnvironment({
    CONCURRENT_LOAD_API_URL: "https://production-api.example.net/api",
    CONCURRENT_LOAD_ALLOW_REMOTE: "true",
    CONCURRENT_LOAD_TARGET_ENVIRONMENT: "staging",
  })), /Production-looking/);
  const staging = getConfiguration(validEnvironment({
    CONCURRENT_LOAD_API_URL: "https://staging.example.net/api",
    CONCURRENT_LOAD_ALLOW_REMOTE: "true",
    CONCURRENT_LOAD_TARGET_ENVIRONMENT: "staging",
  }));
  assert.equal(staging.targetEnvironment, "staging");
});

test("short concurrent run checks authenticated reads, idempotency, receipts, and balance reconciliation", async () => {
  const api = await createFakeApi();
  const configuration = getConfiguration(validEnvironment({
    CONCURRENT_LOAD_API_URL: api.apiUrl,
    CONCURRENT_LOAD_VUS: "2",
    CONCURRENT_LOAD_DURATION_SECONDS: "1",
    CONCURRENT_LOAD_RAMP_UP_SECONDS: "0",
  }));

  try {
    const report = await runLoadTest(configuration);
    assert.equal(report.workload.configuredVirtualUsers, 2);
    assert.equal(report.workload.peakActiveVirtualUsers, 2);
    assert.ok(report.workload.requestCount > 0);
    assert.ok(report.workload.transactionRequestCount > 0);
    assert.ok(report.latency.transactions.p50Ms >= 0);
    assert.equal(report.integrity.failureCount, 0);
    assert.equal(report.integrity.balanceReconciled, true);
    assert.equal(report.integrity.historyConsistent, true);
    assert.ok(report.integrity.finalHistoryRecordCount > 0);
    assert.equal(report.integrity.actualFinalBalance, api.balance);
    assert.equal(new Set(api.transactions.map((transaction) => transaction.transactionRef)).size, api.transactions.length);
    assert.ok(api.transactions.every((transaction) => transaction.balanceAfter >= "1000.00"));
    if (process.env.CONCURRENT_LOAD_PRINT_SMOKE_METRICS === "true") {
      console.log(JSON.stringify({
        smoke: true,
        virtualUsers: report.workload.peakActiveVirtualUsers,
        durationMs: report.workload.elapsedMs,
        transactionLatency: report.latency.transactions,
        requestsPerSecond: report.workload.requestsPerSecond,
        errorCount: report.errors.length + report.omittedErrorCount,
        integrityFailureCount: report.integrity.failureCount,
        balanceReconciled: report.integrity.balanceReconciled,
      }));
    }
  } finally {
    await new Promise((resolve, reject) => {
      api.server.close((error) => error ? reject(error) : resolve());
    });
  }
});
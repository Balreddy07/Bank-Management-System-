const assert = require("node:assert/strict");
const { createServer } = require("node:http");
const { once } = require("node:events");
const test = require("node:test");
const { measureTransaction } = require("../src/scripts/benchmark-transactions");
const { summarizeTransactionSamples } = require("../src/scripts/transaction-performance-metrics");

test("HTTP benchmark measures both deposit and withdrawal response durations", async () => {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({
      method: request.method,
      path: request.url,
      cookie: request.headers.cookie,
      idempotencyKey: request.headers["idempotency-key"],
    });
    request.resume();
    response.writeHead(201, { "Content-Type": "application/json" });
    response.end(JSON.stringify({
      account: { balance: "1001.00" },
      transaction: { transactionRef: "test-reference" },
    }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const apiUrl = new URL(`http://127.0.0.1:${server.address().port}/api/`);
    const configuration = { amount: 1, accountNumber: "7811288401" };
    const samples = await Promise.all([
      measureTransaction(apiUrl, "session=test", configuration, 0),
      measureTransaction(apiUrl, "session=test", configuration, 1),
    ]);

    assert.deepEqual(requests.map((request) => request.path), [
      "/api/transactions/deposit",
      "/api/transactions/withdraw",
    ]);
    assert.ok(requests.every((request) => request.method === "POST"));
    assert.ok(requests.every((request) => request.cookie === "session=test"));
    assert.ok(requests.every((request) => request.idempotencyKey === undefined));
    assert.deepEqual(samples.map((sample) => sample.status), [201, 201]);
    assert.ok(samples.every((sample) => Number.isFinite(sample.durationMs) && sample.durationMs >= 0));
  } finally {
    await new Promise((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("transaction latency summary calculates nearest-rank percentiles and success counts", () => {
  const samples = Array.from({ length: 100 }, (_, index) => ({
    index: index + 1,
    operation: index % 2 === 0 ? "deposit" : "withdraw",
    status: index < 99 ? 201 : 503,
    durationMs: index + 1,
  }));

  assert.deepEqual(summarizeTransactionSamples(samples), {
    requests: 100,
    successful: 99,
    failed: 1,
    p50Ms: 50,
    p95Ms: 95,
    p99Ms: 99,
    maxMs: 100,
    withinThreshold: 100,
    thresholdMs: 2000,
    slowRequests: [],
  });
});

test("transaction latency summary identifies each response exceeding the target", () => {
  const samples = [
    { index: 1, operation: "deposit", status: 201, durationMs: 1999.9 },
    { index: 2, operation: "withdraw", status: 201, durationMs: 2000 },
    { index: 3, operation: "deposit", status: 503, durationMs: 2000.1 },
  ];

  const summary = summarizeTransactionSamples(samples);

  assert.equal(summary.withinThreshold, 2);
  assert.deepEqual(summary.slowRequests, [
    { index: 3, operation: "deposit", status: 503, durationMs: 2000.1 },
  ]);
  assert.equal(summary.failed, 1);
});

test("transaction latency summary rejects empty or invalid samples", () => {
  assert.throws(() => summarizeTransactionSamples([]), /at least one/i);
  assert.throws(() => summarizeTransactionSamples([{ durationMs: -1, status: 201 }]), /finite/i);
  assert.throws(() => summarizeTransactionSamples([{ durationMs: 1, status: 201 }], 0), /positive/i);
});

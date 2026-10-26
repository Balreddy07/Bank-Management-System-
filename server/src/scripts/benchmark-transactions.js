const os = require("node:os");
const { summarizeTransactionSamples } = require("./transaction-performance-metrics");

const THRESHOLD_MS = 2000;

function getConfiguration() {
  const apiBaseUrl = process.env.TRANSACTION_BENCHMARK_API_URL || "http://localhost:5000/api";
  const accountNumber = process.env.TRANSACTION_BENCHMARK_ACCOUNT_NUMBER;
  const username = process.env.TRANSACTION_BENCHMARK_USERNAME;
  const password = process.env.TRANSACTION_BENCHMARK_PASSWORD;
  const requests = Number(process.env.TRANSACTION_BENCHMARK_REQUESTS || 100);
  const concurrency = Number(process.env.TRANSACTION_BENCHMARK_CONCURRENCY || 1);
  const amount = Number(process.env.TRANSACTION_BENCHMARK_AMOUNT || 1);

  if (process.env.TRANSACTION_BENCHMARK_ALLOW_MUTATIONS !== "true") {
    throw new Error("Set TRANSACTION_BENCHMARK_ALLOW_MUTATIONS=true only for a disposable test database.");
  }
  if (!/^\d{10}$/.test(accountNumber || "")) {
    throw new Error("Set TRANSACTION_BENCHMARK_ACCOUNT_NUMBER to the dedicated test account.");
  }
  if (!username || !password) {
    throw new Error("Set the benchmark's test-user username and password environment variables.");
  }
  if (!Number.isSafeInteger(requests) || requests < 2 || requests % 2 !== 0) {
    throw new Error("TRANSACTION_BENCHMARK_REQUESTS must be an even integer of at least 2.");
  }
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > requests) {
    throw new Error("TRANSACTION_BENCHMARK_CONCURRENCY must be between 1 and the request count.");
  }
  if (!Number.isFinite(amount) || amount <= 0 || Math.round(amount * 100) !== amount * 100) {
    throw new Error("TRANSACTION_BENCHMARK_AMOUNT must be positive with at most two decimal places.");
  }

  let apiUrl;
  try {
    apiUrl = new URL(apiBaseUrl);
  } catch {
    throw new Error("TRANSACTION_BENCHMARK_API_URL must be an absolute HTTP or HTTPS URL.");
  }
  if (!["http:", "https:"].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password) {
    throw new Error("Use an HTTP or HTTPS API URL without embedded credentials.");
  }
  if (!["localhost", "127.0.0.1", "::1"].includes(apiUrl.hostname) &&
      process.env.TRANSACTION_BENCHMARK_ALLOW_REMOTE !== "true") {
    throw new Error("Set TRANSACTION_BENCHMARK_ALLOW_REMOTE=true to use a remote disposable test system.");
  }
  if (apiUrl.pathname !== "/" && !apiUrl.pathname.endsWith("/")) {
    apiUrl.pathname += "/";
  }

  return { apiUrl, accountNumber, username, password, requests, concurrency, amount };
}

async function signIn(apiUrl, username, password) {
  const response = await fetch(new URL("auth/login", apiUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, password }),
    signal: AbortSignal.timeout(30000),
  });
  await response.arrayBuffer();
  if (!response.ok) {
    throw new Error(`Benchmark sign-in failed with HTTP ${response.status}; no transactions were sent.`);
  }

  const cookies = response.headers.getSetCookie()
    .map((cookie) => cookie.split(";", 1)[0])
    .filter(Boolean)
    .join("; ");
  if (!cookies) {
    throw new Error("Benchmark sign-in returned no session cookie; no transactions were sent.");
  }
  return cookies;
}

async function measureTransaction(apiUrl, cookie, configuration, index) {
  const operation = index % 2 === 0 ? "deposit" : "withdraw";
  const start = process.hrtime.bigint();
  let status = "NETWORK_ERROR";

  try {
    const response = await fetch(new URL(`transactions/${operation}`, apiUrl), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Cookie: cookie,
      },
      body: JSON.stringify({
        accountNumber: configuration.accountNumber,
        amount: configuration.amount,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const responseBody = await response.arrayBuffer();
    if (response.status === 201) {
      try {
        const receipt = JSON.parse(Buffer.from(responseBody).toString("utf8"));
        status = receipt?.account && receipt?.transaction ? response.status : "INVALID_RESPONSE";
      } catch {
        status = "INVALID_RESPONSE";
      }
    } else {
      status = response.status;
    }
  } catch {
    status = "NETWORK_ERROR";
  }

  return {
    index: index + 1,
    operation,
    status,
    durationMs: Number(process.hrtime.bigint() - start) / 1e6,
  };
}

async function runBenchmark() {
  const configuration = getConfiguration();
  const cookie = await signIn(
    configuration.apiUrl,
    configuration.username,
    configuration.password
  );
  const samples = new Array(configuration.requests);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= configuration.requests) return;
      samples[index] = await measureTransaction(
        configuration.apiUrl,
        cookie,
        configuration,
        index
      );
    }
  }

  const benchmarkStart = process.hrtime.bigint();
  await Promise.all(
    Array.from({ length: configuration.concurrency }, () => worker())
  );
  const benchmarkElapsedMs = Number(process.hrtime.bigint() - benchmarkStart) / 1e6;

  const totalRequestTimeMs = samples.reduce((total, sample) => total + sample.durationMs, 0);
  const byOperation = Object.fromEntries(["deposit", "withdraw"].map((operation) => [
    operation,
    summarizeTransactionSamples(samples.filter((sample) => sample.operation === operation), THRESHOLD_MS),
  ]));
  const summary = summarizeTransactionSamples(samples, THRESHOLD_MS);

  console.log(JSON.stringify({
    benchmark: "deposit-withdrawal-http-response-time",
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      logicalCpuCount: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
      apiOrigin: configuration.apiUrl.origin,
      databaseVersion: process.env.TRANSACTION_BENCHMARK_DATABASE_VERSION || "not supplied",
      connectionPoolLimit: process.env.TRANSACTION_BENCHMARK_POOL_LIMIT || "not supplied",
      datasetSize: process.env.TRANSACTION_BENCHMARK_DATASET_SIZE || "not supplied",
    },
    workload: {
      requests: configuration.requests,
      concurrency: configuration.concurrency,
      operationPattern: "alternating deposit and withdrawal",
      amount: configuration.amount,
      warmupRequests: 0,
      timeoutMs: 30000,
      benchmarkElapsedMs: Number(benchmarkElapsedMs.toFixed(3)),
      requestsPerSecond: Number((samples.length / (benchmarkElapsedMs / 1000)).toFixed(3)),
      totalRequestTimeMs: Number(totalRequestTimeMs.toFixed(3)),
    },
    overall: summary,
    byOperation,
    nfr1Achieved: summary.successful === summary.requests &&
      summary.withinThreshold / summary.requests >= 0.95,
  }, null, 2));

  if (summary.failed > 0) process.exitCode = 1;
}

if (require.main === module) {
  require("dotenv").config();
  runBenchmark().catch((error) => {
    console.error(`Transaction benchmark could not complete: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { getConfiguration, measureTransaction };

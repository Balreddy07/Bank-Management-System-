const os = require("node:os");
const { randomUUID } = require("node:crypto");
const { summarizeTransactionSamples } = require("./transaction-performance-metrics");

const MAX_VIRTUAL_USERS = 500;
const MAX_DURATION_SECONDS = 3600;
const TRANSACTION_THRESHOLD_MS = 2000;
const MIN_BALANCE_CENTS = 100000n;
const MAX_BALANCE_CENTS = 999999999999n;

function parseInteger(value, name, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function parseAmount(value) {
  const text = String(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) {
    throw new Error("CONCURRENT_LOAD_AMOUNT must be positive with at most two decimal places.");
  }
  const [whole, fraction = ""] = text.split(".");
  const cents = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (cents <= 0n || cents > MAX_BALANCE_CENTS) {
    throw new Error("CONCURRENT_LOAD_AMOUNT is outside the supported monetary range.");
  }
  return { amount: Number(cents) / 100, amountText: `${whole}.${fraction.padEnd(2, "0")}`, amountCents: cents };
}

function parseMoneyCents(value) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return null;
  return BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
}

function formatMoneyCents(cents) {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function getConfiguration(environment = process.env) {
  if (environment.CONCURRENT_LOAD_ALLOW_MUTATIONS !== "true") {
    throw new Error("Set CONCURRENT_LOAD_ALLOW_MUTATIONS=true only for a dedicated disposable test account.");
  }

  const accountNumber = environment.CONCURRENT_LOAD_ACCOUNT_NUMBER;
  const username = environment.CONCURRENT_LOAD_USERNAME;
  const password = environment.CONCURRENT_LOAD_PASSWORD;
  if (!/^\d{10}$/.test(accountNumber || "")) {
    throw new Error("Set CONCURRENT_LOAD_ACCOUNT_NUMBER to a dedicated test account.");
  }
  if (!username || !password) {
    throw new Error("Set the concurrent-load test user's username and password.");
  }

  let apiUrl;
  try {
    apiUrl = new URL(environment.CONCURRENT_LOAD_API_URL || "http://127.0.0.1:5000/api");
  } catch {
    throw new Error("CONCURRENT_LOAD_API_URL must be an absolute HTTP or HTTPS URL.");
  }
  if (!["http:", "https:"].includes(apiUrl.protocol) || apiUrl.username || apiUrl.password) {
    throw new Error("Use an HTTP or HTTPS API URL without embedded credentials.");
  }
  if (apiUrl.pathname !== "/" && !apiUrl.pathname.endsWith("/")) apiUrl.pathname += "/";

  const hostname = apiUrl.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (hostname.split(/[.-]/).some((label) => label === "prod" || label === "production")) {
    throw new Error("Production-looking targets are blocked; use a dedicated local, test, or staging system.");
  }
  const localHosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const isLocal = localHosts.has(hostname);
  const targetEnvironment = String(
    environment.CONCURRENT_LOAD_TARGET_ENVIRONMENT || (isLocal ? "local" : "")
  ).toLowerCase();
  if (targetEnvironment === "production") {
    throw new Error("Production targets are not permitted.");
  }
  if (!isLocal && (
    environment.CONCURRENT_LOAD_ALLOW_REMOTE !== "true" ||
    !["test", "staging"].includes(targetEnvironment)
  )) {
    throw new Error("Remote targets require explicit opt-in and CONCURRENT_LOAD_TARGET_ENVIRONMENT=test or staging.");
  }

  const virtualUsers = parseInteger(
    environment.CONCURRENT_LOAD_VUS || 10,
    "CONCURRENT_LOAD_VUS",
    1,
    MAX_VIRTUAL_USERS
  );
  const durationSeconds = parseInteger(
    environment.CONCURRENT_LOAD_DURATION_SECONDS || 30,
    "CONCURRENT_LOAD_DURATION_SECONDS",
    1,
    MAX_DURATION_SECONDS
  );
  const rampUpSeconds = parseInteger(
    environment.CONCURRENT_LOAD_RAMP_UP_SECONDS || 10,
    "CONCURRENT_LOAD_RAMP_UP_SECONDS",
    0,
    MAX_DURATION_SECONDS
  );
  if (rampUpSeconds > durationSeconds) {
    throw new Error("CONCURRENT_LOAD_RAMP_UP_SECONDS must not exceed the duration.");
  }
  const timeoutMs = parseInteger(
    environment.CONCURRENT_LOAD_TIMEOUT_MS || 10000,
    "CONCURRENT_LOAD_TIMEOUT_MS",
    100,
    120000
  );

  return {
    apiUrl,
    accountNumber,
    username,
    password,
    virtualUsers,
    durationSeconds,
    rampUpSeconds,
    timeoutMs,
    ...parseAmount(environment.CONCURRENT_LOAD_AMOUNT || "1.00"),
    targetEnvironment,
  };
}

function addIntegrityFailure(context, code) {
  context.integrityFailures.push(code);
}

function addError(context, endpoint, status) {
  if (context.errors.length < 50) context.errors.push({ endpoint, status });
  else context.omittedErrorCount += 1;
}

async function requestApi(context, endpoint, path, {
  method = "GET",
  body,
  idempotencyKey,
  expectedStatus = 200,
} = {}) {
  const startedAt = process.hrtime.bigint();
  const headers = { Cookie: context.cookie };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;

  try {
    const response = await context.fetchImpl(new URL(path, context.configuration.apiUrl), {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(context.configuration.timeoutMs),
    });
    const responseText = await response.text();
    let payload = null;
    try {
      payload = responseText ? JSON.parse(responseText) : null;
    } catch {
      addIntegrityFailure(context, "invalid-json-response");
    }
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const result = { endpoint, status: response.status, durationMs, payload };
    context.requestSamples.push(result);
    if (response.status !== expectedStatus) addError(context, endpoint, response.status);
    return result;
  } catch (error) {
    const status = error.name === "TimeoutError" || error.name === "AbortError"
      ? "TIMEOUT"
      : "NETWORK_ERROR";
    const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
    const result = { endpoint, status, durationMs, payload: null };
    context.requestSamples.push(result);
    addError(context, endpoint, status);
    return result;
  }
}

async function signIn(configuration, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(new URL("auth/login", configuration.apiUrl), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: configuration.username, password: configuration.password }),
      signal: AbortSignal.timeout(configuration.timeoutMs),
    });
  } catch {
    throw new Error("Test-user sign-in failed; no load requests were sent.");
  }
  await response.arrayBuffer();
  if (!response.ok) throw new Error(`Test-user sign-in failed with HTTP ${response.status}; no load requests were sent.`);

  const cookies = typeof response.headers.getSetCookie === "function"
    ? response.headers.getSetCookie()
    : [response.headers.get("set-cookie") || ""];
  const cookie = cookies.map((value) => value.split(";", 1)[0]).filter(Boolean).join("; ");
  if (!cookie) throw new Error("Test-user sign-in returned no session cookie; no load requests were sent.");
  return cookie;
}

function isValidReceipt(receipt, operation, configuration) {
  return Boolean(
    receipt &&
    /^[0-9a-f-]{36}$/i.test(receipt.transactionRef || "") &&
    receipt.type === operation &&
    parseMoneyCents(receipt.amount) === configuration.amountCents &&
    parseMoneyCents(receipt.balanceAfter) !== null &&
    receipt.createdAt
  );
}

function sameReceipt(left, right) {
  return left.transactionRef === right.transactionRef &&
    left.type === right.type &&
    left.amount === right.amount &&
    left.balanceAfter === right.balanceAfter &&
    String(left.createdAt) === String(right.createdAt);
}

async function verifyReceipt(context, receipt) {
  const result = await requestApi(
    context,
    "transaction-receipt",
    `transactions/${encodeURIComponent(receipt.transactionRef)}`
  );
  const actual = result.payload?.transaction;
  if (result.status !== 200 || !actual || !sameReceipt(receipt, actual)) {
    addIntegrityFailure(context, "receipt-mismatch");
    return false;
  }
  return true;
}

async function runLogicalTransaction(context, operation, virtualUser, sequence) {
  const endpoint = `transaction-${operation.toLowerCase()}`;
  const path = `transactions/${operation === "DEPOSIT" ? "deposit" : "withdraw"}`;
  const idempotencyKey = `load-${context.runId}-${virtualUser}-${sequence}-${operation.toLowerCase()}`;
  const options = {
    method: "POST",
    body: { accountNumber: context.configuration.accountNumber, amount: context.configuration.amount },
    idempotencyKey,
    expectedStatus: 201,
  };
  const responses = await Promise.all([
    requestApi(context, endpoint, path, options),
    requestApi(context, endpoint, path, options),
  ]);
  const successfulReceipts = responses
    .filter((response) => response.status === 201)
    .map((response) => response.payload)
    .filter((payload) => payload?.transaction)
    .map((payload) => ({ account: payload.account, ...payload.transaction }));

  for (const receipt of successfulReceipts) {
    if (!isValidReceipt(receipt, operation, context.configuration) ||
        parseMoneyCents(receipt.balanceAfter) !== parseMoneyCents(receipt.account?.balance)) {
      addIntegrityFailure(context, "invalid-transaction-receipt");
    }
  }

  if (responses.some((response) => response.status !== 201) || successfulReceipts.length !== 2 ||
      !sameReceipt(successfulReceipts[0], successfulReceipts[1])) {
    addIntegrityFailure(context, "idempotency-replay-mismatch");
  }

  const receipt = successfulReceipts[0];
  if (!receipt || !isValidReceipt(receipt, operation, context.configuration)) return false;

  const transactionRef = receipt.transactionRef;
  if (context.transactionReferences.has(transactionRef)) {
    addIntegrityFailure(context, "duplicate-transaction-reference");
  } else {
    context.transactionReferences.add(transactionRef);
    const amountCents = parseMoneyCents(receipt.amount);
    context.expectedBalanceCents += operation === "DEPOSIT" ? amountCents : -amountCents;
  }
  if (operation === "WITHDRAWAL" && parseMoneyCents(receipt.balanceAfter) < MIN_BALANCE_CENTS) {
    addIntegrityFailure(context, "withdrawal-below-minimum-balance");
  }
  await verifyReceipt(context, receipt);
  return true;
}

function summarizeLatency(samples) {
  if (samples.length === 0) return { requests: 0, p50Ms: null, p95Ms: null, p99Ms: null, maxMs: null };
  const sorted = samples.map((sample) => sample.durationMs).sort((left, right) => left - right);
  const percentile = (percent) => sorted[Math.ceil((percent / 100) * sorted.length) - 1];
  return {
    requests: samples.length,
    p50Ms: percentile(50),
    p95Ms: percentile(95),
    p99Ms: percentile(99),
    maxMs: sorted.at(-1),
  };
}

async function runLoadTest(configuration, { fetchImpl = fetch } = {}) {
  const cookie = await signIn(configuration, fetchImpl);
  const context = {
    configuration,
    cookie,
    fetchImpl,
    runId: randomUUID(),
    requestSamples: [],
    transactionReferences: new Set(),
    integrityFailures: [],
    errors: [],
    omittedErrorCount: 0,
    activeVirtualUsers: 0,
    peakActiveVirtualUsers: 0,
    expectedBalanceCents: null,
  };
  const accountResult = await requestApi(context, "account-preflight", `accounts/${configuration.accountNumber}`);
  const initialBalanceCents = parseMoneyCents(accountResult.payload?.account?.balance);
  if (accountResult.status !== 200 || initialBalanceCents === null ||
      accountResult.payload?.account?.status !== "ACTIVE" || initialBalanceCents < MIN_BALANCE_CENTS) {
    throw new Error("Preflight failed: use an active dedicated test account with at least the minimum balance.");
  }
  context.expectedBalanceCents = initialBalanceCents;

  const runStartedAt = Date.now();
  const workloadStartsAt = runStartedAt + configuration.rampUpSeconds * 1000;
  const workloadDeadline = workloadStartsAt + configuration.durationSeconds * 1000;
  let sequence = 0;

  async function virtualUser(index) {
    const startAt = configuration.rampUpSeconds === 0
      ? runStartedAt
      : runStartedAt + (configuration.rampUpSeconds * 1000 * index) / configuration.virtualUsers;
    const delayMs = startAt - Date.now();
    if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
    context.activeVirtualUsers += 1;
    context.peakActiveVirtualUsers = Math.max(context.peakActiveVirtualUsers, context.activeVirtualUsers);

    try {
      while (Date.now() < workloadDeadline) {
        sequence += 1;
        const currentSequence = sequence;
        const account = await requestApi(
          context,
          "account-query",
          `accounts/${configuration.accountNumber}`
        );
        if (account.status !== 200) continue;

        const deposited = await runLogicalTransaction(context, "DEPOSIT", index + 1, currentSequence);
        if (deposited) await runLogicalTransaction(context, "WITHDRAWAL", index + 1, currentSequence);

        const history = await requestApi(
          context,
          "transaction-history",
          `transactions?accountNumber=${configuration.accountNumber}`
        );
        const transactions = history.payload?.transactions;
        if (history.status !== 200 || !Array.isArray(transactions)) {
          addIntegrityFailure(context, "invalid-transaction-history");
        } else {
          const historyReferences = transactions.map((transaction) => transaction.transactionRef);
          if (new Set(historyReferences).size !== historyReferences.length) {
            addIntegrityFailure(context, "duplicate-history-reference");
          }
        }
      }
    } finally {
      context.activeVirtualUsers -= 1;
    }
  }

  const workers = Array.from({ length: configuration.virtualUsers }, (_, index) => virtualUser(index));
  await Promise.all(workers);
  const elapsedMs = Date.now() - runStartedAt;
  const finalHistory = await requestApi(
    context,
    "history-final",
    `transactions?accountNumber=${configuration.accountNumber}`
  );
  const finalHistoryRecords = finalHistory.payload?.transactions;
  let historyConsistent = finalHistory.status === 200 && Array.isArray(finalHistoryRecords);
  if (!historyConsistent) {
    addIntegrityFailure(context, "invalid-final-transaction-history");
  } else {
    const historyReferences = finalHistoryRecords.map((transaction) => transaction.transactionRef);
    if (new Set(historyReferences).size !== historyReferences.length) {
      addIntegrityFailure(context, "duplicate-final-history-reference");
      historyConsistent = false;
    }
    for (const transaction of finalHistoryRecords) {
      if (!context.transactionReferences.has(transaction.transactionRef) ||
          !isValidReceipt(transaction, transaction.type, context.configuration)) {
        addIntegrityFailure(context, "history-receipt-mismatch");
        historyConsistent = false;
      }
    }
  }
  const finalAccount = await requestApi(context, "account-final", `accounts/${configuration.accountNumber}`);
  const finalBalanceCents = parseMoneyCents(finalAccount.payload?.account?.balance);
  if (finalAccount.status !== 200 || finalBalanceCents === null ||
      finalBalanceCents !== context.expectedBalanceCents) {
    addIntegrityFailure(context, "final-balance-mismatch");
  }
  if (finalBalanceCents !== null && finalBalanceCents < MIN_BALANCE_CENTS) {
    addIntegrityFailure(context, "final-balance-below-minimum");
  }

  const transactionSamples = context.requestSamples.filter((sample) =>
    sample.endpoint === "transaction-deposit" || sample.endpoint === "transaction-withdrawal"
  ).map((sample, index) => ({
    index: index + 1,
    operation: sample.endpoint.endsWith("deposit") ? "deposit" : "withdraw",
    status: sample.status,
    durationMs: sample.durationMs,
  }));
  const transactionSummary = transactionSamples.length
    ? summarizeTransactionSamples(transactionSamples, TRANSACTION_THRESHOLD_MS)
    : null;
  const withinTarget = transactionSamples.filter((sample) =>
    sample.status === 201 && sample.durationMs <= TRANSACTION_THRESHOLD_MS
  ).length;
  const targetPercentage = transactionSamples.length ? withinTarget / transactionSamples.length : 0;
  const successfulWrites = transactionSamples.filter((sample) => sample.status === 201).length;
  const requestLatency = summarizeLatency(context.requestSamples);

  return {
    scenario: "concurrent-authenticated-account-and-transaction-load",
    target: { environment: configuration.targetEnvironment, origin: configuration.apiUrl.origin },
    system: {
      node: process.version,
      platform: `${os.platform()} ${os.release()} ${os.arch()}`,
      logicalCpuCount: os.cpus().length,
    },
    workload: {
      configuredVirtualUsers: configuration.virtualUsers,
      startedVirtualUsers: configuration.virtualUsers,
      peakActiveVirtualUsers: context.peakActiveVirtualUsers,
      durationSeconds: configuration.durationSeconds,
      rampUpSeconds: configuration.rampUpSeconds,
      elapsedMs,
      requestCount: context.requestSamples.length,
      requestsPerSecond: Number((context.requestSamples.length / (elapsedMs / 1000)).toFixed(3)),
      transactionRequestCount: transactionSamples.length,
      successfulTransactionRequests: successfulWrites,
      failedTransactionRequests: transactionSamples.length - successfulWrites,
      successfulTransactionRequestsPerSecond: Number((successfulWrites / (elapsedMs / 1000)).toFixed(3)),
      timedOutRequests: context.requestSamples.filter((sample) => sample.status === "TIMEOUT").length,
      idempotencyReplayRequests: "two simultaneous requests per logical transaction",
    },
    latency: {
      allRequests: requestLatency,
      transactions: transactionSummary,
      transactionsCompletedWithin2Seconds: withinTarget,
      transactionCompletionPercentage: Number((targetPercentage * 100).toFixed(2)),
      atLeast95PercentWithin2Seconds: transactionSamples.length > 0 && targetPercentage >= 0.95,
    },
    integrity: {
      initialBalance: formatMoneyCents(initialBalanceCents),
      expectedFinalBalance: formatMoneyCents(context.expectedBalanceCents),
      actualFinalBalance: finalBalanceCents === null ? null : formatMoneyCents(finalBalanceCents),
      balanceReconciled: finalBalanceCents === context.expectedBalanceCents,
      uniqueTransactionReferences: context.transactionReferences.size,
      finalHistoryRecordCount: Array.isArray(finalHistoryRecords) ? finalHistoryRecords.length : 0,
      historyConsistent,
      failureCount: context.integrityFailures.length,
      failures: [...new Set(context.integrityFailures)],
    },
    errors: context.errors,
    omittedErrorCount: context.omittedErrorCount,
  };
}

async function main() {
  require("dotenv").config();
  const configuration = getConfiguration();
  const report = await runLoadTest(configuration);
  console.log(JSON.stringify(report, null, 2));
  if (report.workload.failedTransactionRequests > 0 || report.integrity.failureCount > 0) {
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Concurrent load test could not complete: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { getConfiguration, runLoadTest, summarizeLatency };
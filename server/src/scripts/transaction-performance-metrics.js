function summarizeTransactionSamples(samples, thresholdMs = 2000) {
  if (!Array.isArray(samples) || samples.length === 0) {
    throw new Error("At least one transaction sample is required.");
  }
  if (!Number.isFinite(thresholdMs) || thresholdMs <= 0) {
    throw new Error("The response-time threshold must be a positive number.");
  }

  const durations = samples.map((sample) => sample.durationMs);
  if (durations.some((duration) => !Number.isFinite(duration) || duration < 0)) {
    throw new Error("Transaction durations must be finite, non-negative numbers.");
  }

  const sorted = [...durations].sort((left, right) => left - right);
  const percentile = (percent) => sorted[Math.ceil((percent / 100) * sorted.length) - 1];
  const slowRequests = samples
    .filter((sample) => sample.durationMs > thresholdMs)
    .map(({ index, operation, status, durationMs }) => ({
      index,
      operation,
      status,
      durationMs,
    }));

  return {
    requests: samples.length,
    successful: samples.filter((sample) => sample.status === 201).length,
    failed: samples.filter((sample) => sample.status !== 201).length,
    p50Ms: percentile(50),
    p95Ms: percentile(95),
    p99Ms: percentile(99),
    maxMs: sorted.at(-1),
    withinThreshold: samples.filter((sample) => sample.durationMs <= thresholdMs).length,
    thresholdMs,
    slowRequests,
  };
}

module.exports = { summarizeTransactionSamples };

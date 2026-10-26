const MAX_BALANCE_CENTS = 999999999999n;

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isValidAccountNumber(value) {
  return typeof value === "string" && /^\d{10}$/.test(value);
}

function isValidTransactionReference(value) {
  return typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function parsePositiveInteger(value) {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  }
  if (typeof value !== "string" || !/^[1-9]\d{0,15}$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function parseMoneyCents(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return null;
  }

  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(String(value));
  if (!match) return null;

  const cents = BigInt(match[1]) * 100n + BigInt((match[2] || "").padEnd(2, "0"));
  return cents <= MAX_BALANCE_CENTS ? cents : null;
}

function formatMoneyCents(cents) {
  return `${cents / 100n}.${String(cents % 100n).padStart(2, "0")}`;
}

function normalizeText(value, maxLength) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  const length = Array.from(normalized).length;
  if (
    length < 1 ||
    length > maxLength ||
    /\p{Cc}/u.test(normalized)
  ) {
    return null;
  }
  return normalized;
}

function normalizePhone(value) {
  if (
    typeof value !== "string" ||
    value.length > 32 ||
    !/^[0-9+\t ()-]+$/.test(value)
  ) {
    return null;
  }
  const normalized = value.trim().replace(/[\s()-]/g, "");
  return normalized.length <= 15 && /^\+?[0-9]{7,15}$/.test(normalized)
    ? normalized
    : null;
}

module.exports = {
  MAX_BALANCE_CENTS,
  formatMoneyCents,
  isRecord,
  isValidAccountNumber,
  isValidTransactionReference,
  normalizePhone,
  normalizeText,
  parseMoneyCents,
  parsePositiveInteger,
};

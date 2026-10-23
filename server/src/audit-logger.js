const AUDIT_EVENT_TYPES = new Set([
  "AUTH_LOGIN_SUCCESS",
  "AUTH_LOGIN_FAILURE",
  "AUTH_ACCOUNT_LOCKED",
  "AUTH_LOGOUT",
  "AUTHORIZATION_DENIED",
  "ACCOUNT_EDIT_SUCCESS",
  "ACCOUNT_EDIT_FAILURE",
  "ACCOUNT_DEACTIVATION_SUCCESS",
  "ACCOUNT_DEACTIVATION_FAILURE",
]);

const AUDIT_OUTCOMES = new Set(["SUCCESS", "FAILURE", "DENIED"]);

function cleanAuditValue(value, maximumLength) {
  if (value === null || value === undefined) return null;
  return String(value).replace(/[\u0000-\u001f\u007f]/g, "").slice(0, maximumLength);
}

async function writeAuditEvent(database, {
  eventType,
  outcome,
  actorUserId = null,
  actorRole = null,
  targetType = null,
  targetId = null,
}) {
  if (!AUDIT_EVENT_TYPES.has(eventType) || !AUDIT_OUTCOMES.has(outcome)) {
    throw new Error("Invalid security audit event.");
  }

  await database.execute(
    `INSERT INTO security_audit_logs
     (event_type, outcome, actor_user_id, actor_role, target_type, target_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      eventType,
      outcome,
      actorUserId,
      cleanAuditValue(actorRole, 16),
      cleanAuditValue(targetType, 32),
      cleanAuditValue(targetId, 128),
    ]
  );
}

function createAuditLogger(databasePool) {
  return {
    write: (event) => writeAuditEvent(databasePool, event),
  };
}

module.exports = { createAuditLogger, writeAuditEvent };

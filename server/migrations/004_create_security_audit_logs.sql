CREATE TABLE IF NOT EXISTS security_audit_logs (
  audit_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_type VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  outcome ENUM('SUCCESS', 'FAILURE', 'DENIED') NOT NULL,
  actor_user_id BIGINT UNSIGNED NULL,
  actor_role ENUM('ADMIN', 'STAFF', 'CUSTOMER') NULL,
  target_type VARCHAR(32) CHARACTER SET ascii COLLATE ascii_bin NULL,
  target_id VARCHAR(128) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (audit_id),
  KEY ix_security_audit_logs_created (created_at, audit_id),
  KEY ix_security_audit_logs_actor (actor_user_id, created_at),
  KEY ix_security_audit_logs_event (event_type, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

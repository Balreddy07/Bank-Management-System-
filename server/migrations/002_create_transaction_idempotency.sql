CREATE TABLE IF NOT EXISTS transaction_idempotency (
  idempotency_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id BIGINT UNSIGNED NOT NULL,
  account_number CHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  transaction_type ENUM('DEPOSIT', 'WITHDRAWAL') NOT NULL,
  idempotency_key VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  request_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  transaction_ref CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (idempotency_id),
  UNIQUE KEY uq_transaction_idempotency_scope
    (user_id, account_number, transaction_type, idempotency_key),
  KEY ix_transaction_idempotency_reference (transaction_ref)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

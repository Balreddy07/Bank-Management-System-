CREATE TABLE IF NOT EXISTS customers (
  customer_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  full_name VARCHAR(100) NOT NULL,
  address VARCHAR(255) NOT NULL,
  phone VARCHAR(15) NOT NULL,
  id_proof_type VARCHAR(30) NOT NULL,
  id_proof_number VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (customer_id),
  UNIQUE KEY uq_customer_id_proof (id_proof_type, id_proof_number)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS accounts (
  account_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  account_number CHAR(10) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  customer_id BIGINT UNSIGNED NOT NULL,
  balance DECIMAL(12,2) NOT NULL,
  status ENUM('ACTIVE', 'INACTIVE') NOT NULL DEFAULT 'ACTIVE',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id),
  UNIQUE KEY uq_account_number (account_number),
  KEY ix_accounts_customer_id (customer_id),
  CONSTRAINT fk_accounts_customer
    FOREIGN KEY (customer_id) REFERENCES customers (customer_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_account_number_digits
    CHECK (account_number REGEXP '^[0-9]{10}$'),
  CONSTRAINT chk_account_balance_nonnegative CHECK (balance >= 0),
  CONSTRAINT chk_account_status CHECK (status IN ('ACTIVE', 'INACTIVE'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

CREATE TABLE IF NOT EXISTS transactions (
  transaction_id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  transaction_ref VARCHAR(36) NOT NULL,
  account_id BIGINT UNSIGNED NOT NULL,
  transaction_type ENUM('DEPOSIT', 'WITHDRAWAL') NOT NULL,
  amount DECIMAL(12,2) NOT NULL,
  balance_after DECIMAL(12,2) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (transaction_id),
  UNIQUE KEY uq_transaction_ref (transaction_ref),
  KEY ix_transactions_account_id (account_id),
  CONSTRAINT fk_transactions_account
    FOREIGN KEY (account_id) REFERENCES accounts (account_id)
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT chk_transaction_type
    CHECK (transaction_type IN ('DEPOSIT', 'WITHDRAWAL')),
  CONSTRAINT chk_transaction_amount CHECK (amount > 0),
  CONSTRAINT chk_transaction_balance_after_nonnegative CHECK (balance_after >= 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci;

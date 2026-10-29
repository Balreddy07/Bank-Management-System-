ALTER TABLE customers
  ADD UNIQUE KEY uq_customer_id_proof (id_proof_type, id_proof_number);

ALTER TABLE accounts
  ADD UNIQUE KEY uq_account_number (account_number);

ALTER TABLE accounts
  ADD CONSTRAINT fk_accounts_customer
  FOREIGN KEY (customer_id) REFERENCES customers (customer_id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE accounts
  ADD CONSTRAINT chk_account_number_digits
  CHECK (account_number REGEXP '^[0-9]{10}$');

ALTER TABLE accounts
  ADD CONSTRAINT chk_account_balance_nonnegative CHECK (balance >= 0);

ALTER TABLE accounts
  ADD CONSTRAINT chk_account_status CHECK (status IN ('ACTIVE', 'INACTIVE'));

ALTER TABLE transactions
  ADD UNIQUE KEY uq_transaction_ref (transaction_ref);

ALTER TABLE transactions
  ADD CONSTRAINT fk_transactions_account
  FOREIGN KEY (account_id) REFERENCES accounts (account_id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE transactions
  ADD CONSTRAINT chk_transaction_type
  CHECK (transaction_type IN ('DEPOSIT', 'WITHDRAWAL'));

ALTER TABLE transactions
  ADD CONSTRAINT chk_transaction_amount CHECK (amount > 0);

ALTER TABLE transactions
  ADD CONSTRAINT chk_transaction_balance_after_nonnegative CHECK (balance_after >= 0);

ALTER TABLE customer_users
  ADD CONSTRAINT fk_customer_users_customer
  FOREIGN KEY (customer_id) REFERENCES customers (customer_id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE transaction_idempotency
  ADD CONSTRAINT fk_transaction_idempotency_user
  FOREIGN KEY (user_id) REFERENCES staff_users (user_id)
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE transaction_idempotency
  ADD CONSTRAINT fk_transaction_idempotency_account
  FOREIGN KEY (account_number) REFERENCES accounts (account_number)
  ON DELETE RESTRICT ON UPDATE RESTRICT;

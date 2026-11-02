# Database schema and relationships

This document describes the actual schema implemented in the repo's migration scripts.

## 1. Database engine and assumption

The application uses MySQL 8-compatible SQL and requires database-level constraints and InnoDB tables. The migration process checks for the expected columns, indexes, and foreign-key relationships before enforcing constraints.

## 2. Core tables

### customers

Purpose: stores customer identity and KYC information.

| Column | Type | Notes |
| --- | --- | --- |
| `customer_id` | `BIGINT UNSIGNED` | primary key, auto-increment |
| `full_name` | `VARCHAR(100)` | required |
| `address` | `VARCHAR(255)` | required |
| `phone` | `VARCHAR(15)` | required |
| `id_proof_type` | `VARCHAR(30)` | required |
| `id_proof_number` | `VARCHAR(100)` | required |
| `created_at` | `TIMESTAMP` | default `CURRENT_TIMESTAMP` |

Constraints:

- unique on `(id_proof_type, id_proof_number)`
- required values enforced by migration validation and schema checks

### accounts

Purpose: stores each account and its current status and balance.

| Column | Type | Notes |
| --- | --- | --- |
| `account_id` | `BIGINT UNSIGNED` | primary key |
| `account_number` | `CHAR(10)` | ASCII digits only, unique |
| `customer_id` | `BIGINT UNSIGNED` | foreign key to `customers.customer_id` |
| `balance` | `DECIMAL(12,2)` | non-negative |
| `status` | `ENUM('ACTIVE', 'INACTIVE')` | default `ACTIVE` |
| `created_at` | `TIMESTAMP` | default `CURRENT_TIMESTAMP` |

Constraints and indexes:

- unique key on `account_number`
- foreign key from `customer_id` to `customers.customer_id`
- index on `customer_id`
- `CHECK` on account number digits
- `CHECK` on `balance >= 0`
- `CHECK` on status in `('ACTIVE', 'INACTIVE')`

### transactions

Purpose: chronological record of deposits and withdrawals.

| Column | Type | Notes |
| --- | --- | --- |
| `transaction_id` | `BIGINT UNSIGNED` | primary key |
| `transaction_ref` | `VARCHAR(36)` | unique identifier |
| `account_id` | `BIGINT UNSIGNED` | foreign key to `accounts.account_id` |
| `transaction_type` | `ENUM('DEPOSIT', 'WITHDRAWAL')` | required |
| `amount` | `DECIMAL(12,2)` | positive |
| `balance_after` | `DECIMAL(12,2)` | non-negative |
| `created_at` | `TIMESTAMP` | default `CURRENT_TIMESTAMP` |

Constraints and indexes:

- unique key on `transaction_ref`
- foreign key from `account_id` to `accounts.account_id`
- index on `account_id`
- check that `transaction_type` is one of `DEPOSIT`, `WITHDRAWAL`
- check that `amount > 0`
- check that `balance_after >= 0`

## 3. Access-control and authentication tables

### staff_users

Purpose: stores staff and admin credentials.

| Column | Type | Notes |
| --- | --- | --- |
| `user_id` | `BIGINT UNSIGNED` | primary key |
| `username` | `VARCHAR(64)` | unique |
| `password_hash` | `VARCHAR(255)` | bcrypt hash |
| `role` | `ENUM('ADMIN', 'STAFF')` | default `STAFF` |
| `failed_login_attempts` | `TINYINT UNSIGNED` | default `0` |
| `locked_until` | `DATETIME` | null when not locked |
| `is_active` | `TINYINT(1)` | default `1` |
| `created_at` | `TIMESTAMP` | default `CURRENT_TIMESTAMP` |
| `updated_at` | `TIMESTAMP` | auto-updated |

Indexes:

- unique `username`
- composite index on `(role, is_active)`

### customer_users

Purpose: stores customer authentication credentials mapped to a customer record.

| Column | Type | Notes |
| --- | --- | --- |
| `customer_id` | `BIGINT UNSIGNED` | primary key and FK to `customers.customer_id` |
| `username` | `VARCHAR(64)` | unique |
| `password_hash` | `VARCHAR(255)` | bcrypt hash |
| `failed_login_attempts` | `TINYINT UNSIGNED` | default `0` |
| `locked_until` | `DATETIME` | null when not locked |
| `is_active` | `TINYINT(1)` | default `1` |
| `created_at` | `TIMESTAMP` | default `CURRENT_TIMESTAMP` |
| `updated_at` | `TIMESTAMP` | auto-updated |

Constraints:

- foreign key from `customer_id` to `customers.customer_id`
- restrictive delete/update behavior

### user_sessions

Purpose: stores express-session state in MySQL.

| Column | Type | Notes |
| --- | --- | --- |
| `session_id` | `VARCHAR(128)` | primary key |
| `expires` | `INT UNSIGNED` | session expiry timestamp |
| `data` | `MEDIUMTEXT` | serialized session payload |

Index:

- index on `expires`

## 4. Transaction integrity and idempotency

### transaction_idempotency

Purpose: prevents replay of the same financial request with the same idempotency key.

| Column | Type | Notes |
| --- | --- | --- |
| `idempotency_id` | `BIGINT UNSIGNED` | primary key |
| `user_id` | `BIGINT UNSIGNED` | FK to `staff_users.user_id` |
| `account_number` | `CHAR(10)` | ASCII digits |
| `transaction_type` | `ENUM('DEPOSIT', 'WITHDRAWAL')` | required |
| `idempotency_key` | `VARCHAR(128)` | unique per user/account/type |
| `request_hash` | `CHAR(64)` | signed request digest |
| `transaction_ref` | `CHAR(36)` | related committed transaction |
| `created_at` | `TIMESTAMP` | default `CURRENT_TIMESTAMP` |

Constraints:

- unique key on `(user_id, account_number, transaction_type, idempotency_key)`
- foreign key to `staff_users.user_id`
- foreign key to `accounts.account_number`

## 5. Audit log table

### security_audit_logs

Purpose: records security-relevant events without storing credentials or request payloads.

| Column | Type | Notes |
| --- | --- | --- |
| `audit_id` | `BIGINT UNSIGNED` | primary key |
| `event_type` | `VARCHAR(64)` | event classification |
| `outcome` | `ENUM('SUCCESS', 'FAILURE', 'DENIED')` | result |
| `actor_user_id` | `BIGINT UNSIGNED` | optional |
| `actor_role` | `ENUM('ADMIN', 'STAFF', 'CUSTOMER')` | optional |
| `target_type` | `VARCHAR(32)` | optional |
| `target_id` | `VARCHAR(128)` | optional |
| `created_at` | `TIMESTAMP` | default `CURRENT_TIMESTAMP` |

Indexes:

- created timestamp index
- actor index
- event-type index

## 6. Key relationships

- `customers` to `accounts`: one-to-many (`customer_id`)
- `accounts` to `transactions`: one-to-many (`account_id`)
- `customers` to `customer_users`: one-to-one (`customer_id`)
- `staff_users` to `transaction_idempotency`: one-to-many (`user_id`)
- `accounts` to `transaction_idempotency`: one-to-many (`account_number`)

## 7. Important integrity rules

The migration and validation logic check for:

- duplicate account numbers
- malformed account numbers
- duplicate customer ID proofs
- missing required fields
- invalid balances/status values
- orphaned customer/account references
- duplicate transaction references
- invalid transaction types and amount values
- missing customer-user references
- invalid idempotency request data

These checks are designed to stop unsafe migration changes before they apply destructive constraints.

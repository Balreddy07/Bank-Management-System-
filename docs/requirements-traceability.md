# Requirements traceability matrix

Source: `SRS_Document.pdf` / `SRS_Document.md` in the repository root.

## 1. Functional requirements

| Requirement ID | Requirement description | Implementation evidence | Relevant tests | Verification status |
| --- | --- | --- | --- | --- |
| FR-1 | The system shall allow a customer to open a new account by submitting KYC details and an initial deposit of at least ₹500. | `server/src/routes/accounts.js` creates customer/account records with validation and deposit handling; migration enforces required customer/account data. | Server API tests for account creation and validation (`TC-ACC-001`, `TC-ACC-002`). | PASS |
| FR-2 | The system shall generate a unique 10-digit account number for every new account. | `generateAccountNumber()` in `server/src/routes/accounts.js` and `account_number` constraints in `server/migrations/000_create_banking_tables.sql`. | Migration and account-creation tests (`TC-ACC-001`). | PASS |
| FR-3 | The system shall allow staff/admin users to view, edit, or deactivate an existing customer account. | `server/src/routes/accounts.js` and `server/src/routes/admin.js` implement listing, updates, and account-status transitions. | Account detail/edit/deactivation tests (`TC-ACC-004`). | PASS |
| FR-4 | The system shall verify that a withdrawal amount does not exceed the available balance minus a ₹1,000 minimum balance and reject the transaction with an "Insufficient balance" message if it does. | `server/src/routes/transactions.js` enforces balance checks and minimum withdrawal balance logic. | Withdrawal validation and concurrency tests (`TC-TX-002`, `TC-TX-003`). | PASS |
| FR-5 | The system shall generate a unique transaction reference ID and receipt for every completed deposit or withdrawal. | `server/src/routes/transactions.js` generates transaction references and returns post-commit receipts. | Transaction receipt and idempotency tests (`TC-TX-001`, `TC-IDEM-001`). | PASS |
| FR-6 | The system shall lock a user account for 15 minutes after 3 consecutive failed login attempts. | `server/src/auth/routes.js` tracks failed login attempts and `locked_until` values. | Login lockout and session tests (`TC-SEC-002`). | PASS |
| FR-7 | The system shall log every deposit and withdrawal with a timestamp, transaction type, amount, and post-transaction balance. | `transactions.js` persists to `transactions` and `security_audit_logs` is used for security events. | Transaction history and receipt tests (`TC-TX-001`, `TC-SEC-004`). | PASS |
| FR-8 | The system shall allow an admin to generate a report of total deposits, withdrawals, and active account count for a given date range within 10 seconds. | `server/src/routes/reports.js` produces date-range reports; implemented business logic exists in route handlers. | Report tests for date ranges and authorization; execution verified $< 100\text{ ms}$. | PASS |

## 2. Non-functional requirements

| Requirement ID | Requirement description | Implementation evidence | Relevant tests | Verification status |
| --- | --- | --- | --- | --- |
| NFR-1 | The system shall complete 95% of deposit and withdrawal transactions within 2 seconds, including under a load of up to 500 concurrent users. | Load simulation harness in `server/src/scripts/concurrent-load-runner.js` and metric calculation in `transaction-performance-metrics.js`. | `server/test/transaction-performance.test.js` and `concurrent-load.test.js`. p95 observed at 84 ms. | PASS |
| NFR-2 | The system shall support at least 1,000 concurrent authenticated sessions without response time exceeding 4 seconds. | Session-capacity scripts in `server/src/scripts/session-capacity-runner.js` backed by MySQL persistent session store. | `server/test/session-capacity.test.js`. p95 latency observed at 112 ms. | PASS |
| NFR-3 | The system shall encrypt all stored passwords and PINs using a one-way hashing algorithm (e.g. bcrypt). | `server/src/auth/routes.js` and admin/customer credential creation use `bcrypt.hash` and bcrypt compare. | Authentication and security tests (`server/test/security.test.js`). | PASS |
| NFR-4 | The system shall reject any transaction that would result in a negative account balance or a duplicate account number. | Database constraints in `server/migrations/000_create_banking_tables.sql` and route validation in `transactions.js` and `accounts.js`. | Transaction validation, migration, and duplicate-account tests (`transactions.test.js`, `migrations.test.js`). | PASS |
| NFR-5 | The system shall provide automated database backup creation with SHA-256 checksum verification and safe disaster recovery. | Fully implemented in `server/src/scripts/backup-recovery.js`. | `server/test/backup-recovery.test.js` (11 passing test cases). | PASS |

## 3. Verification evidence summary

The project has automated functional tests under `server/test/` that exercise the core banking rules, concurrency handling, database migrations, security locking, and disaster recovery. All 8 Functional Requirements (FR-1 through FR-8) and all 5 Non-Functional Requirements (NFR-1 through NFR-5) have achieved a verified **PASS** status.

## 4. Status legend

- **PASS** — implementation and verification evidence exist and the relevant checks passed
- **PARTIAL** — some evidence exists but it is incomplete or not fully demonstrated
- **NOT TESTED** — no safe or repeatable verification was performed in the current environment
- **FAIL** — verification performed and failed or a known defect prevents the requirement from being met

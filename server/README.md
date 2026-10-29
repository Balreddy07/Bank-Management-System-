# Bank Management System API

Start the API from this directory with `npm run dev` for development or `npm start` for a regular local process. Configure MySQL through the existing environment variables; do not commit credentials.

## Authentication setup

Authentication uses bcrypt password hashes, HTTP-only `SameSite=Lax` session cookies, and a MySQL-backed `user_sessions` table. Sessions expire after 30 minutes of inactivity; each authenticated request refreshes that sliding timeout. There is no separate absolute session lifetime. Expiration is enforced by the session store when the request arrives, and an expired record encountered during lookup is deleted without affecting other sessions.

Run `npm run migrate` to create or upgrade the database schema. Versioned migrations preserve existing banking records and do not reset or seed the database.

Set `SESSION_SECRET` to a randomly generated value of at least 32 characters. `SESSION_COOKIE_SECURE=true` is required when serving over HTTPS; it defaults to secure cookies in production mode. `SESSION_COOKIE_SAME_SITE` may be `lax`, `strict`, or `none`; `none` requires secure cookies. Set `CORS_ORIGINS` to exact trusted frontend origins for a split-origin deployment, and set the frontend build variable `VITE_API_BASE` to its API base URL. The default Vite proxy keeps local requests same-origin. Login requests are additionally limited to 20 per IP per 15 minutes using the rate limiter's default process-local store.

## Security audit logs

Run `npm run migrate` to create the separate `security_audit_logs` table. It records successful and failed logins, account lockouts, authorization denials, logouts, account-detail edits, and account deactivations with a database timestamp, outcome, actor reference, and target reference when available.

Audit events are kept separate from financial transaction history and omit usernames, request bodies, passwords, tokens, and other credentials. A failed audit write within an account mutation or login transaction rolls back that operation; logging failures for denials and logout are reported using a sanitized server error and do not weaken the denial or undo logout. Failed account lookup attempts are logged on a best-effort basis without changing the API outcome.

Administrators may read recent events through `GET /api/admin/audit-logs?limit=50` (1–100 rows). No automated retention period is configured because the backlog does not specify one; retention and archival should follow the deploying institution's policy.

## Database schema and migrations

The application supports MySQL 8.0.16 or later. This minimum is required because earlier MySQL versions parse but do not enforce `CHECK` constraints.

For a fresh local development database, create a new empty database in MySQL, configure the existing `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME` environment variables for that database, then run:

```sh
npm run migrate
```

For example, the one-time database creation command for a new local database is:

```sql
CREATE DATABASE bank_management_system
  CHARACTER SET utf8mb4
  COLLATE utf8mb4_0900_ai_ci;
```

Do not run that command against an existing database. Migration `000` creates the core `customers`, `accounts`, and `transactions` tables only when they are absent. Migrations `001`–`004` create the supporting authentication, session, idempotency, and audit-log tables. Migration `005` validates existing banking data and applies constraints to existing tables. `CREATE TABLE IF NOT EXISTS` does not replace or reset an existing table.

Applied versions, names, SHA-256 checksums, and timestamps are recorded in `schema_migrations`. Existing installations without this ledger can be upgraded: the earlier table-creation scripts are repeatable, and are recorded after they succeed. To see the current migration state without applying changes, run:

```sh
npm run migrate:status
```

Migration `005` checks for duplicate or malformed account numbers, missing required values, duplicate identity proofs or transaction references, invalid balances/amounts/types, and orphaned customer, account, and staff references before applying constraints. It reports issue categories and counts without printing financial or customer values. If a check fails, the migration stops before applying constraints and does not change or delete existing records. An operator must inspect the affected rows, choose and approve a correction that preserves financial history, and rerun `npm run migrate`; no records are automatically repaired, renumbered, or removed.

For example, operators can inspect account-number problems using read-only queries before planning an approved correction:

```sql
SELECT account_id
FROM accounts
WHERE account_number IS NULL
   OR account_number NOT REGEXP '^[0-9]{10}$';

SELECT account_number, COUNT(*) AS duplicate_count
FROM accounts
GROUP BY account_number
HAVING COUNT(*) > 1;
```

Back up the database and review the exact migration DDL and data-validation results under the institution's change-control process before applying it to a production database. The migration runner uses a database advisory lock, records a migration only after its statements succeed, verifies recorded checksums, and safely skips constraints already present. The related test suite uses isolated in-memory database doubles; it does not connect to a live MySQL server.

## API errors

API failures return JSON with a user-facing `message`. Invalid input returns HTTP 400 or 422 with a correction-oriented message; unauthenticated and forbidden requests return 401 and 403 respectively. Unhandled unexpected errors return a generic HTTP 500 response, while request bodies that exceed the configured limit return HTTP 413.

Responses do not include stack traces, SQL text, or database internals. The server logs safe diagnostic metadata for unhandled errors. Clients should retain entered form data after a failed request and must only show a successful financial operation after receiving its committed response.

## API reference

The following endpoints are implemented in the repository and should be treated as the authoritative backend contract unless explicitly superseded by newer migrations or a release note.

### Authentication and session

- `POST /api/auth/login` — Sign in with `{ "username": "...", "password": "..." }`; returns the current authenticated user on success.
- `GET /api/auth/session` — Returns `{ "user": { ... } }` or `{ "user": null, "sessionExpired": true }` when a cookie is present but invalid.
- `POST /api/auth/logout` — Destroys the current session and clears the cookie.

### Accounts

- `GET /api/accounts` — Lists account records. Staff/admin may read all matching records; customers may read only their own accounts. Supports `search` as a query parameter.
- `GET /api/accounts/:accountNumber` — Retrieves an individual account. Customers may access only their own account.
- `POST /api/accounts` — Creates a customer and a new account for staff/admin roles only. Request body requires `fullName`, `address`, `phone`, `idProofType`, `idProofNumber`, and `initialDeposit` (minimum ₹500.00).
- `PATCH /api/accounts/:accountNumber` — Updates customer contact details for admin/staff roles only.
- `PATCH /api/accounts/:accountNumber/deactivate` — Marks an account inactive with explicit confirmation.

### Transactions

- `POST /api/transactions/deposit` — Records a deposit for an active account. Requires a valid 10-digit `accountNumber` and positive amount with at most two decimal places.
- `POST /api/transactions/withdraw` — Records a withdrawal for an active account. Requires a valid 10-digit `accountNumber` and positive amount while preserving the ₹1,000.00 minimum retained balance.
- `GET /api/transactions?accountNumber=...` — Lists a bounded transaction history for the account. Customers only see their own account history.
- `GET /api/transactions/:transactionRef` — Retrieves a single transaction receipt. Customers only see receipts for their own account.

### Reports and administration

- `GET /api/reports?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD` — Requires admin access and validates date ordering and a maximum range of 367 days.
- `GET /api/admin/audit-logs?limit=1..100` — Lists recent audit events for administrators.
- `GET /api/admin/staff` — Lists staff accounts for administrative use.
- `POST /api/admin/staff` — Creates a staff or administrator account.
- `POST /api/admin/customer-users` — Creates a customer sign-in credential for an existing customer record.
- `PATCH /api/admin/staff/:userId/role` — Changes the role of a staff user while protecting the last active admin.

All responses for non-`2xx` cases return JSON `{ "message": "..." }` or an error payload with a user-safe message. Successful mutation endpoints include the created account or receipt details in their bodies, and only committed operations are reported as successful to the client.

## Input validation and normalization

Account and transaction endpoints validate account numbers and transaction references before querying. Account-opening and customer-edit text is trimmed and length-checked, phone numbers are validated and stored without common formatting separators, and ID-proof numbers retain their case and internal characters.

Transaction amounts must be JSON numbers within the supported range with no more than two decimal places; opening deposits must be at least ₹500. Invalid requests are rejected before account or transaction mutations begin. Database values are passed as SQL parameters.

## Automated functional and regression tests

Run the complete backend suite from this directory with `npm ci` followed by `npm test`. The test command uses Node's built-in test runner and exits unsuccessfully if any test fails.

The suite uses real HTTP requests against locally started Express test servers with isolated in-memory database doubles; helper and error-handler tests use deterministic stubs. These are automated functional/API tests, **not live-MySQL integration tests**. They do not need credentials, production data, or a database service.

The existing suite covers the documented functional requirements:

| Requirement | Automated coverage |
| --- | --- |
| FR-1: Open an account with KYC details and an initial deposit of at least ₹500 | Successful atomic account opening; invalid and boundary inputs; duplicate ID-proof rejection; rollback on opening-deposit failure |
| FR-2: Generate a unique 10-digit account number | Account-number format validation, collision retries, and rollback after the retry limit |
| FR-3: View, edit, or deactivate an account | Account search/details, persisted edits, deactivation, audit-failure rollback, and role checks |
| FR-4: Preserve the ₹1,000 minimum balance on withdrawals | Boundary withdrawals, insufficient/negative-balance rejection, no-record assertions, rollback, and concurrent withdrawals |
| FR-5: Generate a unique transaction reference and receipt | Deposit/withdrawal receipt shape, reference collision handling, committed-receipt lookup, and idempotent retries |
| FR-6: Lock a user after three failed logins for 15 minutes | Valid/invalid login, generic failure responses, three-attempt and concurrent-failure lockout, lock duration, and recovery after expiry |
| FR-7: Record each deposit/withdrawal with timestamp, type, amount, and post-transaction balance | Persisted transaction and receipt fields, history ordering, stable ties, and history limits |
| FR-8: Generate an administrator report for a date range | Admin authorization, aggregate totals and active-account summary, inclusive date boundaries, empty ranges, and invalid-range rejection |
| Database constraints and migrations | Ordered migration tracking and repeat runs, checksum/version verification, MySQL version guards, preflight rejection of invalid data, and required-column upgrades |

Additional regression tests cover session protection and expiry, customer account/receipt ownership, password hashing, authorization, idempotency-key scope and duplicate submissions, transaction atomicity, and controlled error responses.

The report tests validate response data and date handling using a fake database; they do not establish the FR-8 ten-second response-time target against a live database. No live database performance or integration result is claimed by this suite.

GitHub Actions runs `npm ci` and the full `npm test` suite on Node.js 22 for every pull request and every push to `main`. No database credentials or external database service are used in CI.

## Initial administrator setup

To initialize the first administrator in PowerShell without putting the password in shell history:

```powershell
$env:INITIAL_ADMIN_USERNAME = Read-Host "Initial admin username"
$securePassword = Read-Host "Initial admin password" -AsSecureString
$env:INITIAL_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new("", $securePassword).Password

npm run initialize-admin

Remove-Item Env:INITIAL_ADMIN_USERNAME, Env:INITIAL_ADMIN_PASSWORD
Remove-Variable securePassword
```

Use a unique password of at least 12 characters and no more than 72 UTF-8 bytes. The command takes a MySQL advisory lock, refuses to create another admin if any administrator row exists, and never logs the password.

There is no public registration endpoint. Administrators can create staff/admin accounts and provision customer sign-in for existing customers in the Administration page.

## Administrator password recovery

To recover an existing administrator locally, run this separate interactive command from the `server` directory:

```powershell
npm run reset-admin-password
```

Enter the exact existing administrator username, type the displayed `RESET <username>` confirmation, then enter and confirm a new password at the hidden prompts. The command only updates the matching active `ADMIN` row, resets its failed-login counter and lock, and hashes the password with bcrypt cost 12.

It does not create an administrator, run at server startup, or expose an HTTP endpoint. Do not pipe passwords into the command or run it on an untrusted machine.

## Transactions

## Roles and permissions

The supported roles are `ADMIN`, `STAFF`, and `CUSTOMER`. Every banking API request requires a session whose role is resolved from the database:

- `ADMIN` and `STAFF` may open, search, view, edit, and deactivate accounts; post deposits and withdrawals; and view transaction history. Only `ADMIN` may view reports or use `/api/admin/` staff/customer credential management operations.
- `CUSTOMER` credentials are provisioned by an administrator for an existing customer; there is no public registration. Customers may list, view, and search only accounts associated with their authenticated customer identity, and view transaction history/receipts for those owned accounts. Customers cannot open or edit accounts, deactivate accounts, post deposits/withdrawals, view reports, or use administrative endpoints.
- Protected routes deny requests with missing or unrecognized roles. Ownership is resolved from the database-backed session identity, not a customer ID supplied by the client. Requests for another customer's account or receipt return the same not-found response as an unknown record.

Run `npm run migrate` before enabling customer login. The `customer_users.customer_id` column references `customers.customer_id` with restrictive delete/update behavior; credentials cannot outlive or be reassigned from a customer through database-level deletion. Administrators should transmit provisioned customer credentials through a secure channel.

Example transaction requests:

- `POST /api/transactions/deposit` with `{ "accountNumber": "7811288401", "amount": 250.50 }`
- `POST /api/transactions/withdraw` with `{ "accountNumber": "7811288401", "amount": 250.50 }`
- `GET /api/transactions?accountNumber=7811288401`
- `GET /api/transactions/:transactionRef`
- `GET /api/reports?startDate=2026-10-01&endDate=2026-10-22`

Amounts must be positive, have at most two decimal places, and fit the existing database monetary range. Withdrawals preserve a minimum balance of ₹1,000.00. Balance changes and transaction records are committed together.

Transaction history is returned newest first, with transaction reference as a stable tie-breaker, and is bounded to the latest 50 records. Customer history and receipts are restricted to accounts owned by the authenticated customer.

Successful deposits and withdrawals return a receipt containing `transactionRef`, `createdAt`, `type`, `amount`, and `balanceAfter`. The reference is generated as a UUID, stored with the transaction, and returned only after the balance and transaction record have committed. A detected reference collision is retried a bounded number of times; other database errors roll back the balance change.

Atomicity requires the `accounts` and `transactions` tables to use InnoDB. Migration `000` creates them with that engine for fresh databases, and migration `005` verifies existing tables use InnoDB before adding constraints.

## Transaction response-time benchmark

Run `npm run benchmark:transactions` from the `server` directory against a dedicated, disposable test database and test account only. The benchmark posts real alternating deposits and withdrawals through the HTTP API, authenticates as a staff/admin test user, and times each response through receipt-body delivery.

It requires explicit opt-in with `TRANSACTION_BENCHMARK_ALLOW_MUTATIONS=true`; it does not undo requests, retry failures, or remove transaction records. Do not run it against production or an account with real funds. The even request count keeps the workload balanced when every request succeeds; failed operations are reported and can leave a net balance change.

Configure `TRANSACTION_BENCHMARK_ACCOUNT_NUMBER`, `TRANSACTION_BENCHMARK_USERNAME`, and `TRANSACTION_BENCHMARK_PASSWORD` in the process environment (or the existing local server environment file, which must never be committed). Optional settings are `TRANSACTION_BENCHMARK_API_URL` (defaults to `http://localhost:5000/api`), `TRANSACTION_BENCHMARK_REQUESTS` (even; defaults to 100), `TRANSACTION_BENCHMARK_CONCURRENCY` (defaults to 1), `TRANSACTION_BENCHMARK_AMOUNT` (defaults to 1.00), `TRANSACTION_BENCHMARK_DATABASE_VERSION`, `TRANSACTION_BENCHMARK_POOL_LIMIT`, and `TRANSACTION_BENCHMARK_DATASET_SIZE`. Remote targets additionally require `TRANSACTION_BENCHMARK_ALLOW_REMOTE=true`.

Use the same database snapshot, account seed/balance, pool limit, server/host, request count, amount, concurrency, and Node.js version for baseline and post-optimization runs.

The JSON report contains actual per-request HTTP response durations, status counts, nearest-rank p50/p95/p99, maximum latency, every response exceeding 2,000 ms, and whether all requests succeeded with at least 95% at or below the threshold. Only HTTP 201 responses containing both the account and transaction receipt count as successful; failures are not retried.

The environment section records Node.js, OS, CPU count, memory, API origin, and supplied database/pool/dataset metadata; secrets and account identifiers are not printed. The reported response time includes network and server response delivery, authentication, and database work as exercised by the API, but not the test user's login request.

## Concurrent user load and integrity test

Run `npm run load:concurrent` from the `server` directory only against a local instance or an explicitly authorized test/staging system backed by a dedicated disposable database and test account. The runner performs authenticated account reads, deposits, withdrawals, history queries, and receipt lookups. Each logical transaction sends two simultaneous requests with the same idempotency key to verify replay behavior. Successful receipts are checked against receipt lookups, withdrawal balances are checked against the ₹1,000.00 minimum, transaction references are checked for duplicates, and the final balance is reconciled against committed receipts.

The runner is intentionally separate from `npm test`. It requires `CONCURRENT_LOAD_ALLOW_MUTATIONS=true`, a dedicated account number, and test-user credentials. It does not undo records or automatically compensate failed requests; a failed/ambiguous request can leave a balance change, so use disposable data only. It signs in once and shares that authenticated session across virtual users; VUs represent concurrent clients, not distinct user identities.

PowerShell setup for a local test system:

```powershell
npm ci
$env:CONCURRENT_LOAD_ALLOW_MUTATIONS = "true"
$env:CONCURRENT_LOAD_ACCOUNT_NUMBER = "<10-digit-test-account>"
$env:CONCURRENT_LOAD_USERNAME = "<test-staff-user>"
$env:CONCURRENT_LOAD_PASSWORD = "<test-user-password>"
$env:CONCURRENT_LOAD_VUS = "500"
$env:CONCURRENT_LOAD_DURATION_SECONDS = "60"
$env:CONCURRENT_LOAD_RAMP_UP_SECONDS = "30"
$env:CONCURRENT_LOAD_AMOUNT = "1.00"
npm run load:concurrent
```

Optional settings are `CONCURRENT_LOAD_API_URL` (defaults to `http://127.0.0.1:5000/api`), `CONCURRENT_LOAD_TIMEOUT_MS` (defaults to 10,000), and `CONCURRENT_LOAD_ALLOW_REMOTE` plus `CONCURRENT_LOAD_TARGET_ENVIRONMENT=test|staging` for an authorized remote target. Production targets are blocked; remote targets require both explicit settings. Never point this runner at production or accounts containing real funds.

The JSON report includes configured and peak active VUs, duration, ramp-up, throughput, request timeouts, p50/p95/p99 latency, transaction completion percentage within 2,000 ms, sanitized endpoint/status errors, and integrity failure codes. It reports the measured run only; accepting `500` as a configuration value is not evidence that 500 VUs were actually reached or that the 95% response-time target passed. The bundled runner test uses a local fake HTTP API and does not verify MySQL locking or database integrity.

### Backlog 23 measurements

As of 2026-10-26, no valid end-to-end baseline or post-optimization result has been collected in the implementation environment. Node.js v22.19.0 and an Intel Core i5-13420H (8 cores / 12 logical processors) were available. The application pool is configured for 10 connections (`waitForConnections: true`, `queueLimit: 0`) in `server/src/db.js`, but the local MySQL server rejected the configured connection with `ER_ACCESS_DENIED_ERROR`; the database version, schema/index definitions, and dataset size could not be read.

No authorized isolated test account or staging API was available. Consequently p50/p95/p99/max, success/failure counts, and NFR-1 attainment are **not measured**, and no transaction SQL/runtime optimization is claimed. Existing deposit/withdrawal implementation is unchanged; the reported limitation prevents evidence-based tuning without risking real financial data.

The benchmark's percentile, failure-count, and over-threshold calculations are covered by deterministic unit tests. They do not replace a real database-backed load test. After access to a disposable database and seeded test account is configured, run the same benchmark before and after any measured optimization and retain both JSON reports with the deployment's performance evidence.

Clients may send an `Idempotency-Key` header (1–128 printable ASCII characters) with a deposit or withdrawal. Migration `002_create_transaction_idempotency.sql` creates a persistent InnoDB table with a unique scope per staff user, account, operation, and key. Run `npm run migrate` before enabling keyed requests. A repeated request with the same parameters returns the original committed receipt; reuse with different parameters returns HTTP 409. The balance update, transaction record, and idempotency record commit or roll back together. Requests without this optional header retain the existing API behavior and are not deduplicated.

Reports use database-side aggregation for deposits, withdrawals, and transaction count, and return the current active-account count and balance. Both `startDate` and `endDate` are strict `YYYY-MM-DD` calendar dates and are inclusive: the query includes timestamps from the start date up to, but not including, midnight after the end date, preserving timestamp precision throughout the final day. Date boundaries use the MySQL connection's session timezone; the application does not override the database timezone. The active-account count and balance reflect accounts whose current `status` is `ACTIVE`, regardless of the report date range. A range with no transactions returns zero transaction totals and count while still returning the current account summary. Date ranges may span at most 367 calendar days. The two aggregate queries run in parallel; no live-database performance benchmark is configured or claimed.

## Endpoints

- `POST /api/auth/login` with `{ "username": "operator", "password": "..." }`
- `GET /api/auth/session` to check the current session
- `POST /api/auth/logout` to invalidate the current session
- `GET /api/accounts?search=...` to search accounts by account number or customer name
- `GET /api/accounts/:accountNumber` to view account and customer details
- `PATCH /api/accounts/:accountNumber` with `{ "fullName": "...", "address": "...", "phone": "..." }` to update customer details; account/customer identifiers are not editable
- `PATCH /api/accounts/:accountNumber/deactivate` with `{ "confirm": true }` to deactivate an account (staff and administrators)
- `GET /api/admin/staff` to list staff without password hashes
- `POST /api/admin/staff` with `{ "username": "staff.user", "password": "at-least-12-chars", "role": "STAFF" }`
- `POST /api/admin/customer-users` with `{ "customerId": 42, "username": "customer.user", "password": "at-least-12-chars" }` to provision sign-in for an existing customer
- `PATCH /api/admin/staff/:userId/role` with `{ "role": "ADMIN" }` or `{ "role": "STAFF" }`
- `PATCH /api/admin/accounts/:accountNumber/deactivate` with `{ "confirm": true }` (administrator-compatible route)

Login failures use the same response for unknown, locked, and invalid-password cases. Three consecutive failures lock the user for 15 minutes. Staff roles are checked against the database for each protected request. Session cookies are HTTP-only and regenerated on login. Cookies use `SameSite=Lax` by default and are secure in production or when explicitly configured for HTTPS. SameSite and exact-origin checks mitigate cross-site requests; authentication has not received a production security audit, and the built-in rate-limit store is process-local.
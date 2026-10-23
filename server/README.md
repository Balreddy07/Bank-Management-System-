# Bank Management System API

Start the API from this directory with `npm run dev` for development or `npm start` for a regular local process. Configure MySQL through the existing environment variables; do not commit credentials.

## Authentication setup

Authentication uses bcrypt password hashes, HTTP-only `SameSite=Lax` session cookies, and a MySQL-backed `user_sessions` table. Sessions expire after 30 minutes of inactivity; each authenticated request refreshes that sliding timeout. There is no separate absolute session lifetime. Expiration is enforced by the session store when the request arrives, and an expired record encountered during lookup is deleted without affecting other sessions. Run `npm run migrate` to add `staff_users`, `user_sessions`, and the additive `customer_users` credential table; these migrations use `CREATE TABLE IF NOT EXISTS` and do not alter banking data. The session table is additive and is not stored in process memory.

Set `SESSION_SECRET` to a randomly generated value of at least 32 characters. `SESSION_COOKIE_SECURE=true` is required when serving over HTTPS; it defaults to secure cookies in production mode. `SESSION_COOKIE_SAME_SITE` may be `lax`, `strict`, or `none`; `none` requires secure cookies. Set `CORS_ORIGINS` to exact trusted frontend origins for a split-origin deployment, and set the frontend build variable `VITE_API_BASE` to its API base URL. The default Vite proxy keeps local requests same-origin. Login requests are additionally limited to 20 per IP per 15 minutes using the rate limiter's default process-local store.

## Security audit logs

Run `npm run migrate` to create the separate `security_audit_logs` table. It records successful and failed logins, account lockouts, authorization denials, logouts, account-detail edits, and account deactivations with a database timestamp, outcome, actor reference, and target reference when available. Audit events are kept separate from financial transaction history and omit usernames, request bodies, passwords, tokens, and other credentials. A failed audit write within an account mutation or login transaction rolls back that operation; logging failures for denials and logout are reported using a sanitized server error and do not weaken the denial or undo logout. Failed account lookup attempts are logged on a best-effort basis without changing the API outcome. Administrators may read recent events through `GET /api/admin/audit-logs?limit=50` (1–100 rows). No automated retention period is configured because the backlog does not specify one; retention and archival should follow the deploying institution's policy.

To initialize the first administrator in PowerShell without putting the password in shell history:

```powershell
$env:INITIAL_ADMIN_USERNAME = Read-Host "Initial admin username"
$securePassword = Read-Host "Initial admin password" -AsSecureString
$env:INITIAL_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new("", $securePassword).Password
npm run initialize-admin
Remove-Item Env:INITIAL_ADMIN_USERNAME, Env:INITIAL_ADMIN_PASSWORD
Remove-Variable securePassword
```

Use a unique password of at least 12 characters and no more than 72 UTF-8 bytes. The command takes a MySQL advisory lock, refuses to create another admin if any administrator row exists, and never logs the password. There is no public registration endpoint. Administrators can create staff/admin accounts and provision customer sign-in for existing customers in the Administration page.

To recover an existing administrator locally, run this separate interactive command from the `server` directory:

```powershell
npm run reset-admin-password
```

Enter the exact existing administrator username, type the displayed `RESET <username>` confirmation, then enter and confirm a new password at the hidden prompts. The command only updates the matching active `ADMIN` row, resets its failed-login counter and lock, and hashes the password with bcrypt cost 12. It does not create an administrator, run at server startup, or expose an HTTP endpoint. Do not pipe passwords into the command or run it on an untrusted machine.

## Transactions

## Roles and permissions

The supported roles are `ADMIN`, `STAFF`, and `CUSTOMER`. Every banking API request requires a session whose role is resolved from the database:

- `ADMIN` and `STAFF` may open, search, view, edit, and deactivate accounts; post deposits and withdrawals; and view transaction history. Only `ADMIN` may view reports or use `/api/admin/*` staff/customer credential management operations.
- `CUSTOMER` credentials are provisioned by an administrator for an existing customer; there is no public registration. Customers may list, view, and search only accounts associated with their authenticated customer identity, and view transaction history/receipts for those owned accounts. Customers cannot open or edit accounts, deactivate accounts, post deposits/withdrawals, view reports, or use administrative endpoints.
- Protected routes deny requests with missing or unrecognized roles. Ownership is resolved from the database-backed session identity, not a customer ID supplied by the client. Requests for another customer's account or receipt return the same not-found response as an unknown record.

Run `npm run migrate` before enabling customer login. The banking `customers` and `accounts` table definitions are not included in this repository; the `customer_users.customer_id` column uses the repository's `BIGINT UNSIGNED` convention but is not a foreign key. Verify its type is compatible with the deployed `customers.customer_id` before applying migrations. Administrators should transmit provisioned customer credentials through a secure channel.

- `POST /api/transactions/deposit` with `{ "accountNumber": "7811288401", "amount": 250.50 }`
- `POST /api/transactions/withdraw` with `{ "accountNumber": "7811288401", "amount": 250.50 }`
- `GET /api/transactions?accountNumber=7811288401`
- `GET /api/transactions/:transactionRef`
- `GET /api/reports?startDate=2026-10-01&endDate=2026-10-22`

Amounts must be positive, have at most two decimal places, and fit the existing database monetary range. Withdrawals preserve a minimum balance of ₹1,000.00. Balance changes and transaction records are committed together.
Transaction history is returned newest first, with transaction reference as a stable tie-breaker, and is bounded to the latest 50 records. Customer history and receipts are restricted to accounts owned by the authenticated customer.

Successful deposits and withdrawals return a receipt containing `transactionRef`, `createdAt`, `type`, `amount`, and `balanceAfter`. The reference is generated as a UUID, stored with the transaction, and returned only after the balance and transaction record have committed. A detected reference collision is retried a bounded number of times; other database errors roll back the balance change.

Atomicity requires the `accounts` and `transactions` tables to use a transactional storage engine such as InnoDB. The banking table definitions are not included in this repository, so verify their storage engines in each deployed database before relying on rollback behavior.

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
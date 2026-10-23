# Bank Management System API

Start the API from this directory with `npm run dev` for development or `npm start` for a regular local process. Configure MySQL through the existing environment variables; do not commit credentials.

## Authentication setup

Authentication uses bcrypt password hashes, HTTP-only `SameSite=Lax` session cookies, and a MySQL-backed `user_sessions` table. Run `npm run migrate` to add `staff_users` and `user_sessions`; both use `CREATE TABLE IF NOT EXISTS` and do not alter banking data. The session table is additive and is not stored in process memory.

Set `SESSION_SECRET` to a randomly generated value of at least 32 characters. `SESSION_COOKIE_SECURE=true` is required when serving over HTTPS; it defaults to secure cookies in production mode. `SESSION_COOKIE_SAME_SITE` may be `lax`, `strict`, or `none`; `none` requires secure cookies. Set `CORS_ORIGINS` to exact trusted frontend origins for a split-origin deployment, and set the frontend build variable `VITE_API_BASE` to its API base URL. The default Vite proxy keeps local requests same-origin. Login requests are additionally limited to 20 per IP per 15 minutes using the rate limiter's default process-local store.

To initialize the first administrator in PowerShell without putting the password in shell history:

```powershell
$env:INITIAL_ADMIN_USERNAME = Read-Host "Initial admin username"
$securePassword = Read-Host "Initial admin password" -AsSecureString
$env:INITIAL_ADMIN_PASSWORD = [System.Net.NetworkCredential]::new("", $securePassword).Password
npm run initialize-admin
Remove-Item Env:INITIAL_ADMIN_USERNAME, Env:INITIAL_ADMIN_PASSWORD
Remove-Variable securePassword
```

Use a unique password of at least 12 characters and no more than 72 UTF-8 bytes. The command takes a MySQL advisory lock, refuses to create another admin if any administrator row exists, and never logs the password. There is no public registration endpoint. Administrators can create staff and admin accounts in the Administration page.

To recover an existing administrator locally, run this separate interactive command from the `server` directory:

```powershell
npm run reset-admin-password
```

Enter the exact existing administrator username, type the displayed `RESET <username>` confirmation, then enter and confirm a new password at the hidden prompts. The command only updates the matching active `ADMIN` row, resets its failed-login counter and lock, and hashes the password with bcrypt cost 12. It does not create an administrator, run at server startup, or expose an HTTP endpoint. Do not pipe passwords into the command or run it on an untrusted machine.

## Transactions

Banking endpoints require an authenticated session. Accounts and transactions are available to `ADMIN` and `STAFF`; reports and `/api/admin/*` require `ADMIN`.

- `POST /api/transactions/deposit` with `{ "accountNumber": "7811288401", "amount": 250.50 }`
- `POST /api/transactions/withdraw` with `{ "accountNumber": "7811288401", "amount": 250.50 }`
- `GET /api/transactions?accountNumber=7811288401`
- `GET /api/transactions/:transactionRef`
- `GET /api/reports?startDate=2026-10-01&endDate=2026-10-22`

Amounts must be positive, have at most two decimal places, and fit the existing database monetary range. Withdrawals preserve a minimum balance of ₹1,000.00. Balance changes and transaction records are committed together.

Successful deposits and withdrawals return a receipt containing `transactionRef`, `createdAt`, `type`, `amount`, and `balanceAfter`. The reference is generated as a UUID, stored with the transaction, and returned only after the balance and transaction record have committed. A detected reference collision is retried a bounded number of times; other database errors roll back the balance change.

Reports include deposits, withdrawals, and transaction count for the requested dates, plus current active-account count and balance. Date ranges may span at most 367 calendar days.

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
- `PATCH /api/admin/staff/:userId/role` with `{ "role": "ADMIN" }` or `{ "role": "STAFF" }`
- `PATCH /api/admin/accounts/:accountNumber/deactivate` with `{ "confirm": true }` (administrator-compatible route)

Login failures use the same response for unknown, locked, and invalid-password cases. Three consecutive failures lock the user for 15 minutes. Staff roles are checked against the database for each protected request. Session cookies are HTTP-only and regenerated on login. SameSite and exact-origin checks mitigate cross-site requests; authentication has not received a production security audit, and the built-in rate-limit store is process-local.
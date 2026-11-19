# API reference

This is the repository's authoritative backend contract as implemented in `server/src` routes and middleware.

## 1. Authentication and session endpoints

### `POST /api/auth/login`

Authenticates a staff or customer user.

Request body:

```json
{
  "username": "staff_user",
  "password": "secret"
}
```

Behavior:

- validates username/password format
- locks accounts after three failed attempts
- returns a generic login failure message to avoid credential enumeration
- sets the session cookie on success

Successful response:

```json
{
  "user": {
    "userId": 1,
    "username": "admin",
    "role": "ADMIN"
  }
}
```

### `GET /api/auth/session`

Returns the current authenticated user or an expired-session indicator.

### `POST /api/auth/logout`

Clears the current session and invalidates the server-side record.

## 2. Account endpoints

### `GET /api/accounts`

Lists account records.

Query parameters:

- `search` (optional): account number or customer name fragment
- `status` (optional): `ACTIVE` or `INACTIVE`

Access control:

- staff/admin: all matching accounts
- customers: only their own accounts

### `GET /api/accounts/:accountNumber`

Retrieves one account by number.

Access control:

- staff/admin: any valid account
- customers: only their own account

### `POST /api/accounts`

Creates an account and its associated customer record.

Request parameters:

```json
{
  "fullName": "Aditi Rao",
  "address": "12 MG Road, Bangalore",
  "phone": "9876543210",
  "initialDeposit": 500
}
```

• `fullName` (required): customer legal name (minimum 2 characters).
• `address` (required): residential address (minimum 8 characters).
• `phone` (required): Indian mobile phone format (`^(?:\+91)?[6-9]\d{9}$`).
• `initialDeposit` (required): minimum opening deposit of 500 Rupees.
• `idProofType` / `idProofNumber` (optional): automatically assigned internal verification credential (`INTERNAL_VERIFIED`) if omitted.

Access control:

- `ADMIN`, `STAFF`

Behavior:

- validates customer details and Indian phone format
- creates a unique 10-digit account number
- writes the customer and account atomically

### `POST /api/accounts/:accountNumber/deactivation-otp`

Generates and caches a secure 6-digit one-time authorization password (OTP) for account deactivation.

Prerequisite:
- Account balance must be exactly 0.00 Rupees. If balance > 0, returns HTTP 400 with `NON_ZERO_BALANCE`.

Response:
```json
{
  "success": true,
  "message": "Deactivation approval OTP generated for customer (+91 9876543210).",
  "demoOtp": "123456",
  "phone": "9876543210"
}
```

### `PATCH /api/accounts/:accountNumber/deactivate`

Deactivates an account following dual-step verification.

Requirements:
1. Account balance must be completely liquidated to 0.00 Rupees (rejects with `NON_ZERO_BALANCE` if balance > 0).
2. Must provide explicit confirmation and valid 6-digit customer OTP:

```json
{
  "confirm": true,
  "otp": "123456"
}
```

### `PATCH /api/accounts/:accountNumber/status`

Updates the status and requires explicit confirmation.

### `PATCH /api/accounts/:accountNumber/activate`

Reactivates an account after explicit confirmation.

## 3. Transaction endpoints

### `POST /api/transactions/deposit`

Creates a deposit for the supplied account.

Request:

```json
{
  "accountNumber": "7811288401",
  "amount": 250.5
}
```

Access control:

- `ADMIN`, `STAFF`

The route validates:

- account number format
- positive amount with at most two decimal places
- minimum balance rules where relevant
- idempotency key, if sent

### `POST /api/transactions/withdraw`

Creates a withdrawal with balance verification:
• Enforces standard 1,000 Rupees minimum retained balance policy.
• Supports `{ "closure": true }` flag to permit full balance liquidation to 0.00 Rupees specifically for account deactivation.

### `GET /api/transactions?accountNumber=7811288401`

Lists recent transactions for an account (newest first, capped at 50 rows).

### `GET /api/transactions/:transactionRef`

Retrieves a single transaction receipt record.

## 4. Reporting endpoints

### `GET /api/reports`

Generates an administrator report for a date range.

Query parameters:

- `startDate` (YYYY-MM-DD)
- `endDate` (YYYY-MM-DD)

Access control:

- `ADMIN` only

The response includes totals and active account counts for the requested period.

## 5. Administration endpoints

### `GET /api/admin/audit-logs?limit=50`

Returns recent security audit events.

### `GET /api/admin/staff`

Lists staff and admin users.

### `POST /api/admin/staff`

Creates a staff/admin account. Requires a username, password, and role.

### `POST /api/admin/customer-users`

Creates a customer login record for an existing customer.

### `PATCH /api/admin/staff/:userId/role`

Changes a staff role while protecting the last active admin from demotion.

## 6. Health endpoints

### `GET /api/health`

Returns a simple service status payload.

### `GET /api/health/db`

Checks that the configured database is reachable.

## 7. Error handling conventions

The API does not return stack traces or raw SQL internals. It uses JSON responses with a user-facing `message` field and HTTP status codes such as:

- `400` validation failure
- `401` unauthenticated
- `403` forbidden
- `404` record not found
- `409` conflict or duplicate request
- `413` oversized request
- `422` invalid input data
- `429` rate limit exceeded
- `500` generic internal error

## 8. Security notes for API consumers

- all authenticated requests depend on HTTP-only session cookies
- customer authorization is enforced by the backend against the database-backed session user
- sensitive banking content and credentials are not included in API error response payloads
- idempotency keys prevent duplicate financial requests from being processed again

# System architecture

This project is a full-stack banking application with a React frontend and an Express/MySQL backend.

## 1. High-level architecture

```text
Browser / Operator
    |
    v
React + Vite client (client/)
    |
    | HTTP / JSON via /api
    v
Express API server (server/src/app.js)
    |
    | MySQL queries via mysql2/promise
    v
MySQL 8 database
    |
    +-- customers
    +-- accounts
    +-- transactions
    +-- staff_users
    +-- customer_users
    +-- user_sessions
    +-- transaction_idempotency
    +-- security_audit_logs
```

## 2. Frontend architecture

- Framework: React 19
- Tooling: Vite 8
- Entry point: `client/src/App.jsx`
- Styling: `client/src/App.css`
- Runtime config: `import.meta.env.VITE_API_BASE` with `/api` default;
  Vite dev server proxies `/api` to `http://localhost:5000`

The frontend is a single-page application for staff/admin workflows and customer authentication. It renders dashboard, account search, account details, transaction posting, reporting, and administration screens. The UI keeps loading and validation state locally and only shows success after the backend returns a committed result.

## 3. Backend architecture

- Runtime: Node.js
- Framework: Express 5
- Database driver: `mysql2/promise`
- Authentication: bcrypt + express-session + MySQL-backed session storage
- Security controls: rate limiting, role checks, audit logging, validation helpers

Key backend modules:

- `server/src/app.js` — creates the Express app, CORS, session middleware, audit logger, and route mounting
- `server/src/db.js` — creates the MySQL pool from environment configuration
- `server/src/config.js` — validates environment variables and sanitizes secret-bearing values for logging
- `server/src/auth/routes.js` — login, logout, and session endpoints
- `server/src/auth/middleware.js` — role-based access enforcement and user/session resolution
- `server/src/routes/accounts.js` — account listing, lookup, creation, edits, and deactivation/activation logic
- `server/src/routes/transactions.js` — deposit/withdrawal processing, receipt generation, and idempotency handling
- `server/src/routes/reports.js` — date-range report generation for administrators
- `server/src/routes/admin.js` — admin staff/customer-user management and audit-log read access
- `server/src/audit-logger.js` — writes security and operational audit events

## 4. Database architecture

The database is MySQL 8-compatible and uses InnoDB tables. The schema is managed by versioned SQL migrations in `server/migrations/`.

- `000_create_banking_tables.sql` creates the core banking tables
- `001_create_staff_users.sql` creates staff login and session support
- `002_create_transaction_idempotency.sql` creates idempotency tracking for financial requests
- `003_create_customer_users.sql` creates customer login credentials
- `004_create_security_audit_logs.sql` creates audit-log storage
- `005_enforce_banking_constraints.sql` adds constraints and validation rules to existing data

The application expects an empty or controlled database before running migrations. Migration status is recorded in `schema_migrations` and the runner rejects invalid or conflicting data before applying enforcement constraints.

## 5. Authentication and authorization model

Authentication uses:

- bcrypt password hashing for staff and customer credentials
- HTTP-only session cookies
- a MySQL-backed session table (`user_sessions`)
- a 30-minute idle session timeout
- login-rate limiting to protect password attempts

Authorization is role-based:

- `ADMIN` and `STAFF` may operate on accounts and transactions
- `CUSTOMER` access is restricted to their own account and receipt data
- `ADMIN` alone may view reports and manage staff/customer-user credentials

The application resolves the current user from the session and validates ownership at the route level rather than trusting client-supplied customer IDs.

## 6. Transaction processing and integrity

Financial changes are processed in a transaction with both the balance update and transaction record committed together. The code also uses transaction idempotency to prevent duplicate requests from reprocessing the same financial action when the client repeats a request with the same key.

Key integrity mechanisms:

- checks for positive amounts and valid account numbers
- minimum-balance enforcement for withdrawals
- constraints for duplicate account numbers, duplicate transaction references, and invalid balance values
- `FOREIGN KEY` relationships and `CHECK` constraints on critical columns
- audit logging for both success and failure paths

## 7. Security and operational controls

The application intentionally prevents sensitive details from leaking to clients:

- generic error messages are used for API failures
- database details and stack traces are not returned to the client
- configuration secrets are redacted before logging
- local environment files are ignored by Git and must be kept outside source control

## 8. Operational notes

The repo contains operational scripts for:

- database migration: `npm run migrate`
- admin initialization: `npm run initialize-admin`
- password reset: `npm run reset-admin-password`
- backup: `npm run backup:db`
- restore: `npm run restore:db`

The project is designed to support a local development environment and a controlled deployment environment, rather than a production database being touched by the default local workflow.

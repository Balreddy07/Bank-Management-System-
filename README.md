# Bank Management System (BMS)

A full-stack, web-based banking application built with **React.js**, **Node.js**, **Express.js**, and **MySQL**. The system provides secure, role-based access for customer and account management, counter and digital deposits, withdrawals with balance thresholds, transaction records, audit logging, and administrative controls.

**GitHub Repository:** [Balreddy07/Bank-Management-System-](https://github.com/Balreddy07/Bank-Management-System-)

---

## Table of Contents
- [Overview](#overview)
- [Objectives](#objectives)
- [Technology Stack](#technology-stack)
- [System Architecture](#system-architecture)
- [Features and Modules](#features-and-modules)
- [Application Workflow](#application-workflow)
- [Database Design](#database-design)
- [Project Structure](#project-structure)
- [Installation and Setup](#installation-and-setup)
- [Environment Configuration](#environment-configuration)
- [Database Migrations](#database-migrations)
- [Running the Application](#running-the-application)
- [API Overview](#api-overview)
- [Testing](#testing)
- [Security and Data Integrity](#security-and-data-integrity)
- [Project Documentation](#project-documentation)
- [Future Enhancements](#future-enhancements)

---

## Overview

The **Bank Management System** is developed to streamline and digitize core retail banking operations through a secure, centralized web portal. 

It provides strict role-based separation:
- **Administrators:** Manage bank staff accounts, configure system roles, inspect security audit logs, and generate consolidated financial reports.
- **Staff Members:** Perform customer onboarding, verify KYC details, open accounts, handle cash deposits, counter withdrawals, and execute account lifecycle transitions (`ACTIVE` / `INACTIVE`).
- **Customers:** View authorized account balances, inspect transaction receipts, and review account statements.

The application follows a proven **three-tier architecture**: a React frontend, an Express/Node.js application layer enforcing banking domain rules, and a MySQL relational database guaranteeing ACID transaction compliance and data integrity.

---

## Objectives

- Digitize essential banking counter and customer self-service operations.
- Maintain accurate customer identity (KYC) and bank account records.
- Provide strict role-based access control (RBAC) across Administrator, Staff, and Customer users.
- Support secure authentication with bcrypt password hashing and persistent sessions.
- Process deposits and withdrawals with real-time balance calculations and atomic rollbacks.
- Prevent duplicate transactions through HTTP `Idempotency-Key` headers.
- Guarantee auditability by recording all security and authentication events separately from financial ledgers.
- Enforce database-level check constraints to eliminate negative balances and data corruption.

---

## Technology Stack

| Component | Technology | Version / Details |
| :--- | :--- | :--- |
| **Frontend Framework** | React.js | 19.x |
| **Build Tool & Dev Server** | Vite | 8.x |
| **Backend Runtime** | Node.js | LTS (v20+) |
| **Backend Framework** | Express.js | 5.x |
| **Database** | MySQL | 8.0.16 or later |
| **Database Driver** | `mysql2` | Connection pool with transaction support |
| **Authentication** | `bcrypt`, `express-session` | Salted hashing & HTTP-only cookies |
| **Session Persistence** | MySQL Session Store | Stored in `user_sessions` table |
| **Rate Limiting** | `express-rate-limit` | IP-based brute-force protection |
| **API Protocol** | RESTful JSON APIs | Standard HTTP status codes |
| **Unique Identifiers** | UUID v4 | High-entropy transaction references |
| **Testing** | Node.js Test Runner | Native `node:test` and `node:assert` |
| **Linting** | Oxlint | Fast frontend static analysis |
| **Version Control** | Git & GitHub | Feature branching and PR workflows |

---

## System Architecture

The application implements a clean **Three-Tier Architecture**:

1. **Presentation Layer (Frontend):** React + Vite single-page application providing responsive dashboards for Admin, Staff, and Customers. Communicates with the backend exclusively via JSON REST APIs.
2. **Application Layer (Backend):** Node.js and Express server handling routing, session validation, role enforcement, request sanitization, idempotency locking, business logic validation, and audit logging.
3. **Database Layer (Persistence):** MySQL relational database maintaining transactional ledger records, customer master records, credentials, and append-only audit trails with foreign keys and check constraints.

### Architecture Flow

```text
                  +--------------------------------------------------+
                  |           ADMIN  /  STAFF  /  CUSTOMER           |
                  +--------------------------------------------------+
                                           |
                                           v
                  +--------------------------------------------------+
                  |             REACT FRONTEND (Vite SPA)            |
                  +--------------------------------------------------+
                                           |
                                      REST APIs (JSON)
                                           v
                  +--------------------------------------------------+
                  |              NODE.JS + EXPRESS BACKEND           |
                  |                                                  |
                  |   +-------------------+  +-------------------+   |
                  |   |  Authentication   |  | Banking Validation|   |
                  |   |  & Session Store  |  |  & Domain Rules   |   |
                  |   +-------------------+  +-------------------+   |
                  |   +-------------------+  +-------------------+   |
                  |   | Security & Audit  |  |  Idempotency Key  |   |
                  |   |     Logging       |  |     Manager       |   |
                  |   +-------------------+  +-------------------+   |
                  +--------------------------------------------------+
                                           |
                                 mysql2 Connection Pool
                                           v
                  +--------------------------------------------------+
                  |                 MYSQL DATABASE                   |
                  |  (customers, accounts, transactions, audit_logs) |
                  +--------------------------------------------------+
```

---

## Features and Modules

### 1. Authentication & Session Management
- Role-based separation: `ADMIN`, `STAFF`, and `CUSTOMER`.
- Secure password hashing using `bcrypt` (10 rounds).
- HTTP-only, `SameSite=Lax` session cookies.
- MySQL-backed persistent sessions in `user_sessions`.
- Sliding 30-minute inactivity session expiry.
- Automatic account lockout for 15 minutes after 3 consecutive failed login attempts.
- Rate limiting: max 20 login attempts per IP per 15 minutes.

### 2. Customer Management
- Complete customer KYC registration (Full Name, Address, Phone Number, Identity Proof).
- Verification and contact information update by authorized staff.
- Strict mapping between customer profiles and login accounts.

### 3. Bank Account Management
- Account creation by authorized staff and administrators.
- Automated generation of unique 10-digit account numbers.
- Mandatory minimum initial deposit of ₹500 at account opening.
- Real-time account search by account number or customer name.
- Status filtering (`ACTIVE` vs `INACTIVE`).
- Controlled account activation and deactivation with employee confirmation safeguards.

### 4. Deposit Management
- Counter and online deposit processing for active accounts.
- Strict input validation on account number and positive decimal amount.
- Real-time balance updates wrapped in database transactions.
- Generation of a unique alphanumeric transaction reference receipt.

### 5. Withdrawal Management
- Secure cash withdrawal with atomic balance verification.
- Enforces minimum retained balance of ₹1,000 (cannot withdraw below ₹1,000).
- Immediate rejection of overdraft or negative-balance attempts.
- Rollback safety on failure.

### 6. Transaction History and Receipts
- Immutable storage of successful transactions in `transactions`.
- Instant transaction receipt generation (`/api/transactions/:transactionRef`).
- Paginated/latest 50 transaction history with stable timestamp ordering.

### 7. Transaction Idempotency
- Supports optional `Idempotency-Key` HTTP headers on `/deposit` and `/withdraw`.
- Repeated requests with the identical key return the original cached receipt without double-debiting.
- Conflicting parameters with a previously used key return HTTP 409 Conflict.

### 8. Administrative Management
- Staff account provisioning and role updates (`STAFF` <-> `ADMIN`).
- Protection preventing the accidental deletion or role-downgrade of the last remaining admin.
- Customer online login credential generation.
- Full access to the security audit event stream.

### 9. Reports & Analytics
- Administrator date-range reporting for deposit totals, withdrawal totals, and net cash flow.
- Active account count and aggregate deposit balance metrics generated in $< 10\text{ seconds}$.

### 10. Security Audit Logging
- Dedicated `security_audit_logs` table separate from transaction logs.
- Captures login successes, failed logins, lockouts, authorization rejections, and account lifecycle changes.
- Sanitized: never logs raw passwords, session tokens, or sensitive credentials.

---

## Application Workflow

1. **Authentication:** User enters credentials on the React login screen; backend verifies bcrypt hash and issues an encrypted session cookie.
2. **Authorization:** Middleware checks role privileges against the requested endpoint (`ADMIN`, `STAFF`, or `CUSTOMER`).
3. **Transaction Execution:**
   - Client sends deposit/withdrawal payload with optional `Idempotency-Key`.
   - Backend initiates a MySQL transaction: `START TRANSACTION`.
   - Acquires row-level lock (`FOR UPDATE`) on the account.
   - Verifies account status is `ACTIVE` and balance limits (Balance $-$ Amount $\ge ₹1,000$).
   - Inserts record into `transactions`, updates `accounts.balance`, and saves idempotency receipt.
   - Executes `COMMIT` (or `ROLLBACK` on any validation failure).
4. **Audit Trail:** Security-critical operations log an immutable entry into `security_audit_logs`.
5. **UI Update:** Frontend displays the newly generated transaction reference ID, updated balance, and receipt view.

---

## Database Design

**Database Name:** `bank_management_system`

| Table Name | Description | Key Constraints |
| :--- | :--- | :--- |
| `customers` | Customer identity and KYC data | `id` (PK), `phone` (Unique) |
| `accounts` | Bank accounts and live balances | `id` (PK), `account_number` (Unique 10-digit), `CHECK(balance >= 0)` |
| `transactions` | Ledger of deposits & withdrawals | `id` (PK), `transaction_ref` (Unique UUID), `account_id` (FK) |
| `staff_users` | Administrator and staff credentials | `id` (PK), `username` (Unique), `role` (`ADMIN`/`STAFF`) |
| `customer_users` | Customer login credentials | `id` (PK), `customer_id` (FK Unique), `username` (Unique) |
| `user_sessions` | Persistent MySQL session store | `session_id` (PK), `expires` index |
| `transaction_idempotency` | Duplicate transaction filter | `idempotency_key` (Unique), `account_id` (FK) |
| `security_audit_logs` | Immutable security audit events | `id` (PK), `event_type`, `timestamp` |
| `schema_migrations` | Applied database migration history | `version` (PK), `checksum` |

---

## Project Structure

```text
Bank-Management-System/
├── client/                               # React + Vite Frontend
│   ├── public/
│   ├── src/
│   │   ├── assets/
│   │   ├── App.jsx                       # Main application router and state
│   │   ├── App.css                       # Responsive UI design styling
│   │   ├── index.css
│   │   └── main.jsx
│   ├── package.json
│   └── vite.config.js
│
├── server/                               # Node.js + Express.js Backend
│   ├── migrations/                       # Sequential database migration scripts
│   │   ├── 000_create_banking_tables.sql
│   │   ├── 001_create_staff_users.sql
│   │   ├── 002_create_transaction_idempotency.sql
│   │   ├── 003_create_customer_users.sql
│   │   ├── 004_create_security_audit_logs.sql
│   │   └── 005_enforce_banking_constraints.sql
│   ├── src/
│   │   ├── auth/                         # Session and password authentication
│   │   ├── routes/                       # Express route controllers (accounts, transactions, admin, reports)
│   │   ├── scripts/                      # DB migration, backup-recovery, benchmark scripts
│   │   ├── app.js                        # Express middleware & app configuration
│   │   ├── db.js                         # MySQL connection pool
│   │   ├── audit-logger.js               # Security event logger
│   │   ├── validation.js                 # Input sanitation & validation rules
│   │   └── server.js                     # HTTP server entry point
│   ├── test/                             # Automated test suites
│   ├── .env.example.template
│   ├── package.json
│   └── README.md
│
├── Documents/                            # Formal Specification & Architecture Documents
│   ├── SRS_Document.pdf
│   ├── Bank_Management_System_Software_Architecture.pdf
│   ├── Bank_Management_System_Security_Requirements.pdf
│   ├── Test_Plan_Document.pdf
│   ├── Bank_Management_System_Use_Case_Diagram.pdf
│   └── Bank_Management_System_Use_Case_Flow.pdf
│
├── docs/                                 # Technical Reports, Runbooks & Agile Records
│   ├── api-reference.md
│   ├── architecture.md
│   ├── database-schema.md
│   ├── configuration-and-setup.md
│   ├── requirements-traceability.md
│   ├── release-readiness.md
│   └── security-testing.md
│
├── .gitignore
└── README.md                             # Root Project Documentation (This File)
```

---

## Installation and Setup

### Prerequisites
- **Node.js**: v20.x LTS or newer
- **npm**: v10.x or newer
- **MySQL Server**: v8.0.16 or later
- **Git**

### 1. Clone the Repository
```bash
git clone https://github.com/Balreddy07/Bank-Management-System-.git
cd Bank-Management-System-
```

### 2. Install Backend Dependencies
```bash
cd server
npm install
```

### 3. Install Frontend Dependencies
```bash
cd ../client
npm install
```

### 4. Configure MySQL Database
Log into MySQL and initialize an empty database:
```sql
CREATE DATABASE bank_management_system 
  CHARACTER SET utf8mb4 
  COLLATE utf8mb4_0900_ai_ci;
```

---

## Environment Configuration

Create a `.env` file inside the `server/` directory:

```ini
# server/.env
DB_HOST=localhost
DB_PORT=3306
DB_USER=your_mysql_username
DB_PASSWORD=your_mysql_password
DB_NAME=bank_management_system
SESSION_SECRET=replace_with_a_random_secret_of_at_least_32_characters
PORT=5000
NODE_ENV=development
CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173
SESSION_COOKIE_SECURE=false
SESSION_COOKIE_SAME_SITE=lax
LOGIN_RATE_LIMIT=20
```

> **Security Note:** Never commit real `.env` files or credentials to Git. `server/.env` is ignored by `.gitignore`.

---

## Database Migrations

Apply versioned SQL migrations to build the complete schema:

```bash
cd server
npm run migrate
```

To verify the migration status without applying changes:
```bash
npm run migrate:status
```

---

## Running the Application

### 1. Start the Backend API Server
```bash
cd server
npm run dev
```
*API server will start on:* **`http://localhost:5000`**

### 2. Start the Frontend Development Client
In a separate terminal:
```bash
cd client
npm run dev
```
*Vite frontend will open on:* **`http://localhost:5173`**

---

## API Overview

All backend endpoints are scoped under `/api`.

| Module | Method | Endpoint | Description | Auth Required |
| :--- | :---: | :--- | :--- | :---: |
| **Auth** | `POST` | `/api/auth/login` | Authenticate user & issue session cookie | No |
| **Auth** | `GET` | `/api/auth/session` | Inspect active authenticated session | Yes |
| **Auth** | `POST` | `/api/auth/logout` | Terminate session and clear cookie | Yes |
| **Accounts** | `GET` | `/api/accounts` | List and search customer accounts | Staff / Admin |
| **Accounts** | `GET` | `/api/accounts/:accountNumber` | Retrieve single account details | Staff / Admin / Owner |
| **Accounts** | `POST` | `/api/accounts` | Create customer & open account ($\ge ₹500$) | Staff / Admin |
| **Accounts** | `PATCH` | `/api/accounts/:accountNumber` | Update customer KYC details | Staff / Admin |
| **Accounts** | `PATCH` | `/api/accounts/:accountNumber/deactivate` | Deactivate account with confirmation | Staff / Admin |
| **Transactions** | `POST` | `/api/transactions/deposit` | Process account deposit | Staff / Admin |
| **Transactions** | `POST` | `/api/transactions/withdraw` | Process cash withdrawal ($\ge ₹1,000$ limit) | Staff / Admin |
| **Transactions** | `GET` | `/api/transactions` | Retrieve account transaction history | Staff / Admin / Owner |
| **Transactions** | `GET` | `/api/transactions/:transactionRef` | Fetch official transaction receipt | Staff / Admin / Owner |
| **Reports** | `GET` | `/api/reports` | Date-range financial summary | Admin only |
| **Admin** | `GET` | `/api/admin/staff` | List staff accounts | Admin only |
| **Admin** | `POST` | `/api/admin/staff` | Provision staff or admin user | Admin only |
| **Admin** | `POST` | `/api/admin/customer-users` | Provision online customer login | Admin only |
| **Admin** | `PATCH` | `/api/admin/staff/:userId/role` | Change staff role permissions | Admin only |
| **Audit** | `GET` | `/api/admin/audit-logs` | Inspect security audit event log | Admin only |

---

## Testing

The project uses the Node.js native test runner (`node:test`) for zero-dependency backend testing and Oxlint for frontend verification:

```bash
# Run all backend automated test suites
cd server
npm test

# Run frontend linting
cd ../client
npm run lint

# Verify frontend production build
npm run build
```

### Coverage Highlights
- **Transactions & Concurrency:** Multi-client balance race conditions, rollback handling, and idempotency key uniqueness.
- **Security & Authorization:** Password hashing, brute-force lockout, session expiration, and role boundaries.
- **Database Schema & Constraints:** Check constraints, foreign keys, and migration checksum validation.
- **Performance:** `server/src/scripts/concurrent-load-runner.js` (500 virtual user simulation) and `session-capacity-runner.js` (1,000 session capacity check).

---

## Security and Data Integrity

- **Password Storage:** One-way salted hashes using `bcrypt`.
- **Session Security:** `HttpOnly`, `SameSite=Lax` cookies; sessions persisted in MySQL.
- **Defense in Depth:** Dual-layer validation at both the Express controller layer and MySQL `CHECK` constraints.
- **ACID Transactions:** Row-level locks (`SELECT ... FOR UPDATE`) during financial mutations.
- **Audit Trails:** Security events captured with timestamps, actor IDs, and IP addresses without leaking secrets.

---

## Project Documentation

| Document | File Location | Description |
| :--- | :--- | :--- |
| **Software Requirements Specification (SRS)** | `Documents/SRS_Document.pdf` | Complete functional and non-functional requirements |
| **Software Architecture Document (SAD)** | `Documents/Bank_Management_System_Software_Architecture.pdf` | Architectural design, module layout, and component flow |
| **Security Requirements Document** | `Documents/Bank_Management_System_Security_Requirements.pdf` | Cryptographic standards, access control, and audit policies |
| **Test Plan Document** | `Documents/Test_Plan_Document.pdf` | Test scope, acceptance criteria, and QA strategy |
| **Use Case Diagram** | `Documents/Bank_Management_System_Use_Case_Diagram.pdf` | Actor-to-system boundary diagram |
| **Use Case Flow Document** | `Documents/Bank_Management_System_Use_Case_Flow.pdf` | Step-by-step use case interaction flows |
| **Requirements Traceability Matrix** | `docs/requirements-traceability.md` | Verification status of FR-1 to FR-8 and NFR-1 to NFR-5 |
| **Database Schema Reference** | `docs/database-schema.md` | DDL schema, relationships, and indexing strategy |
| **API Reference Guide** | `docs/api-reference.md` | Request/response payloads and error schemas |

---

## Future Enhancements

- Customer self-service fund transfers (NEFT / RTGS / IMPS simulation).
- Two-Factor Authentication (2FA) and OTP-verified account deactivation.
- Automated PDF receipt generation and email statements.
- Scheduled interest calculation and account maintenance fees.
- Multi-branch hierarchy and localized reporting.

---

**Repository:** [Balreddy07/Bank-Management-System-](https://github.com/Balreddy07/Bank-Management-System-)  
**Contributors:** Balreddy (`balreddy07`), B Koushikraj (`koushikraj52`), Aditi Hubli (`Aditi H`)

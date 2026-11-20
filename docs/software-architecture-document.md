# Bank Management System — Software Architecture Document

Document Purpose: This document provides the comprehensive architectural blueprint for the Bank Management System. It specifies the production-verified technology stack, structural decomposition, component responsibilities, data flow, concurrency controls, and deployment topology.

Architecture Status: Verified Implementation Architecture.

---

## 1. System Overview and Purpose

The Bank Management System is an enterprise-grade banking application designed to handle retail banking operations including customer onboarding, account lifecycle management, high-concurrency deposits and withdrawals, transaction audit logging, and financial business reporting.

---

## 2. Confirmed Technology Stack

| Architecture Tier | Technology Selection | Version / Specification | Architectural Justification |
| :--- | :--- | :--- | :--- |
| Presentation Layer | React.js with Vite | React 18.3, Vite 5.x | High-performance Single Page Application (SPA), component-driven state management, responsive UI, zero page flickers. |
| Application / Business Layer | Node.js with Express | Node.js 20+ LTS, Express 5.x | Non-blocking asynchronous I/O, event-driven scalability, robust middleware pipeline, fast JSON processing. |
| Data Persistence Layer | MySQL Relational Database | MySQL 8.0 (InnoDB Engine) | ACID transaction compliance, strict foreign key constraints, row-level locking (`FOR UPDATE`), deterministic indexing. |
| Connection Management | MySQL2 Connection Pool | `mysql2/promise` | Connection pooling with automated lifecycle management, parameterized query execution to prevent SQL injection. |
| Security and Cryptography | Bcrypt & Web Crypto | `bcrypt` (10 salt rounds), `crypto` | Industry-standard password hashing, cryptographic random integer generation for account numbers and OTP tokens. |
| Session Management | Express-Session | In-memory / Cookie store | Secure HTTP session state tracking with HttpOnly cookies, inactivity expiration, and role context hydration. |

---

## 3. Layered Architectural Decomposition

The system implements a classic 3-Tier Layered Architecture with strict separation of concerns:

```
+-----------------------------------------------------------------------+
|                         PRESENTATION LAYER                            |
|  React 18 Single Page Application (Vite Build)                        |
|  • Customer Dashboard     • Staff Account Desk   • Admin Reports Hub  |
|  • Transaction Modals     • Deactivation Wizard  • Session Banner     |
+-----------------------------------------------------------------------+
                                  │
                       HTTP / REST API (JSON)
                                  ▼
+-----------------------------------------------------------------------+
|                    APPLICATION / BUSINESS LAYER                       |
|  Node.js + Express 5 Middleware & Routing Pipeline                    |
|  • Auth & Session Guard   • Role-Based Access Control (RBAC)          |
|  • Account Lifecycle Svc  • Dual-Step Deactivation & OTP Engine      |
|  • Transaction Engine     • Idempotency Gate                          |
|  • Audit Logging Svc      • Financial Analytics Aggregator            |
+-----------------------------------------------------------------------+
                                  │
                   Connection Pool (mysql2/promise)
                                  ▼
+-----------------------------------------------------------------------+
|                         DATA PERSISTENCE LAYER                        |
|  MySQL 8.0 Relational Database (InnoDB Storage Engine)                |
|  • users                  • customers            • accounts           |
|  • transactions           • security_audit_logs  • idempotency_keys   |
+-----------------------------------------------------------------------+
```

---

### 3.3 Component (UML) Diagram

The architecture is modelled as three UML 2.0 subsystems. Each cross-tier interface is an assembly connector (ball-and-socket) between boundary ports: the Presentation Tier requires ISessionAuth, IAccountAPI, ITransactionAPI, IAdminService and IDeactivationOTP, which the Application Tier provides, and the Application Tier requires IDataAccess, which the Data Tier provides. Dashed arrows labelled use are dependencies between components.

```
+-------------------------------------------------------------------------------------------------------------------------+
|                                    UML Component Diagram - Bank Management System (BMS)                                 |
+-------------------------------------------------------------------------------------------------------------------------+
|                                                                                                                         |
| +--<<subsystem>>--------------------+  +--<<subsystem>>----------------------------+  +--<<subsystem>>----------------+ |
| | Presentation Tier (Web Client)    |  | Application Tier (Node.js/Express Backend)|  | Data Tier (MySQL Database)    | |
| |                                   |  |                                           |  |                               | |
| |        Internal structure         |  |            Internal structure             |  |      Internal structure       | |
| |                                   |  |                                           |  |                               | |
| | +------------------+              |  | +------------------+   <<use>> +--------+ |  |                               | |
| | | :CustomerPortal  |              |  | |:AuthSessionGuard | - - - - > | :RBAC  | |  |                               | |
| | | Balance,passbook |              |  | |Session, lockout  |           | Middle | |  |                               | |
| | +------------------+              |  | +------------------+           | -ware  | |  |                               | |
| |          |                        |  |                                +--------+ |  |                               | |
| |       <<use>>                     |  |                                           |  |                               | |
| |          v                        |  |                                           |  |                               | |
| | +------------------+  +---------+ |  | +------------------+                      |  |                               | |
| | | :StaffDesk       |  |:APIClient| | | |:AccountService   |                      |  |                               | |
| | | Onboard, cashier |->|REST     |[]| |[]|10-digit number  |                      |  |                               | |
| | +------------------+  |client   |()-O| |Indian phone regex|                      |  |                               | |
| |          ^            |session  |[]| |[]+------------------+                     |  |                               | |
| |          |     <<use>>|tokens   | |  |                                +--------+ |  |                               | |
| |       <<use>>         +---------+ |  | +------------------+   <<use>> |:DBPool | |  | +---------------------------+ | |
| |          |                 |      |  | |:TransactionEngine| - - - - > |mysql2  |[]| |[]| :MySQLSchema              | | |
| | +------------------+       |      |  | |Balance guards    |           |pool    |()-O| | Relational tables:         | | |
| | | :AdminDashboard  |       |      |  | |Closure exception |           +--------+ |  |[]| users, customers,        | | |
| | | Reports, audit   |- - - -+      |  | +------------------+                ^     |  |  | accounts, transactions,   | | |
| | +------------------+    <<use>>   |  |          |                          |     |  |  | idempotency_keys,         | | |
| |                                   |  |       <<use>>                       |     |  |  | security_audit_logs       | | |
| |                                   |  |          v                          |     |  | +---------------------------+ | |
| |                                   |  | +------------------+                |     |  |                               | |
| |                                   |  | |:IdempotencyMgr   | - - - - - - - -+     |  |                               | |
| |                                   |  | |SHA-256 deduplicat|             <<use>>  |  |                               | |
| |                                   |  | +------------------+                      |  |                               | |
| |                                   |  |                                           |  |                               | |
| |                                   |  | +------------------+                      |  |                               | |
| |                                   |  | | :OTPService      | - - - - - - - - - - -+  |                               | |
| |                                   |  | | 6-digit OTP auth |              <<use>> |  |                               | |
| |                                   |  | +------------------+                      |  |                               | |
| +-----------------------------------+  +-------------------------------------------+  +-------------------------------+ |
|                                                                                                                         |
| Legend:                                                                                                                 |
| [ ] Component   [] Port (boundary)   --O Provided interface (lollipop)   -( Required interface (socket)  --O)- Assembly |
| - - - > <<use>> dependency (client uses supplier)                                                                       |
+-------------------------------------------------------------------------------------------------------------------------+
Figure 3.1: Proposed Three-Tier Component Architecture (UML 2.0 Component Diagram)
```

---

## 4. Component Responsibilities

### 4.1 Presentation / User Interface Components
• `AuthContext / Login`: Captures credentials, manages session states, displays error banners, and routes users based on assigned roles.
• `AccountManagementView`: Renders account directory, search and filtering tools, and opening form.
• `DeactivationModal`: Multi-stage interactive modal that handles mandatory balance liquidation before deactivation and customer OTP authorization.
• `TransactionView`: Real-time transaction form with live balance updates, slip generation, and receipt printing.
• `ReportsDashboard`: Interactive date-range query interface displaying financial metrics, debit/credit totals, and summary cards.

### 4.2 Application and Business Logic Services
• `Authentication & Lockout Service`: Validates credentials, manages failed login attempts in memory and persistence, enforces the 15-minute lockout timer after 3 failures.
• `Authorization Service (RBAC)`: Middleware inspecting `req.user.role` to restrict administrative actions to ADMIN and staff tasks to STAFF.
• `Account Management Service`: Validates customer inputs, validates Indian mobile format, assigns internal compliance tokens, and enforces the Rs. 500 opening deposit.
• `Account Deactivation & OTP Engine`: Enforces zero-balance pre-condition; generates, caches, and verifies 6-digit one-time passwords for customer consent before deactivation.
• `Transaction Processing Engine`: Coordinates atomic deposits and withdrawals; enforces the Rs. 1,000 minimum balance rule while supporting the closure liquidation exception.
• `Audit Logger`: Captures all sensitive operational events asynchronously into an append-only audit ledger.
• `Reporting Service`: Compiles real-time aggregation queries across accounts and transaction ledgers.

### 4.3 Data Access Layer
• Handles parameterized SQL queries, explicit transaction demarcation (`beginTransaction`, `commit`, `rollback`), connection pool management, and standardized database error mapping.

---

## 5. Database Entity-Relationship Model

| Table Name | Primary Key | Key Foreign Keys | Purpose and Constraints |
| :--- | :--- | :--- | :--- |
| `users` | `user_id` | `customer_id` (optional) | Stores user login credentials, password hashes, role (`ADMIN`, `STAFF`, `CUSTOMER`), failed attempts, and lock timestamps. |
| `customers` | `customer_id` | None | Stores customer contact profile: full name, address, Indian mobile number, and internal compliance token reference. |
| `accounts` | `account_id` | `customer_id` -> `customers` | Stores bank account number (10 digits UNIQUE), current monetary balance, status (`ACTIVE`, `INACTIVE`), and creation timestamp. |
| `transactions` | `transaction_id` | `account_id` -> `accounts` | Immutable ledger of financial events: UUID reference, type (`DEPOSIT`, `WITHDRAWAL`), amount, post-transaction balance. |
| `security_audit_logs` | `audit_id` | `actor_user_id` -> `users` | Immutable audit log of administrative and security events with outcome status (`SUCCESS`, `FAILURE`). |
| `transaction_idempotency` | `idempotency_key` | `transaction_id` | Enforces request idempotency and prevents duplicate financial processing on network retries. |

---

## 6. Key System Workflows and Concurrency Controls

### 6.1 Account Opening Workflow
1. Staff submits customer profile (Name, Address, Indian Mobile Number) and opening deposit ($\ge$ Rs. 500).
2. Service validates inputs and assigns internal compliance token `INTERNAL_VERIFIED`.
3. Generator generates a unique 10-digit account number.
4. Database transaction inserts customer, account, and initial transaction record.
5. Audit event recorded and account number returned to user.

### 6.2 Financial Transaction Concurrency Workflow
1. Transaction engine acquires an exclusive row-level lock (`SELECT ... FOR UPDATE`) on the target account.
2. Engine verifies account status is ACTIVE.
3. Engine computes next balance. For withdrawals:
   • If standard withdrawal: requires `NextBalance >= Rs. 1,000.00`.
   • If closure withdrawal: allows `NextBalance == Rs. 0.00`.
4. Engine updates account balance and appends transaction record.
5. Database transaction commits, releasing the lock.

### 6.3 Dual-Step Account Deactivation Workflow
1. User requests deactivation of an active account.
2. System checks current balance:
   • If balance $> 0$: system prompts mandatory balance liquidation; user clicks Withdraw Full Balance which executes closure withdrawal down to Rs. 0.00.
   • If balance $== 0$: system transitions to OTP verification.
3. System generates 6-digit OTP and records customer mobile number.
4. Staff enters OTP. Upon verification, system atomically marks account INACTIVE and logs audit record.

---

## 7. Cross-Cutting Quality Attributes

• Security: All passwords hashed with bcrypt (salt rounds >= 10); 15-minute lockout on 3 consecutive failures; role-based endpoint protection.
• Transaction Integrity: Full ACID compliance with pessimistic locking preventing double-debits and negative balances.
• Performance: 95% of transactions execute in under 2.0 seconds with support for up to 500 concurrent users.
• Scalability: Node.js non-blocking architecture supports over 1,000 concurrent sessions within 4.0 seconds response time.
• Maintainability: Modular directory layout with clean separation between client components, route handlers, database drivers, and validation utilities.
• Reliability: Comprehensive automated migrations, integrity checks, and backup/restoration scripts.

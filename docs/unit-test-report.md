# Unit Test Report

**Project:** Bank Management System (BMS)  
**Execution Environment:** Node.js v22.19.0, Express.js 5.x, MySQL 8.0, Native Test Runner (`node:test`, `node:assert`)  
**Repository:** [Balreddy07/Bank-Management-System-](https://github.com/Balreddy07/Bank-Management-System-)  
**Date of Execution:** November 19, 2026  
**QA Lead:** Aditi Hubli (`PES1UG24CS652`)  
**Contributors:** Balreddy (`PES1UG24CS658`), B Koushikraj  

---

## 1. Testing Objectives

The primary objective of unit and integration testing for the Bank Management System is to verify the functional correctness, mathematical consistency, transactional integrity, and error resilience of each individual component in isolation and in integration with database abstractions.

Key verification areas include:
1. **Mathematical Ledger Integrity:** Ensuring balance calculations, initial deposits ($\ge ₹500$), minimum retained withdrawal balance ($\ge ₹1,000$), and overdraft rejection strictly adhere to banking rules.
2. **Transaction Atomicity & Rollback:** Verifying that any runtime, database, or connection failure during a balance mutation initiates an immediate SQL rollback without leaving partial or phantom records.
3. **Idempotency & Race Conditions:** Validating that duplicate HTTP requests with identical `Idempotency-Key` headers replay the original committed receipt without double-debiting or balance corruption.
4. **Authentication & Access Control:** Confirming bcrypt password hashing, 3-attempt lockout timing, session cookie security flags (`HttpOnly`, `SameSite=Lax`), and role-based route guards (`ADMIN`, `STAFF`, `CUSTOMER`).
5. **Database Migration & Constraint Verification:** Ensuring schema integrity, foreign keys, and check constraints (`balance >= 0`) are validated upon application boot.

---

## 2. Unit Testing Strategy & Framework

- **Test Runner:** Node.js built-in native test harness (`node:test`) providing high-speed, zero-dependency test execution with sub-millisecond assertion resolution.
- **Assertion Library:** Strict deep equality and exception assertions via `node:assert/strict`.
- **Mocking & Isolation:** In-memory HTTP servers, throwaway MySQL transaction scopes, and parameterized test tables for input boundary fuzzing.
- **Execution Command:**
  ```bash
  cd server
  npm test
  ```
- **Coverage Profiling:**
  ```bash
  node --test --experimental-test-coverage
  ```

---

## 3. Test Suites and Execution Summary

| Test Suite File | Scope / Module | Total Tests | Passed | Failed | Duration | Status |
| :--- | :--- | :---: | :---: | :---: | :---: | :---: |
| `server/test/config.test.js` | Environment variables, port sanitization, secret verification | 5 | 5 | 0 | 12 ms | **PASS** |
| `server/test/migrations.test.js` | Schema version ordering, checksums, constraint definitions | 12 | 12 | 0 | 48 ms | **PASS** |
| `server/test/admin-password-reset.test.js` | Admin recovery script, transactional password resets, role checks | 4 | 4 | 0 | 16 ms | **PASS** |
| `server/test/backup-recovery.test.js` | Backup creation, SHA-256 generation, corrupt dump rejection | 11 | 11 | 0 | 695 ms | **PASS** |
| `server/test/error-handling.test.js` | Sanitized error handlers, stack trace suppression in production | 6 | 6 | 0 | 19 ms | **PASS** |
| `server/test/security.test.js` | Brute-force lockout, rate limiting, bcrypt hashing, session cookies | 14 | 14 | 0 | 185 ms | **PASS** |
| `server/test/transactions.test.js` | Account creation, deposit processing, withdrawal balance rules | 42 | 42 | 0 | 340 ms | **PASS** |
| `server/test/transactions-concurrency.test.js` | Parallel request race conditions, row-level lock verification | 8 | 8 | 0 | 125 ms | **PASS** |
| `server/test/transaction-performance.test.js` | Latency metrics, percentile calculations (p50, p95, p99) | 5 | 5 | 0 | 62 ms | **PASS** |
| `server/test/session-capacity.test.js` | Concurrent session scaling simulation, cookie serialization | 7 | 7 | 0 | 88 ms | **PASS** |
| `server/test/concurrent-load.test.js` | 500 Virtual User parameter validation, request generator guards | 6 | 6 | 0 | 74 ms | **PASS** |
| **Total Automated Suite** | **Entire Application Stack** | **120** | **120** | **0** | **1.66 s** | **100% PASS** |

---

## 4. Detailed Test Cases and Verification Results

### A. Account Opening & Customer Management (`accounts.js`)
* **TC-ACC-001 (Valid Customer Onboarding):** Submitting valid name, phone, address, and ₹1,000 initial deposit returns HTTP 201, creates an account with status `ACTIVE`, and generates a unique 10-digit account number. *(Result: PASS)*
* **TC-ACC-002 (Initial Deposit Threshold Rejection):** Submitting initial deposit of ₹499 (below ₹500 minimum) returns HTTP 400 with message `"Initial deposit must be at least ₹500"`. *(Result: PASS)*
* **TC-ACC-003 (Duplicate Phone Rejection):** Attempting to register a customer with an existing phone number triggers database unique constraint and returns HTTP 409 Conflict. *(Result: PASS)*
* **TC-ACC-004 (Account Search & Status Filter):** Searching accounts by customer name substring or filtering by `status=INACTIVE` returns only matching subsets within 100-record boundary. *(Result: PASS)*

### B. Deposit & Withdrawal Financial Logic (`transactions.js`)
* **TC-TX-001 (Standard Deposit):** Deposit of ₹2,500 into an active account increments balance atomically and generates a UUID v4 transaction reference. *(Result: PASS)*
* **TC-TX-002 (Withdrawal Balance Guard):** For an account with ₹3,000 balance, requesting withdrawal of ₹2,500 (which would leave ₹500, violating ₹1,000 minimum) is rejected with HTTP 400 `"Insufficient balance. Minimum balance of ₹1,000 required."` *(Result: PASS)*
* **TC-TX-003 (Exact Minimum Balance Withdrawal):** For an account with ₹3,000 balance, requesting withdrawal of ₹2,000 (leaving exactly ₹1,000) succeeds and commits new balance ₹1,000.00. *(Result: PASS)*
* **TC-TX-004 (Negative or Zero Amount Rejection):** Submitting deposit or withdrawal with amount $\le 0$ or non-numeric values returns HTTP 400 validation error. *(Result: PASS)*
* **TC-TX-005 (Inactive Account Restriction):** Financial operations on accounts with `status = 'INACTIVE'` are blocked with HTTP 409 Conflict. *(Result: PASS)*

### C. Concurrency & Idempotency (`transaction_idempotency`)
* **TC-IDEM-001 (Identical Request Replay):** Submitting two identical deposit requests with the same `Idempotency-Key` executes the database transaction once and returns the cached receipt on the second call. *(Result: PASS)*
* **TC-IDEM-002 (Mismatched Payload Conflict):** Submitting a request with an existing `Idempotency-Key` but altered amount returns HTTP 409 Conflict. *(Result: PASS)*
* **TC-RACE-001 (Parallel Withdrawals):** Firing 10 simultaneous withdrawal requests against a single account using row-level locks (`SELECT ... FOR UPDATE`) prevents negative balances and maintains serializability. *(Result: PASS)*

### D. Authentication, Authorization & Security (`auth/routes.js`)
* **TC-SEC-001 (Password Verification):** Verifies bcrypt salted hash; rejects invalid passwords with generic `"Invalid username or password"`. *(Result: PASS)*
* **TC-SEC-002 (Brute-Force Lockout):** 3 consecutive failed login attempts locks account for 15 minutes; 4th attempt is immediately rejected with HTTP 423 Locked. *(Result: PASS)*
* **TC-SEC-003 (Role Guarding):** Customer session attempting to access `/api/admin/staff` or `/api/reports` receives HTTP 403 Forbidden. *(Result: PASS)*
* **TC-SEC-004 (Audit Logging):** All failed logins, privilege denials, and account lifecycle changes insert an immutable record into `security_audit_logs`. *(Result: PASS)*

---

## 5. Defects Identified and Resolved During Testing

| Defect ID | Severity | Root Cause | Resolution / Fix | Retest Status |
| :--- | :---: | :--- | :--- | :---: |
| **DEF-01** | High | MySQL 8.0 `CHECK` constraints on negative balances produced non-standard error codes on some versions. | Added normalization in migration runner to verify check constraints compatibility. | Verified PASS in `migrations.test.js` |
| **DEF-02** | Medium | Race condition where concurrent withdrawals on low balance could allow intermediate dirty reads. | Enforced `FOR UPDATE` row lock on account record inside transactional boundary. | Verified PASS in `transactions-concurrency.test.js` |
| **DEF-03** | Low | Session store cookie expiry time failed to refresh on read-only requests. | Implemented sliding window session touch in authentication middleware. | Verified PASS in `security.test.js` |

---

## 6. QA Sign-Off

The unit test suite has achieved **100% pass rate** across all 120 automated test cases. The core banking rules, transactional safety, cryptographic standards, and access control boundaries are completely verified.

# System Validation Report

**Project:** Bank Management System (BMS)  
**System Version:** 1.0 (Production Candidate)  
**Verification Scope:** End-to-End System Workflows, Functional Requirements (FR-1 to FR-8), Non-Functional Requirements (NFR-1 to NFR-5), and Security Requirements  
**Repository:** [Balreddy07/Bank-Management-System-](https://github.com/Balreddy07/Bank-Management-System-)  
**Date:** November 19, 2026  
**QA Lead:** Aditi Hubli (`PES1UG24CS652`)  
**Architecture & Lead:** Balreddy (`PES1UG24CS658`)  
**Security & Scalability:** B Koushikraj  

---

## 1. Executive Summary

This report documents the final end-to-end system validation of the Bank Management System. All system-level test cases derived from the Software Requirements Specification (SRS) and Software Test Plan (STP) were executed against an integrated full-stack environment comprising the React 19 single-page application, Express.js 5 API layer, and MySQL 8 relational persistence engine.

**Overall Result: 100% of System Validation Cases PASSED (38 out of 38 ST cases).**

```text
========================================================================================
SYSTEM VALIDATION METRIC SUMMARY
========================================================================================
Total System Test Cases Planned:        38
Total Automated API / Flow Tests Run:   34
Total Manual / Performance Scenarios:    4
Total Test Cases Passed:                38 (100.0%)
Total Critical Defects Open:             0 (Zero Open Blocker / Critical Defects)
Exit Criteria Satisfied:                YES
========================================================================================
```

---

## 2. System Requirements Validation Matrix

### 2.1 Functional Requirements (FR) Validation

| Req ID | Requirement Description | Verification Method | Associated System Test | Result |
| :---: | :--- | :--- | :--- | :---: |
| **FR-1** | Customer KYC onboarding and account opening with $\ge ₹500$ deposit. | Automated API test driving `/api/accounts` with payload validation. | `ST-FR01-ACC-OPEN` | **PASS** |
| **FR-2** | Automated generation of unique 10-digit account number. | Batch creation of 100 accounts checking length, format, and uniqueness. | `ST-FR02-ACC-NUM` | **PASS** |
| **FR-3** | Customer account view, detail editing, and status deactivation. | Authenticated staff workflow updating contact info and deactivating account. | `ST-FR03-ACC-MGMT` | **PASS** |
| **FR-4** | Cash withdrawal with ₹1,000 minimum balance enforcement. | Automated transactions testing withdrawal boundary limits and rejections. | `ST-FR04-WITHDRAW` | **PASS** |
| **FR-5** | Unique transaction reference and downloadable receipt retrieval. | Post-transaction receipt generation and retrieval via `/api/transactions/:ref`. | `ST-FR05-RECEIPT` | **PASS** |
| **FR-6** | 15-minute account lockout after 3 consecutive failed login attempts. | Automated simulation of 3 wrong passwords followed by lockout assertion. | `ST-FR06-LOCKOUT` | **PASS** |
| **FR-7** | Transaction logging with timestamp, type, amount, and post-balance. | Ledger persistence verification and pagination check on `/api/transactions`. | `ST-FR07-HISTORY` | **PASS** |
| **FR-8** | Admin date-range financial reporting generated within 10 seconds. | Aggregated reporting endpoint benchmark over 10,000 transaction rows. | `ST-FR08-REPORTS` | **PASS** |

---

### 2.2 Non-Functional Requirements (NFR) Validation

| Req ID | Category | Requirement SLA Target | Observed Measurement / Evidence | Result |
| :---: | :--- | :--- | :--- | :---: |
| **NFR-1** | Performance | 95% of transactions $\le 2,000\text{ ms}$ under 500 concurrent virtual users. | **p95 Latency: 84 ms** (Max: 215 ms) with 0% errors via `concurrent-load-runner.js`. | **PASS** |
| **NFR-2** | Scalability | 1,000 concurrent authenticated sessions with response time $\le 4,000\text{ ms}$. | Simulated 1,000 sessions with MySQL session store; **p95 Latency: 112 ms**. | **PASS** |
| **NFR-3** | Security | Cryptographic storage of credentials; protection of session tokens. | Passwords hashed using bcrypt (cost 10); cookies `HttpOnly`, `SameSite=Lax`. | **PASS** |
| **NFR-4** | Data Integrity | Rejection of negative balances, duplicate accounts, and partial mutations. | Enforced by MySQL `CHECK(balance >= 0)`, unique indexes, and ACID transactions. | **PASS** |
| **NFR-5** | Availability & Ops | Automated backup dump with SHA-256 verification and safe restore. | Verified via `server/src/scripts/backup-recovery.js` and `backup-recovery.test.js`. | **PASS** |

---

## 3. End-to-End Workflow Verification

### Workflow 1: Customer Onboarding to Cash Withdrawal
1. **Step 1 (Staff Login):** Bank staff authenticates via `/api/auth/login`. Response returns HTTP 200 with session cookie.
2. **Step 2 (Account Opening):** Staff posts customer KYC details (Name: `"Rahul Sharma"`, Phone: `"9876543210"`, Initial Deposit: `₹5,000.00`). System verifies deposit $\ge ₹500$, creates customer record, generates 10-digit account `7811288401`, sets balance `₹5,000.00`, and creates transaction record.
3. **Step 3 (Cash Withdrawal):** Staff submits withdrawal request of `₹3,500.00` on behalf of the customer.
   - Initial Balance: `₹5,000.00`
   - Requested Withdrawal: `₹3,500.00`
   - Projected Balance: `₹1,500.00` ($\ge ₹1,000.00$ minimum balance requirement).
   - Backend commits transaction, returns HTTP 201 with receipt reference `TX-781128-001`.
4. **Step 4 (Excessive Withdrawal Rejection):** Customer attempts immediate withdrawal of `₹800.00` (which would leave `₹700.00`, violating ₹1,000 limit).
   - System catches boundary violation, rejects mutation with HTTP 400 `"Insufficient balance. Minimum balance of ₹1,000 required."`
   - Balance remains untouched at `₹1,500.00`.
5. **Step 5 (Receipt Verification):** Fetching `/api/transactions/TX-781128-001` returns the exact transaction receipt.
*Status: Verified PASS.*

---

### Workflow 2: Transaction Idempotency & Concurrency Stress
1. **Scenario:** Network instability causes client browser to submit the same withdrawal twice in rapid succession.
2. **Execution:** Both requests carry header `Idempotency-Key: 8b0728c6-2c93-4e44-b26a-b2866992d9fa`.
3. **Observation:** 
   - First request acquires row lock, executes debit of `₹500.00`, saves idempotency cache, and commits.
   - Second request detects duplicate key in `transaction_idempotency` table, skips SQL debit, and directly returns the cached receipt with identical balance.
   - Account is debited exactly once.
*Status: Verified PASS.*

---

### Workflow 3: Brute-Force Authentication Defense & Audit Recording
1. **Scenario:** An attacker submits 3 incorrect passwords for username `teller_user`.
2. **Observations:**
   - Attempt 1 & 2: HTTP 401 `"Invalid username or password"`. Failed attempts counter increments.
   - Attempt 3: Account locked. `locked_until` set to `NOW() + 15 minutes`.
   - Attempt 4 (even with correct password): HTTP 423 Locked `"Account is locked due to multiple failed login attempts. Try again in 15 minutes."`
   - Audit trail in `security_audit_logs` records 3 `LOGIN_FAILURE` events and 1 `ACCOUNT_LOCKOUT` event with timestamp and IP address.
*Status: Verified PASS.*

---

## 4. System Validation Sign-Off

The Bank Management System v1.0 has met all functional and non-functional acceptance criteria specified in the SRS. The system exhibits high resilience under concurrent load, enforces strict financial constraints, and maintains comprehensive audit traceability.

**Approval:**  
*Aditi Hubli (QA Lead)* — Signed: November 19, 2026  
*Balreddy (Project Lead / Architect)* — Signed: November 19, 2026  

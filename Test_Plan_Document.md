# Software Test Plan (STP)
## Project: Bank Management System (BMS)
**Version:** 1.0  
**Authors:** Aditi Hubli (`PES1UG24CS652`), Balreddy (`PES1UG24CS658`), B Koushikraj  
**Date:** 19-11-2026  
**Status:** Approved / Model Answer  

---

## 1. Introduction

### 1.1 Purpose
This document defines the master software test plan for the **Bank Management System (BMS)** v1.0. It outlines the testing objectives, scope, test strategy, resource allocation, schedule, deliverables, and pass/fail criteria governing quality assurance.

### 1.2 Scope
Testing encompasses functional verification of user authentication, customer KYC onboarding, account management, atomic deposits and cash withdrawals with minimum retained balance enforcement, transaction receipts, idempotency filtering, admin date-range reporting, and security audit event persistence.  
*Exclusions:* Core banking inter-bank settlement switches and third-party payment gateways.

### 1.3 References
- Bank Management System SRS v1.0 (`SRS_Document.md`)
- System Architecture Document (`docs/architecture.md`)
- Banking Industry Security Guidelines & Reserve Bank Compliance Standards

### 1.4 Definitions and Acronyms
- **STP:** Software Test Plan
- **RTM:** Requirements Traceability Matrix
- **VU:** Virtual User
- **SLA:** Service Level Agreement
- **Idempotency:** Property of an operation that can be applied multiple times without changing the result beyond the initial application.

---

## 2. Test Items

1. **Authentication Module:** Login, session verification, bcrypt password comparison, 3-attempt brute-force lockout, logout.
2. **Customer & Account Management:** KYC validation, 10-digit account generation, ₹500 initial deposit check, search & filter.
3. **Transaction Processing:** Cash deposits, cash withdrawals with ₹1,000 minimum balance enforcement, negative balance prevention.
4. **Idempotency & Concurrency:** `Idempotency-Key` header caching, row-level locking (`SELECT ... FOR UPDATE`).
5. **Administration & Reporting:** Staff role management, protection of sole active admin, date-range financial summaries.
6. **Security Audit Logger:** Logging of security-critical state transitions into `security_audit_logs`.
7. **Disaster Recovery:** Automated MySQL dump creation, SHA-256 verification, and safe restoration.

---

## 3. Features to be Tested

Mapped directly to SRS requirement IDs:
- **BMS-F-001 / BMS-F-002 / BMS-F-003:** Authentication, password hashing, and brute-force lockout.
- **BMS-F-004 / BMS-F-005 / BMS-F-006:** KYC onboarding, unique 10-digit account numbering, ₹500 minimum initial deposit.
- **BMS-F-007 / BMS-F-008:** Account search/filtering and lifecycle transitions (`ACTIVE` vs `INACTIVE`).
- **BMS-F-009 / BMS-F-010 / BMS-F-011:** Deposits, withdrawals with ₹1,000 minimum balance, and overdraft rejection.
- **BMS-F-012 / BMS-F-013 / BMS-F-014:** Transaction references, receipts, and idempotency key caching.
- **BMS-F-015 / BMS-F-016:** Security audit logging and administrative date-range reports.
- **BMS-NF-001 / BMS-NF-002:** 500 concurrent virtual users performance ($< 2\text{ s}$) and 1,000 session capacity ($< 4\text{ s}$).
- **BMS-NF-003 / BMS-NF-004:** ACID transaction rollback and 7-year audit retention.

---

## 4. Features Not to be Tested

- External physical ATM hardware devices (cash dispenser rollers, card readers).
- Third-party SMS/Email gateway provider infrastructure (mocked locally).
- Third-party clearinghouse payment interchange networks.

---

## 5. Test Approach / Strategy

Testing is conducted across multiple levels:
- **Unit Testing:** Individual route controllers, validation helpers, and utility scripts tested in isolation.
- **Integration Testing:** Verification of Express route handlers communicating with MySQL connection pools.
- **System Testing:** End-to-end customer and staff banking flows executed over HTTP APIs.
- **Performance & Load Testing:** Simulated 500 concurrent virtual users and 1,000 active sessions.
- **Security Validation:**
  - Password handling: bcrypt with work factor 10, zero plaintext in logs.
  - Session security: `HttpOnly`, `SameSite=Lax` cookies.
  - Rate limiting: max 20 login attempts per IP per 15 minutes.
  - SQL injection prevention via parameterized queries.

### Entry & Exit Criteria
- **Entry Criteria:** Clean git build, database migrations applied successfully, test database online.
- **Exit Criteria:** 100% of planned test cases executed; 0 critical or blocker defects open; all SRS functional requirements verified with PASS in RTM.

---

## 6. Test Environment

| Component | Specification |
| :--- | :--- |
| **Server Hardware** | Intel Core i7 / AMD Ryzen, 16GB RAM, SSD Storage |
| **Operating System** | Windows 11 / Ubuntu Linux LTS |
| **Backend Runtime** | Node.js v22.19.0 LTS |
| **Backend Framework**| Express.js 5.x |
| **Database** | MySQL Server 8.0.16 (InnoDB engine, utf8mb4) |
| **Test Runner** | Node.js native test runner (`node:test`, `node:assert`) |
| **Client Engine** | React 19, Vite, Oxlint, Modern Web Browsers |

---

## 7. Test Schedule & Milestones

| Milestone | Target Window | Deliverables | Status |
| :--- | :---: | :--- | :---: |
| **M1: Test Plan & Setup** | Oct 12 – Oct 14, 2026 | Test Plan document, mock database harness | **Completed** |
| **M2: Core Unit & Auth Tests** | Oct 15 – Oct 23, 2026 | Authentication, account opening, deposit/withdrawal suites | **Completed** |
| **M3: Concurrency & Migrations**| Oct 24 – Oct 28, 2026 | Idempotency tests, race condition validation, migration tests | **Completed** |
| **M4: Performance & Scalability**| Oct 29 – Oct 30, 2026 | 500 VU load test, 1,000 session capacity benchmarks | **Completed** |
| **M5: Final QA Sign-Off & Reports**| Oct 31 – Nov 02, 2026 | Unit test report, system validation report, coverage reports | **Completed** |

---

## 8. Test Deliverables

1. Master Test Plan Document (`Test_Plan_Document.md`)
2. Unit Test Report (`docs/unit-test-report.md`)
3. System Validation Report (`docs/system-validation-report.md`)
4. Code Coverage Report (`docs/code-coverage-report.md`)
5. Branch Coverage Report (`docs/branch-coverage-report.md`)
6. Requirements Traceability Matrix (`docs/requirements-traceability.md`)

---

## 9. Roles and Responsibilities

| Role | Name | Responsibilities |
| :--- | :--- | :--- |
| **QA Lead** | Aditi Hubli (`PES1UG24CS652`) | Authored test plan, automated regression suites, backup-recovery tests, test reports. |
| **Security & Scalability** | B Koushikraj | Designed 500 VU load tests, session capacity benchmarks, automated security suites. |
| **Lead Developer & Architect**| Balreddy (`PES1UG24CS658`) | Implemented core banking logic, transactional rollbacks, idempotency locks, defect triage. |
| **Product Owner** | Course Coordinator / Evaluator | Reviewed acceptance criteria, verified system compliance, approved release readiness. |

---

## 10. Risks and Mitigation

| Risk | Impact | Mitigation Strategy |
| :--- | :---: | :--- |
| Race conditions during concurrent withdrawals causing negative balances. | High | Enforced MySQL `SELECT ... FOR UPDATE` row locks inside atomic SQL transactions. |
| Network timeout during deposit causing customer re-debit. | High | Implemented mandatory idempotency key caching in `transaction_idempotency` table. |
| Test database dirty state affecting test reproducibility. | Medium | Automated test suites utilize isolated test accounts and rollback hooks. |

---

## 11. Assumptions and Dependencies

- MySQL 8.0 server supports transaction row-level locking and atomic commit/rollback.
- Network latency during local development testing is negligible ($< 5\text{ ms}$).
- Test credentials used for automated load benchmarks are disposable and isolated.

---

## 12. Suspension and Resumption Criteria

- **Suspension Criteria:** Database connection loss, schema corruption, or failure of more than 20% of smoke tests.
- **Resumption Criteria:** Successful application of database migrations via `npm run migrate` and passing smoke verification.

---

## 13. Test Case Management & Traceability

All 16 functional requirements and 5 non-functional requirements are explicitly mapped to executable test cases in `server/test/`:
- `BMS-F-001` $\rightarrow$ `TC-Auth-01` (`security.test.js`)
- `BMS-F-006` $\rightarrow$ `TC-Acc-02` (`transactions.test.js`)
- `BMS-F-010` $\rightarrow$ `TC-WD-01` (`transactions.test.js`)
- `BMS-F-014` $\rightarrow$ `TC-Tx-03` (`transactions-concurrency.test.js`)
- `BMS-NF-001` $\rightarrow$ `TC-Perf-01` (`transaction-performance.test.js`)

---

## 14. Test Metrics & Reporting

- **Total Test Cases Executed:** 120
- **Total Test Cases Passed:** 120
- **Pass Rate:** **100.0%**
- **Statement Coverage:** 49.47% (overall), 100% on critical scripts (`backup-recovery.js`, `metrics.js`)
- **Branch Coverage:** 69.51% (overall), 88.40% on financial domain rules
- **Defects Identified and Resolved:** 3 (all fixed and verified)

---

## 15. Approvals

| Role | Name | Signature / Approval | Date |
| :--- | :--- | :--- | :---: |
| **QA Lead** | Aditi Hubli | Approved (Signed) | 19-11-2026 |
| **Dev Lead & Architect** | Balreddy | Approved (Signed) | 19-11-2026 |
| **Security Engineer** | B Koushikraj | Approved (Signed) | 19-11-2026 |

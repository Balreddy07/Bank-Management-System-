# Backlog 26 Security Testing Report

**Date:** 2026-10-30
**Project:** Bank Management System
**Stories:** #82 — Password Storage Security; #83 — Common Application Attacks
**Environment:** Windows, Node.js 24.11.0, backend `node:test` suite
**Data safety:** All new endpoint tests use synthetic users, an in-memory session store, and a mocked database pool. No production, shared, or configured MySQL database was accessed.

## Scope and approach

The review covered authentication routes, staff/customer credential creation, bcrypt verification, session middleware and MySQL session-store behavior, account search and lookup, role and customer-ownership enforcement, error handling, audit events, and the session-capacity load runner's target URL validation.

The automated HTTP tests execute the real Express app and routes, but replace persistence with an isolated fake. SQL behavior was checked by capturing the statements and bound parameters; database integration and deployment infrastructure were not exercised.

## Results

| Area | Result | Evidence |
|---|---|---|
| Password hashing and persistence | **PASS** | Staff and customer credential creation persist bcrypt hashes with cost 12; plaintext is not persisted. |
| Password verification | **PASS** | Correct credentials log in; incorrect and missing credentials fail with the same generic response. Verification uses bcrypt comparison. |
| Sensitive data exposure | **PASS** | Tested create/login/list/error responses and audit events do not expose passwords or hashes. Simulated SQL details and database credentials are absent from API errors and captured logs. |
| SQL injection | **PASS** | Login injection text is rejected; account search and lookup use bound parameters and do not return unauthorized records. |
| Authentication | **PASS** | Unauthenticated protected requests and unknown sessions are rejected; logout invalidates the session. |
| Authorization and ownership | **PASS** | A regular staff user cannot access administrator endpoints. A customer cannot view or modify another customer's account. Ownership is derived from the authenticated session. |
| Session cookies and fixation | **PASS / REVIEWED** | Tests verify HttpOnly, SameSite, expiration, session ID rotation, and the Secure attribute when secure-cookie mode receives a trusted HTTPS-proxy signal. The production reverse proxy was not exercised. |
| Session expiration | **REVIEWED** | The application configures a 30-minute rolling idle timeout and the MySQL session store filters and cleans up expired sessions. Expiration against a live MySQL store was not exercised. |
| Remote load-test transport | **PASS — remediated** | Remote test/staging targets now require HTTPS; loopback HTTP remains available for local development. Regression tests cover both cases. |

## Findings and remediation

### Medium — credentials could be sent to a remote HTTP load-test target

**Evidence:** The session-capacity runner accepted remote HTTP URLs while sending a configured password to the login endpoint and receiving session cookies.

**Remediation:** Remote targets now require HTTPS. The runner continues to allow HTTP only for loopback hosts. Automated configuration tests reject remote HTTP and accept remote HTTPS with the existing explicit test/staging opt-in.

No other confirmed vulnerabilities were found in the reviewed scope. This is a scoped assessment, not a penetration test or a guarantee of application security.

## Test execution

- Focused security and session-runner suites: **15 passed, 0 failed**.
- Complete backend suite (`npm test`): **120 passed, 0 failed**.
- Frontend tests: no test script is configured in `client/package.json`.
- Frontend lint (`npm run lint`): completed with no errors and two existing `react(set-state-in-effect)` warnings in `client/src/App.jsx`.
- JavaScript syntax checks and `git diff --check`: passed.

## Limitations and manual verification

- The fake database verifies route behavior and bound query values, but does not replace review or testing against a disposable MySQL instance. This task intentionally did not connect to any database.
- Secure-cookie behavior is tested with a simulated trusted HTTPS-proxy signal and configured for production; the integration test does not use the actual deployment proxy. Confirm the Secure cookie attribute through the intended HTTPS reverse proxy before release.
- MySQL-backed session expiration and cleanup were reviewed but not integration-tested. Verify timeout and invalidation behavior in the staging deployment.
- The tests cover the application's session authentication model; no bearer-token authentication is configured.

## Acceptance status

- **#82 Password Storage Security:** PASS for inspected credential-creation and login flows.
- **#83 Common Application Attacks:** PASS for the tested SQL injection, authentication, role, ownership, session invalidation, and information-disclosure scenarios.
- **Manual staging checks:** HTTPS Secure-cookie behavior and MySQL-backed session expiration remain to be verified before deployment.

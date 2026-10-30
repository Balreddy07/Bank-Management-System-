# Backlog 22 – Account Lifecycle Rules

## Implementation
- Defined clear operational rules and lifecycle states for bank accounts (`ACTIVE` and `INACTIVE`).
- Enforced transaction restrictions on inactive accounts:
  - Prohibited financial deposit (`POST /api/transactions/deposit`) and withdrawal (`POST /api/transactions/withdraw`) operations for inactive accounts with explicit HTTP 409 rejection.
  - Preserved historical transaction records and receipts accessible via `GET /api/transactions` and `GET /api/transactions/:transactionRef`.
- Implemented robust, validated account status transition controls:
  - Validated current account status before allowing state transitions (rejects repeat deactivation of inactive accounts with 409, and repeat activation of active accounts with 409).
  - Enforced transition validation through dedicated routes (`/activate`, `/deactivate`) and general status transition endpoint (`/status`).
  - Required explicit employee authorization (`ADMIN` and `STAFF`) and confirmation (`confirm: true`), blocking unauthorized customer users with HTTP 403 and unauthenticated requests with HTTP 401.
  - Recorded security audit log events for all lifecycle transitions (`ACCOUNT_DEACTIVATION_SUCCESS`, `ACCOUNT_DEACTIVATION_FAILURE`, `ACCOUNT_ACTIVATION_SUCCESS`, `ACCOUNT_ACTIVATION_FAILURE`, and `AUTHORIZATION_DENIED`).
- Updated frontend UI:
  - Added "Activate" button for inactive accounts in the accounts table to allow authorized bank staff to reactivate accounts with confirmation.
  - Added inactive account notice and disabled transaction submission in the transaction activity view.

## Files Updated
- client/src/App.jsx
- client/src/App.css
- server/src/audit-logger.js
- server/src/routes/accounts.js
- server/src/routes/admin.js
- server/test/transactions.test.js
- docs/backlog-22-account-lifecycle-rules.md

## Testing
- Full backend automated test suite: 123 tests passed, 0 failed.
- Status transition validation and error rejection tested.
- Inactive transaction restrictions and historical record preservation verified.
- Role-based authorization and audit log recording verified.
- Git diff whitespace validation passed (`git diff --check`).

## Related Issues
Closes #69
Closes #70
Closes #71

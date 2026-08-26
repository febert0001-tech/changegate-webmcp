# Security model (planned; not implemented)

## Human-control boundary

The agent can observe, diagnose, and propose. The visible UI is the sole human-approval surface. Approval will bind a human decision to one immutable proposal ID, target service, exact action, parameters, preconditions, and expiry. The agent cannot approve, broaden, renew, or self-authorize a proposal.

**There must never be a WebMCP `approve_change` tool or equivalent. Human approval must occur through the visible UI and be scoped to one exact proposed change.**

## Future state machine

`observed -> diagnosed -> proposed -> pending_human_approval -> approved | rejected | expired -> executing -> verified | failed -> rollback_pending_approval -> rolled_back | rollback_failed`

Only the visible UI may transition `pending_human_approval` to `approved` or `rejected`. Execution must consume one exact approval and reject stale, mismatched, duplicated, or expired approvals.

## Authorization and rollback rules

- Read-only operations return bounded synthetic data.
- Consequential execution requires a valid UI approval matching the immutable proposal.
- A proposal is single-use; an executed change cannot be re-executed from the same approval.
- Rollback is a separate consequential action and requires its own visible approval.
- The simulator will never receive credentials for or make changes to real systems.

## Audit and integrity

Future audit events will capture actor class (agent or human), proposal identity, state transition, result, and verification outcome. Approval and execution must be distinguishable. Scenario reset must not silently make an old approval valid.

Knowledge content and tool outputs will be treated as untrusted inputs; they cannot override schemas, authorization checks, UI confirmation, or the synthetic-environment boundary.

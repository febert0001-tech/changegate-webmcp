# Security model (Gate 2 boundary)

## Human-control boundary

The agent can observe, propose the single supported synthetic change, and request visible review for its exact proposal ID. The visible UI remains the sole human-approval surface. The Gate 1.1 domain model binds a human decision to one deeply immutable proposal ID, target service, exact action, parameters, and preconditions. The agent cannot approve, broaden, renew, or self-authorize a proposal.

**There must never be a WebMCP `approve_change` tool or equivalent. Human approval must occur through the visible UI and be scoped to one exact proposed change.**

## State machine boundary

Environment observation and diagnosis are events, not transaction states. The detailed lifecycle and forbidden transitions are in [state-machine.md](state-machine.md).

Only the visible UI may transition `AWAITING_HUMAN_APPROVAL` to `APPROVED` or `REJECTED`. Execution must consume one exact approval and reject stale, mismatched, duplicated, or expired approvals.

## Authorization and rollback rules

- Read-only operations return bounded synthetic data.
- Consequential execution requires a valid UI approval matching the immutable proposal.
- A proposal is single-use; an executed change cannot be re-executed from the same approval.
- Rollback is a separate consequential action and requires its own visible approval.
- The simulator will never receive credentials for or make changes to real systems.

## Audit and integrity

Audit events use deterministic sequence numbers and distinguish HUMAN, AGENT, and SYSTEM actors. Gate 2 WebMCP commands create only AGENT events. Approval and execution remain distinguishable. Scenario reset cannot silently make an old approval valid.

Knowledge content and tool outputs will be treated as untrusted inputs; they cannot override schemas, authorization checks, UI confirmation, or the synthetic-environment boundary.

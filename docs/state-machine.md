# Change lifecycle state machine

Environment health and change lifecycle are separate models. Inspection and diagnosis are audit/domain events, not lifecycle states.

## Lifecycle

`PROPOSED -> AWAITING_HUMAN_APPROVAL -> APPROVED -> EXECUTING -> VERIFYING -> SUCCEEDED`

From `AWAITING_HUMAN_APPROVAL`, a proposal may become `REJECTED` or `EXPIRED`. `EXECUTING` may become `VERIFYING` on simulated success or `FAILED` on execution failure; no separate execution-failed state exists. `VERIFYING` may become `FAILED`; a failed change may enter `ROLLBACK_AWAITING_APPROVAL -> ROLLING_BACK -> ROLLED_BACK | ROLLBACK_FAILED`.

## Legal transition rules

- Only a visible Human UI decision may move `AWAITING_HUMAN_APPROVAL` to `APPROVED` or `REJECTED`.
- `PROPOSED -> AWAITING_HUMAN_APPROVAL` requires an exact, case-sensitive match between the requested proposal ID and the current trusted proposal ID.
- Execution must independently revalidate the exact immutable proposal and one active human approval before `EXECUTING`.
- `VERIFYING` must not become `SUCCEEDED` without independent verification.
- Rollback needs a new, separately scoped human approval.
- Failure and rollback states structurally retain the original snapshot captured at `BEGIN_EXECUTION`.
- `RESET_SCENARIO` is allowed from all states except active `EXECUTING`, `VERIFYING`, and `ROLLING_BACK`.

## Forbidden transitions

- No agent or WebMCP call may create `APPROVED`.
- `PROPOSED` cannot execute directly.
- A consumed, rejected, expired, invalidated, mismatched, or altered approval cannot execute.
- A failed verification cannot be relabeled as success.
- Reset cannot retain a prior approval or authorization, and rollback cannot capture a replacement baseline.

Gate 2 exposes only proposal creation and exact-ID human-review requests through WebMCP. The pure deterministic reducer remains the sole transition authority and still has no execution side effects.

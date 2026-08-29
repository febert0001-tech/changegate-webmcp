# Change lifecycle state machine (Gate 4)

Environment health and change lifecycle remain separate models. Inspection and diagnosis are audit/domain events, not lifecycle states.

## Flagship refund lifecycle

```text
PROPOSED
   ↓
AWAITING_HUMAN_APPROVAL
   ↓
APPROVED
   ↓
EXECUTING
   ↓
VERIFYING
   ↓
SUCCEEDED
```

Alternative terminal branches:

- `AWAITING_HUMAN_APPROVAL -> REJECTED`
- `AWAITING_HUMAN_APPROVAL -> EXPIRED` where applicable
- `EXECUTING -> FAILED` on execution failure
- `VERIFYING -> FAILED` on verification failure or mismatch

Visible **VERIFIED** is a projection of the trusted successful verification result associated with terminal `SUCCEEDED`.

## Legal transition rules

- `PROPOSED -> AWAITING_HUMAN_APPROVAL` requires an exact, case-sensitive match between the requested proposal ID and the current trusted proposal ID.
- Only visible human UI decisions may move `AWAITING_HUMAN_APPROVAL` to `APPROVED` or `REJECTED`.
- Human approval is bound to the exact proposal ID, proposal digest, and current trusted review-instance identity.
- Approval alone cannot transition to execution as a side effect of the approval click.
- `APPROVED -> EXECUTING` requires a separate human Execute decision carrying only the expected trusted lifecycle identity captured from rendered state.
- Execution revalidates the exact active approval and internally derives the authorized effect.
- Once admitted to execution, the approval is consumed before asynchronous writer work proceeds.
- `EXECUTING -> VERIFYING` means the constrained synthetic writer completed; it does **not** mean the change is successful.
- `VERIFYING -> SUCCEEDED` requires trusted independent readback evidence that exactly matches the authorized effect.
- `VERIFYING -> FAILED` occurs on mismatch or verification failure.

## Forbidden transitions

- No agent or WebMCP call may create `APPROVED`.
- No agent or WebMCP call may create `EXECUTING`, `VERIFYING`, `SUCCEEDED`, or **VERIFIED**.
- `PROPOSED` cannot execute directly.
- `AWAITING_HUMAN_APPROVAL` cannot execute.
- An approval from a stale review lifecycle cannot execute a later proposal.
- A consumed, rejected, expired, invalidated, mismatched, or altered approval cannot execute.
- Post-approval substitution of target, action, amount, currency, or execution identity is not accepted.
- Executor success cannot bypass `VERIFYING`.
- A failed independent readback cannot be relabeled as success.
- Hand-made or cloned verification evidence cannot complete the active execution.

## Review-instance monotonicity

Each accepted review request receives trusted lifecycle identity. The review counter remains monotonic across reset/reproposal cycles so a byte-identical proposal does not recreate old approval authority.

The counter fails closed before safe-integer exhaustion could permit identity reuse.

## Refund execution binding

The authorized synthetic refund binding is created from trusted approved state and contains internally derived execution identity plus the exact effect:

- operation: `SYNTHETIC_PARTIAL_REFUND`
- order: `4821`
- currency: `USD`
- authorized amount: the exact approved integer-cent value

Caller-supplied replacement business fields are not part of the human Execute contract.

## Failure semantics

A verification failure means the system refuses to claim the intended effect was independently proven. It does not silently reinterpret or overwrite observed evidence.

For the test mismatch scenario, authorization expects `$25.00` while the independent reader observes `$20.00`; the lifecycle ends at `FAILED`, not `SUCCEEDED`.

## Audit sequence

The normal successful refund demonstration produces a visible audit sequence covering:

1. agent proposal;
2. agent review request;
3. human approval;
4. execution begin;
5. execution completion / transition to verification; and
6. trusted verification completion.

This separation keeps agent action, human authorization, execution, and verification distinguishable in the record.

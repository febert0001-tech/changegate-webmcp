# Security model (Gate 4)

## Security objective

ChangeGate is designed around one invariant:

> **Execute exactly what the human authorized, then independently prove what actually happened.**

The system deliberately separates agent capability, human authorization, human execution, and verification truth.

## Agent boundary

The agent can observe bounded synthetic state, propose a supported change, and request visible human review. It cannot:

- approve or reject a proposal;
- create or choose human approval identity;
- execute a consequential action;
- supply post-approval replacement business fields;
- mark execution as verified; or
- manufacture trusted verification evidence.

There is intentionally no WebMCP `approve_change`, `execute_change`, `verify_change`, or semantic equivalent.

## Proposal integrity

A proposal is recursively validated/copied and bound to a deterministic digest. External callers do not supply the authoritative digest.

For the flagship refund variant, runtime validation constrains the request to the supported synthetic target/action/currency/range and exact precondition.

Material proposal changes produce different trusted identity and cannot reuse a prior human decision.

## Human approval boundary

A review lifecycle receives an internal monotonic `reviewInstanceId`. Successful human approval binds the exact proposal ID, proposal digest, review-instance ID, and internally derived approval identity.

The React approval control passes no authority fields supplied by the caller.

Stale decisions, wrong proposal IDs, wrong digests, wrong review instances, repeated decisions, and cross-proposal replay are denied.

The review counter fails closed at the JavaScript safe-integer boundary rather than risking identity reuse.

## Separate human execution boundary

Approval alone never executes.

The visible webpage exposes a second human action to execute the exact approved refund. The application Execute API receives only expected lifecycle identity captured from trusted rendered state.

It does **not** accept fresh:

- amount;
- target/order ID;
- currency;
- action;
- policy fields;
- execution ID; or
- verification result.

Trusted application/domain code derives the authorized execution binding internally.

This prevents post-approval substitution such as approving `$25` but attempting to execute `$75` or `$20`.

## Approval consumption and replay resistance

Preflight checks occur before side effects. If preflight fails, execution is denied without consuming the approval.

Once execution begins, the approval is consumed before the writer path proceeds. The same approval cannot be used for a second synthetic side effect.

Execution identity is derived internally from trusted lifecycle material rather than chosen by a caller.

## Synthetic ledger boundary

The refund effect is written to private in-memory ledger state keyed by trusted execution identity.

The ledger is synthetic. No real payment provider, financial account, infrastructure credential, or external production system is connected.

## Independent verification

Executor success is not verification truth.

A separately composed reader reads the actual synthetic ledger after execution. The verifier compares that observed evidence with the exact authorized execution binding.

Trusted verification evidence is accepted only for the exact active execution object/binding. Hand-made or cloned evidence is rejected.

- exact match → `SUCCEEDED` / **VERIFIED**;
- mismatch/read failure → `FAILED`;
- executor success without independent match → never sufficient for success.

A test-only faulty reader proves expected `$25` / observed `$20` reaches failure rather than being relabeled as verified.

## WebMCP cancellation compatibility

Invocation cancellation is lifecycle control, never authority.

Chrome 151 testing showed that some native callback paths may omit a usable invocation context. The accepted compatibility patch treats a missing cancellation signal as “not cancelled,” while an actual aborted signal still produces `CANCELLED`.

The patch does not expand schemas, authority, business payloads, human decisions, execution capability, or verification trust.

## Audit integrity

Audit events distinguish `AGENT`, `HUMAN`, and `SYSTEM` actors and preserve the visible sequence of proposal, review request, human decision, execution, and verification.

The successful refund demo produces a six-event audit chain through terminal verification.

## Fail-closed examples

- `$75` refund above the `$30` policy maximum → rejected before approval/execution.
- Approved `$25`, attempted `$75` execution → denied.
- Approved `$25`, attempted `$20` execution → denied.
- stale lifecycle identity → denied.
- duplicate execution → denied/contained.
- forged verification evidence → rejected.
- independent readback mismatch → `FAILED`, never `VERIFIED`.

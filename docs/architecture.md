# Architecture (Gate 4)

ChangeGate is a browser-hosted, deterministic change-control simulator. The domain state machine, policy checks, and trusted application composition own authority. Human UI and WebMCP are separate interfaces: WebMCP is an agent collaboration adapter after strict runtime validation, not an authority source.

## Core collaboration chain

```text
Agent inspection / proposal
        ↓
Exact immutable proposal
        ↓
Visible human review
        ↓
Human approval of exact proposal
        ↓
Separate human Execute decision
        ↓
Trusted authorized execution binding
        ↓
Constrained synthetic ledger write
        ↓
Independent ledger readback
        ↓
Exact comparison
        ↓
VERIFIED or FAILED
```

The flagship Gate 4 flow uses synthetic Order #4821:

- order value: `$129.00`;
- partial-refund policy maximum: `$30.00`;
- proposed/approved refund: `$25.00`;
- ledger before: `$0.00`;
- authorized effect: `$25.00`;
- independent readback: expected `$25.00`, observed `$25.00`;
- terminal result: `SUCCEEDED` / **VERIFIED**.

## WebMCP boundary

`document.modelContext -> seven-tool catalog -> strict Zod validation -> scoped application operations -> domain reducer`

Exactly seven tools are agent-facing:

- five bounded reads;
- `propose_change`; and
- `request_change_approval`.

No WebMCP tool can approve, reject, execute, verify, or manufacture human authority.

Registered callbacks query a current application operations instance rather than relying on stale React snapshots. Registration lifetime and per-invocation cancellation remain separate. Unsupported browsers render normally without a WebMCP polyfill.

## Human authority boundary

Human review is lifecycle-bound. Trusted application/domain state retains the exact proposal ID, proposal digest, review-instance identity, and internally derived approval identity.

The visible **Approve exact proposal** action accepts no caller-supplied business payload or approval material.

Approval does not execute. After approval, the webpage presents a separate **Execute approved $25.00 refund** action.

The Execute controller receives only expected lifecycle identity captured from the rendered trusted state. It does not accept fresh:

- refund amount;
- order ID;
- currency;
- action;
- policy fields;
- execution ID; or
- verification result.

The actual authorized execution binding is derived internally from trusted approved state.

## Execution boundary

The refund side effect is intentionally synthetic and narrow.

A private in-memory ledger stores effects keyed by trusted execution identity. The approval is consumed before the asynchronous writer path proceeds, preventing replay/duplicate execution from reusing the same human decision.

Preflight denial occurs before side effects and leaves the approval unconsumed.

## Independent verification boundary

Executor success is diagnostic, not proof.

A separate reader interface reads the synthetic ledger after execution. A verifier captures that trusted reader at the application composition boundary and compares observed ledger evidence with the exact authorized effect.

Only trusted verification evidence for the exact active execution binding can transition:

- `VERIFYING -> SUCCEEDED` on exact match; or
- `VERIFYING -> FAILED` on mismatch/failure.

A test-only faulty reader is used to prove that an observed `$20` result cannot be relabeled as success when `$25` was authorized.

## Deterministic authority identities

Review instances are monotonic and fail closed at the JavaScript safe-integer boundary. Reset/reproposal cannot recreate a previously valid approval lifecycle.

Execution identity is derived internally from trusted lifecycle material; callers do not choose it.

## Synthetic environment boundary

ChangeGate contains no real payment integration, infrastructure credentials, external production database, or real consequential side effect. The ledger and Order #4821 are demonstration data.

## Deployment boundary

The accepted Gate 4 app is deployed on Vercel:

https://changegate-webmcp.vercel.app

Production was visually verified and passed a native WebMCP `get_audit_trail` smoke test with exactly seven tools registered.

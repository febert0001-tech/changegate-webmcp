# ChangeGate specification (Gate 4)

## Scope

ChangeGate is a deterministic, synthetic change-control simulator built for the 2026 OpenAI WebMCP Challenge. Gate 4 completes the bounded collaboration proof:

`agent proposal -> human approval -> separate human execution -> independent verification`

The system intentionally has no real payment integration, production infrastructure connection, external persistence requirement, or real consequential side effect.

## Interfaces and authority

ChangeGate has two user-facing interfaces:

1. **WebMCP agent interface** — structured inspection, proposal, and review-request capabilities.
2. **Human UI** — visible human approval/rejection and separate human execution controls.

Neither external interface owns authority. Trusted domain/application state, immutable proposal identity, lifecycle checks, and verifier composition are authoritative.

## WebMCP capability boundary

The exact catalog is:

- `get_environment_status`
- `get_service_details`
- `get_change_policy`
- `get_change_proposal`
- `get_audit_trail`
- `propose_change`
- `request_change_approval`

Approval, rejection, execution, verification, rollback, reset, and semantic equivalents are not WebMCP capabilities.

External input begins untrusted, passes descriptor-safe JSON-data checks and strict Zod schemas, and only then reaches narrow operations. Callers cannot supply trusted actor identity, approval IDs, review-instance IDs, proposal digests, execution IDs, or verification evidence.

## Flagship refund variant

The challenge demo uses one strict synthetic refund variant:

- proposal ID: caller-chosen string satisfying schema, with the documented demo using `refund-order-4821`;
- target: `order:4821`;
- action: `SYNTHETIC_PARTIAL_REFUND`;
- currency: `USD`;
- amount: integer cents `1..3000`;
- precondition: `order:4821 refunded amount is 0 cents`.

Trusted constants include:

- order value: `12900` cents;
- maximum partial refund: `3000` cents.

The normal demo authorizes `2500` cents.

## Proposal digest authority

Trusted domain code recursively validates/copies proposal material, canonicalizes object keys, and computes a deterministic SHA-256 digest using the browser-compatible digest path.

External callers never supply the authoritative digest. Any material change to the proposal produces different trusted identity.

## Review lifecycle authority

`REQUEST_HUMAN_APPROVAL` is legal only for the exact current trusted proposal ID.

A successful review request allocates a trusted monotonic review-instance identity. Human approval binds:

- proposal ID;
- proposal digest;
- review-instance ID; and
- internally derived approval ID.

Caller-supplied human decision bindings are not accepted.

The review counter is monotonic across scenario resets and fails closed before JavaScript safe-integer exhaustion could allow reuse.

## Human execution contract

Human approval and human execution are separate decisions.

The application exposes an identity-only execute contract equivalent to:

```ts
type HumanExecuteIdentity = Readonly<{
  proposalId: string;
  proposalDigest: string;
  reviewInstanceId: string;
  approvalId: string;
}>;
```

The caller does not supply amount, order ID, currency, action, policy, execution ID, or result data at execution time.

Trusted application/domain code derives the immutable authorized refund execution binding internally from current approved state.

## Execution lifecycle

The refund path is:

`APPROVED -> EXECUTING -> VERIFYING -> SUCCEEDED`

Execution or verification failure reaches `FAILED`.

Preflight denial leaves the approval unconsumed and performs no write. Once execution is admitted, approval is consumed before asynchronous writer work so duplicate/replayed execution cannot reuse it.

The execution ID is internally derived from trusted lifecycle identity rather than caller input.

## Synthetic ledger

The synthetic refund writer appends the authorized effect to private in-memory ledger state keyed by trusted execution identity.

The ledger is intentionally small and challenge-scoped: one synthetic order and one refund effect type.

## Independent verification contract

A separate reader interface reads ledger state after execution. The verifier captures this reader at trusted composition time and compares observed evidence with the exact immutable authorized effect.

Executor success alone cannot produce `SUCCEEDED`.

- exact authorized/readback match -> `SUCCEEDED` / visible **VERIFIED**;
- mismatch/read failure -> `FAILED`;
- untrusted, cloned, or forged verification evidence -> rejected.

## Native WebMCP compatibility

Native browser testing showed Chrome 151 can invoke tool callbacks without a usable cancellation context. The accepted adapter therefore treats a missing signal as not cancelled and an actual aborted signal as cancelled. This compatibility behavior grants no additional business or execution authority.

## Deployment

Public live deployment:

https://changegate-webmcp.vercel.app

The accepted implementation checkpoint before release documentation is `869694380b9f3f2d18ff7339aa35419d962fc528`, with 335/335 tests plus typecheck, lint, build, and diff-check passing.

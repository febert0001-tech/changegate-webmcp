# Domain model (Gate 4)

## Separate state models

ChangeGate keeps several concerns structurally distinct:

- **Environment state** — deterministic synthetic service state used for inspection.
- **Change lifecycle** — proposal, review, approval, execution, verification, and terminal outcome.
- **Audit events** — append-only records distinguishing agent, human, and system actions.
- **Synthetic refund ledger** — private in-memory effect state used for the Gate 4 execution/verification proof.

## Foundation contracts

`src/domain/scenario/canonical-scenario.ts` exports immutable fixed scenario data. `src/domain/engine.ts` creates isolated runtime state and owns legal lifecycle transitions. `src/domain/change/proposal-digest.ts` canonicalizes supported proposal values and produces a browser-safe SHA-256 digest from exact proposal content.

The reducer/domain layer remains authoritative. React and WebMCP are interfaces over that authority.

## Proposal identity

A proposal is more than an ID. Trusted identity includes its material business content and deterministic digest.

Supported proposal values are recursively copied, validated, and frozen. Object keys are canonicalized for digest stability while array order remains significant.

External callers never provide the authoritative digest.

## Human approval

`HumanApproval` is not a boolean. It binds the human decision to the exact active proposal and review lifecycle, including:

- `approvalId`;
- `proposalId`;
- `proposalDigest`;
- `reviewInstanceId`;
- exact proposal semantics; and
- human-issued status.

The trusted review-instance counter remains monotonic across reset/reproposal so old approval authority cannot become valid again merely because a proposal is recreated with identical bytes.

The counter also fails closed at safe-integer exhaustion rather than allowing identity reuse.

## Refund execution identity

The Gate 4 refund path introduces an immutable authorized execution binding derived internally from trusted approved state.

Conceptually, that binding contains:

```ts
type RefundExecutionBinding = Readonly<{
  executionId: string;
  proposalId: string;
  proposalDigest: string;
  reviewInstanceId: string;
  approvalId: string;
  effect: Readonly<{
    operation: "SYNTHETIC_PARTIAL_REFUND";
    orderId: "4821";
    currency: "USD";
    amountCents: number;
  }>;
}>;
```

The execution ID and effect are derived by trusted application/domain code. They are not supplied by WebMCP or by fresh human-form fields at execution time.

## Human Execute identity

The human Execute controller accepts only the expected approval-lifecycle identity captured from trusted rendered state:

```ts
type HumanExecuteIdentity = Readonly<{
  proposalId: string;
  proposalDigest: string;
  reviewInstanceId: string;
  approvalId: string;
}>;
```

It does not accept amount, order ID, currency, action, execution ID, or result data.

## Synthetic ledger

The refund ledger is private in-memory state keyed by trusted execution identity. Writer and reader capabilities are separate interfaces over the same synthetic storage.

The writer applies the constrained authorized effect. The reader is later used by the independent verifier to observe actual resulting ledger state.

## Verification evidence

Verification truth is distinct from executor return values.

The verifier is composed with a trusted ledger reader and produces evidence bound to the exact active authorized execution. The reducer accepts trusted verification completion only for the exact active execution object/binding.

Hand-created or cloned lookalike evidence is not sufficient authority.

## Boundary rule

Data crossing WebMCP begins as `unknown`, must satisfy safe JSON-data constraints, and then passes strict Zod schemas before calling narrow operations.

The operations layer exposes purpose-built methods rather than generic dispatch/state replacement. Query methods return bounded copied projections; raw reducer state, approvals, ledger authority, writer handles, and verification-authority objects are not projected through WebMCP.

## Flagship refund constants

The challenge demo is intentionally narrow:

- order: `4821`
- order value: `12900` cents
- currency: `USD`
- policy maximum: `3000` cents
- normal proposed/approved amount: `2500` cents

This synthetic-only scope keeps the authority proof inspectable without introducing a real payment integration.

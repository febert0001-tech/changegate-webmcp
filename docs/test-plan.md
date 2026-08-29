# Test plan (Gate 4)

## Mechanical release checks

Run from the repository root:

```bash
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
```

Accepted Gate 4 implementation checkpoint:

- **335/335 tests PASS**
- typecheck PASS
- lint PASS
- production build PASS
- `git diff --check` PASS
- exact seven-tool WebMCP boundary PASS
- forbidden agent approval/execution surface check PASS

## Core authority tests

The suite proves that:

- only the visible human UI can create human approval;
- approval is bound to exact proposal ID, digest, review-instance ID, and internally derived approval identity;
- stale, wrong, repeated, cross-proposal, or replayed human decisions are denied;
- review-instance allocation remains monotonic across reset/reproposal;
- safe-integer exhaustion fails closed rather than reusing authority identity;
- human Execute accepts expected lifecycle identity only;
- human Execute does not accept fresh amount, order, currency, action, execution ID, or verification result;
- one approval cannot create more than one synthetic refund side effect;
- preflight denial occurs before write/approval consumption;
- post-admission execution consumes the approval before asynchronous writer work;
- executor success alone cannot produce terminal success;
- only trusted independent verification evidence can complete the active execution.

## Flagship refund tests

The normal success case proves:

1. Order #4821 begins with zero refunded cents.
2. A strict `$25.00` refund proposal is accepted under the `$30.00` maximum.
3. Human review is requested for the exact proposal.
4. Human approves the exact immutable proposal.
5. Approval alone leaves execution blocked.
6. Human separately executes the approved refund.
7. The synthetic writer records the exact authorized effect.
8. A separate reader independently reads the ledger.
9. Exact expected/observed match reaches `SUCCEEDED` / visible **VERIFIED**.

## Attack tests

Required fail-closed proofs include:

- `$75.00` refund above `$30.00` policy maximum -> rejected before approval/execution.
- approved `$25.00`, attempted `$75.00` execution -> denied.
- approved `$25.00`, attempted `$20.00` execution -> denied.
- stale review identity -> denied.
- wrong proposal digest -> denied.
- wrong approval identity -> denied.
- duplicate execution -> denied/contained.
- hand-made verification evidence -> rejected.
- cloned verification evidence -> rejected.
- expected `$25.00`, reader observes `$20.00` -> terminal `FAILED`, never **VERIFIED**.

## WebMCP boundary tests

The browser-facing suite proves:

- exactly seven tools register;
- no agent approval, rejection, execution, verification, rollback, or reset tool exists;
- malformed and extra-field inputs are rejected by strict runtime schemas;
- agent commands receive internally fixed agent actor identity;
- query results are bounded/non-authoritative projections;
- callbacks read current application operations instead of stale React state;
- registration cleanup/remount works;
- partial registration failure cleans up prior registrations;
- unsupported browsers remain usable without fake WebMCP support;
- registration lifetime and invocation cancellation remain separate;
- an actual aborted invocation returns `CANCELLED`;
- a missing Chrome 151 invocation cancellation context is tolerated without granting any additional authority.

## Native browser acceptance

The final Gate 4 browser pass used a native WebMCP Model Context Tool Inspector path based on `document.modelContext.getTools()` and `document.modelContext.executeTool(...)`.

Verified local native sequence:

1. `get_audit_trail` with `{}` -> `SUCCESS`.
2. `propose_change` for Order #4821 / `$25.00` -> `SUCCESS` / `PROPOSED`.
3. `request_change_approval` -> `SUCCESS` / awaiting human approval.
4. Human webpage approval -> `APPROVED`, execution still blocked.
5. Human webpage Execute -> writer + independent verification.
6. Final lifecycle -> `SUCCEEDED` / **VERIFIED** with a six-event audit trail.

## Production smoke test

Public deployment:

https://changegate-webmcp.vercel.app

Production acceptance confirmed:

- page renders without runtime error;
- UI reports **WebMCP · Available · 7 safe tools registered**;
- native production `get_audit_trail` with `{}` returns `SUCCESS` and a clean initial audit state.

## Public-release scan

Before making the repository public:

1. Verify `.gitignore` excludes `.env*`, PEM files, build outputs, dependencies, and `.vercel` metadata.
2. Search tracked code/docs for credentials, API keys, tokens, private employer/client identifiers, and unrelated proprietary-project names.
3. Confirm the repository contains only ChangeGate challenge material.
4. Confirm MIT `LICENSE` is present and visible.
5. Re-read the README and challenge docs for claims that exceed demonstrated behavior.
6. Confirm public testing instructions match the actual deployed release.

## Submission freeze

After the September 3, 2026 1:00 p.m. Pacific submission deadline, do not change the submitted Devpost entry, repository, or live site during judging. Future work belongs in a separate fork/copy.

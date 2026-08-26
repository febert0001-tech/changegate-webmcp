# Domain model

## Separate state models

- **Environment state**: the canonical service fixture and future simulated health.
- **Change lifecycle**: constrained states for a proposed change and its possible execution/rollback outcome.
- **Audit events**: append-only future records for inspection, diagnosis, preflight, approval, execution, verification, reset, and denial.

## Foundation contracts

`src/domain/scenario/canonical-scenario.ts` exports immutable fixed data. `src/domain/engine.ts` creates independent runtime state and implements the pure reducer. `src/domain/change/proposal-digest.ts` recursively normalizes a narrow JSON value model and produces browser-safe SHA-256 from canonical proposal content.

`HumanApproval` is not a boolean. It binds `approvalId`, `proposalId`, `proposalDigest`, target, action, parameters, preconditions, `issuedBy: HUMAN`, and a lifecycle status to one exact proposal. The future representation may evolve without weakening this binding.

Supported parameter values are null, booleans, finite numbers, strings, arrays, and plain objects. The domain rejects all other runtime values, owns every nested reference, recursively freezes authoritative data, sorts object keys for canonical meaning, and preserves array order.

## Boundary rule

Data crossing WebMCP, command, approval, authorization, state-machine, execution, or audit boundaries starts as `unknown`; a future runtime boundary will validate it before the typed domain engine. Zod remains planned but is not needed for the trusted Gate 1 reducer tests.

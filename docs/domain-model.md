# Domain model

## Separate state models

- **Environment state**: the canonical service fixture and future simulated health.
- **Change lifecycle**: constrained states for a proposed change and its possible execution/rollback outcome.
- **Audit events**: append-only future records for inspection, diagnosis, preflight, approval, execution, verification, reset, and denial.

## Foundation contracts

`src/domain/scenario/canonical-scenario.ts` exports immutable fixed data. `src/domain/change/contracts.ts` defines only lifecycle and value-object shapes.

`HumanApproval` is not a boolean. It binds `approvalId`, `proposalId`, `proposalDigest`, target, action, parameters, preconditions, `issuedBy: HUMAN`, and a lifecycle status to one exact proposal. The future representation may evolve without weakening this binding.

## Boundary rule

Data crossing WebMCP, command, approval, authorization, state-machine, execution, or audit boundaries starts as `unknown`; future runtime validation produces trusted typed inputs. Zod is the planned validator, but is intentionally not installed at Gate 0.5.

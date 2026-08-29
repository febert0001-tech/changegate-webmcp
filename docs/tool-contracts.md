# WebMCP tool contracts (Gate 4)

WebMCP is an adapter over trusted application/domain operations. Tool availability is not authorization, and tool schemas do not confer human authority.

## Registered tool classes

| Class | Tools |
| --- | --- |
| Query / inspection | `get_environment_status`, `get_service_details`, `get_change_policy`, `get_change_proposal`, `get_audit_trail` |
| Non-authoritative commands | `propose_change`, `request_change_approval` |
| Consequential WebMCP commands | **None** |

Exactly seven WebMCP tools are registered.

## `propose_change`

`propose_change` creates only strictly supported synthetic proposals after runtime validation.

For the flagship refund variant, the proposal is constrained to:

- target `order:4821`;
- action `SYNTHETIC_PARTIAL_REFUND`;
- currency `USD`;
- integer cents `1..3000`; and
- the exact supported synthetic precondition.

The operation is still non-authoritative. Creating a proposal does not approve or execute it.

## `request_change_approval`

`request_change_approval` means: **bring the exact current proposal to the visible human review surface**.

It accepts the exact proposal ID and can move the lifecycle to `AWAITING_HUMAN_APPROVAL`. It never creates a human approval and cannot select approval identity.

## Intentionally absent tools

There is no registered WebMCP tool or semantic equivalent for:

- `approve_change`;
- `reject_change`;
- `execute_approved_change`;
- `verify_change`;
- `grant_permission`;
- `authorize`;
- `auto_approve`;
- `renew_approval`;
- `broaden_approval`;
- reset; or
- rollback authority.

The absence of these capabilities is a core design property.

## Human approval contract

Human approval occurs only through the visible UI and binds one exact proposal/review lifecycle. Caller-supplied approval fields are not accepted.

Approval alone does not execute.

## Human Execute contract

Execution is an application/UI capability outside WebMCP. It accepts only expected trusted approval-lifecycle identity captured from rendered state:

- proposal ID;
- proposal digest;
- review-instance ID; and
- approval ID.

It does not accept fresh business fields such as refund amount, target/order, currency, action, policy, or execution ID.

The authorized execution binding is derived internally from the trusted approved state.

## Verification contract

Verification is also outside the WebMCP authority surface.

A separately composed reader observes synthetic ledger state after execution. The verifier compares that observation with the exact trusted authorized effect. Only trusted exact-match evidence can complete `VERIFYING -> SUCCEEDED` and produce visible **VERIFIED**.

Executor success alone is insufficient.

## Invocation lifecycle contract

Registration cleanup and invocation cancellation are separate from authority.

An actual aborted invocation returns `CANCELLED`. If a supported browser invokes a callback without a usable cancellation context, the invocation is treated as not cancelled and still passes through the same strict input/domain authority checks.

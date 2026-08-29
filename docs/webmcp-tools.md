# WebMCP tool catalog (Gate 4 release)

## API surface

ChangeGate uses the native WebMCP imperative API at `document.modelContext`. The application feature-detects the browser surface, registers its tool catalog in a mounted Client Component, and leaves unsupported browsers functional without installing a polyfill.

Registration lifetime and per-invocation cancellation are separate concerns. Chrome 151 testing also demonstrated that native callbacks may arrive without a usable invocation cancellation context. The accepted compatibility behavior is fail-safe: a missing signal is treated as “not cancelled,” while an actual aborted signal still returns `CANCELLED`.

## Implemented catalog

ChangeGate exposes exactly seven tools:

| Tool | Access | Purpose |
| --- | --- | --- |
| `get_environment_status` | Read-only | Return bounded synthetic environment status. |
| `get_service_details` | Read-only | Return bounded diagnostics for one supported synthetic service. |
| `get_change_policy` | Read-only | Return bounded policy information. |
| `get_change_proposal` | Read-only | Return the current immutable proposed-change projection. |
| `get_audit_trail` | Read-only | Return bounded synthetic audit events. |
| `propose_change` | Non-authoritative command | Create a strictly validated supported proposal. |
| `request_change_approval` | Non-authoritative command | Request visible human review for the exact current proposal ID; never approve it. |

## Strict external-input boundary

External input begins untrusted and passes strict runtime validation before reaching operations. Unsupported fields and malformed values are rejected rather than ignored.

The flagship refund proposal is deliberately narrow:

- target: `order:4821`
- action: `SYNTHETIC_PARTIAL_REFUND`
- currency: `USD`
- amount: integer cents from `1` through `3000`
- precondition: exact supported synthetic order baseline

The agent cannot supply or choose:

- human approval identity;
- review-instance identity;
- authoritative proposal digest;
- execution ID;
- human actor identity;
- verification evidence;
- executor result; or
- post-approval replacement business fields.

## Human authority is outside WebMCP

There is intentionally **no** WebMCP `approve_change`, `reject_change`, `execute_approved_change`, `verify_change`, or equivalent authority-bearing tool.

`request_change_approval` only moves the exact trusted proposal to visible human review. It creates no approval.

A human must then use the visible application UI to:

1. approve the exact immutable proposal; and
2. separately choose to execute the exact approved refund.

That separation is a core product property, not a missing feature.

## Execution boundary

The human Execute path is application-only. It consumes trusted lifecycle identity rather than fresh amount/order/currency/action fields. The authorized refund effect is derived internally from the exact approved state.

This prevents post-approval substitution such as:

- approve `$25`, attempt `$75`; or
- approve `$25`, attempt `$20`.

Both are denied because they are not the exact authorization.

## Independent verification boundary

WebMCP cannot assert execution success or verification truth.

After the synthetic ledger write, a separately composed reader reads the actual synthetic ledger state. The verifier compares that observed evidence with the immutable authorized execution binding. Only an exact match produces terminal `SUCCEEDED` / visible **VERIFIED**.

## Registration and callback safety

- One registration controller governs the tool set lifecycle.
- Partial registration failure cleans up already registered tools.
- Registered callbacks query current application operations rather than stale React snapshots.
- Invocation cancellation is advisory lifecycle control, never authorization.
- Missing browser WebMCP support produces an unavailable status, not a fake/polyfilled tool surface.

## Native acceptance evidence

The final Gate 4 browser acceptance used the WebMCP Model Context Tool Inspector against native `document.modelContext` methods.

Verified native calls included:

- `get_audit_trail` with `{}` → `SUCCESS`;
- the strict Order #4821 `$25` `propose_change` → `SUCCESS` / `PROPOSED`; and
- `request_change_approval` for the exact proposal → `SUCCESS` / awaiting human approval.

The human then approved and separately executed through the webpage, after which independent readback produced **VERIFIED**.

The public Vercel deployment also passed a native production `get_audit_trail` smoke test while reporting exactly seven registered tools.

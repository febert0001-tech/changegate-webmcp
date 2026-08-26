# WebMCP tool catalog (Gate 2)

## Official API confirmation

Official Chrome guidance was rechecked on 2026-08-26. The current imperative surface remains `document.modelContext`; `registerTool(tool, { signal, exposedTo? })` is asynchronous, registration cleanup uses the options signal, and the execute callback receives a separate invocation-cancellation signal. The deprecated navigator surface is not used.

Source: [Chrome for Developers — WebMCP Imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api).

## Implemented catalog

| Tool | Access | Purpose |
| --- | --- | --- |
| `get_environment_status` | Read-only | Return synthetic status for the four services. |
| `get_service_details` | Read-only | Return bounded diagnostics for one named service. |
| `get_change_policy` | Read-only | Return bounded policy information. |
| `get_change_proposal` | Read-only | Return an exact, immutable proposed-change record. |
| `get_audit_trail` | Read-only | Return bounded synthetic audit events. |
| `propose_change` | Non-authoritative command | Propose only the flagship synthetic Agent Gateway restart. |
| `request_change_approval` | Non-authoritative command | Request visible human review for the exact current proposal ID; never approve it. |

Strict Zod objects reject malformed data, unsupported target/action values, and all extra authority-bearing fields. Query results are bounded copies. Tool callbacks read a component-scoped current-state operations instance, preventing stale React state.

One shared registration controller is supplied to all seven asynchronous registrations. Cleanup aborts the set; a partial registration failure also aborts the set. The execute callback's invocation signal is checked independently and is never treated as authorization.

Unsupported browsers keep the application usable and register nothing. There is no WebMCP polyfill.

## Non-negotiable exclusion

**There must never be a WebMCP `approve_change` tool or equivalent. Human approval must occur through the visible UI and be scoped to one exact proposed change.**

No tool may create, alter, infer, replay, or substitute a human approval. `request_change_approval` is not approval: it may only bring an immutable exact-ID proposal to the visible human UI.

The consequential tools `execute_approved_change` and `request_rollback` remain explicitly deferred and unregistered. See [tool-contracts.md](tool-contracts.md) for the authoritative classification.

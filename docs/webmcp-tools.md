# WebMCP tool catalog (planned; not implemented)

## API direction verified for Gate 0.5

Current official Chrome guidance identifies `document.modelContext` as the current imperative surface. Future registration will use `document.modelContext.registerTool(...)`, descriptive JSON input schemas, and `AbortSignal` lifecycle cleanup. `navigator.modelContext` is deprecated and will not be used. This active proposal must be rechecked immediately before implementation.

Source: [Chrome for Developers — WebMCP Imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api).

## Proposed catalog

| Planned tool | Access | Purpose |
| --- | --- | --- |
| `get_environment_status` | Read-only | Return synthetic status for the four services. |
| `get_service_details` | Read-only | Return bounded diagnostics for one named service. |
| `inspect_service_dependencies` | Read-only | Return bounded synthetic service dependencies. |
| `search_knowledge` | Read-only | Search synthetic runbook content. |
| `get_change_policy` | Read-only | Return bounded policy information. |
| `run_preflight_check` | Read-only | Return a synthetic preflight result. |
| `propose_change` | Non-authoritative command | Create a proposal for future human review. |
| `request_change_approval` | Non-authoritative command | Bring one proposal to the visible UI; never approve it. |
| `get_change_proposal` | Read-only | Return an exact, immutable proposed-change record. |
| `execute_approved_change` | Consequential command | Request execution only for an already UI-approved proposal; policy rechecks the exact proposal ID and binding. |
| `verify_change` | Read-only | Return post-change simulator verification. |
| `get_audit_trail` | Read-only | Return bounded synthetic audit events. |
| `request_rollback` | Consequential command | Request rollback of one eligible executed change; it requires a separate UI approval. |

The exact final schemas, annotations, output bounds, and cancellation behavior remain Gate 1 work.

## Non-negotiable exclusion

**There must never be a WebMCP `approve_change` tool or equivalent. Human approval must occur through the visible UI and be scoped to one exact proposed change.**

No tool may create, alter, infer, replay, or substitute a human approval. `request_change_approval` is not approval: it may only bring an immutable proposal to the visible human UI.

See [tool-contracts.md](tool-contracts.md) for the authoritative classification. No WebMCP tools are registered in Gate 0.5.

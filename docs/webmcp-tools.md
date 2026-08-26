# WebMCP tool catalog (planned; not implemented)

## API direction verified for Gate 0

The official Chrome WebMCP Imperative API documentation, last updated August 20, 2026, identifies `document.modelContext` as the current surface. Future tool registration will use `document.modelContext.registerTool(...)`, descriptive JSON input schemas, and `AbortSignal` lifecycle cleanup. `navigator.modelContext` is deprecated and will not be used. The proposal remains actively discussed, so its API must be rechecked before implementation.

Source: [Chrome for Developers — WebMCP Imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api).

## Proposed catalog

| Planned tool | Access | Purpose |
| --- | --- | --- |
| `get_environment_status` | Read-only | Return synthetic status for the four services. |
| `get_service_details` | Read-only | Return bounded diagnostics for one named service. |
| `search_knowledge` | Read-only | Search synthetic runbook content. |
| `get_change_proposal` | Read-only | Return an exact, immutable proposed-change record. |
| `request_change_execution` | Controlled | Request execution only for an already UI-approved proposal; policy rechecks the exact proposal ID and binding. |
| `verify_change` | Read-only | Return post-change simulator verification. |
| `get_audit_trail` | Read-only | Return bounded synthetic audit events. |
| `request_rollback` | Controlled | Request rollback of one eligible executed change; it requires a separate UI approval. |

The exact final schemas, annotations, output bounds, and cancellation behavior remain Gate 1 work.

## Non-negotiable exclusion

**There must never be a WebMCP `approve_change` tool or equivalent. Human approval must occur through the visible UI and be scoped to one exact proposed change.**

No tool may create, alter, infer, replay, or substitute a human approval. `request_change_execution` is not approval: it may only request a policy-checked execution for an already UI-approved immutable proposal.

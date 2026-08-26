# WebMCP tool contracts (planned)

WebMCP is an adapter. It will validate `unknown` inputs and call future domain operations; it never defines authority. Tool availability may reflect state, but availability is not authorization.

| Class | Planned tools |
| --- | --- |
| Query / inspection | `get_environment_status`, `get_service_details`, `inspect_service_dependencies`, `search_knowledge`, `get_change_policy`, `run_preflight_check`, `get_change_proposal`, `verify_change`, `get_audit_trail` |
| Non-authoritative commands | `propose_change`, `request_change_approval` |
| Consequential commands | `execute_approved_change`, `request_rollback` |

`request_change_approval` means “bring this proposal to the visible human approval surface”; it never approves a proposal.

There will never be `approve_change`, `grant_permission`, `authorize`, `auto_approve`, `renew_approval`, `broaden_approval`, or a semantic equivalent. No tools are registered in Gate 0.5.

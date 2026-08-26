# WebMCP tool contracts (Gate 2)

WebMCP is an adapter. It will validate `unknown` inputs and call future domain operations; it never defines authority. Tool availability may reflect state, but availability is not authorization.

| Class | Gate 2 tools |
| --- | --- |
| Query / inspection | `get_environment_status`, `get_service_details`, `get_change_policy`, `get_change_proposal`, `get_audit_trail` |
| Non-authoritative commands | `propose_change`, `request_change_approval` |
| Consequential commands | **None** |

The previously designed consequential names `execute_approved_change` and `request_rollback` are explicitly deferred and are not registered in Gate 2. Their future inclusion would require the visible human approval surface and a separate gate.

`request_change_approval` means “bring this proposal to the visible human approval surface”; it never approves a proposal.

The proposed change is limited to the synthetic Agent Gateway restart. `request_change_approval` accepts only the exact proposal ID and stops at `AWAITING_HUMAN_APPROVAL`.

There will never be `approve_change`, `grant_permission`, `authorize`, `auto_approve`, `renew_approval`, `broaden_approval`, or a semantic equivalent. Execution, rollback, reset, and all other consequential capabilities remain deferred.

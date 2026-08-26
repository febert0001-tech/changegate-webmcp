# Security invariants

1. A human using the visible UI is the sole approval authority.
2. The agent cannot create, issue, renew, broaden, alter, or consume an approval outside the future authorization policy.
3. An approval binds one exact immutable proposal/command and is single-use.
4. Changing an ID, target, action, parameters, preconditions, or proposal binding invalidates authorization.
5. Execution independently checks runtime schema, legal state, exact proposal, approval issuer/validity/consumption, action, target, parameters, and preconditions.
6. Rejected, expired, consumed, or reset-invalidated approval cannot execute or revive on retry.
7. Rollback needs a separate human approval and a known pre-change snapshot.
8. External content is untrusted and cannot override policy, state, schemas, or UI confirmation.
9. The simulator stays synthetic and receives no real-system credentials.
10. Audit records distinguish HUMAN, AGENT, and SYSTEM activity.
11. Authoritative proposal/approval structures own and freeze recursively validated JSON-compatible values.
12. Approval checks recompute canonical proposal and approval-content digests; property insertion order is not authority.
13. Rollback restores only the frozen snapshot captured immediately before execution.
14. Every WebMCP input begins as `unknown` and must pass strict runtime validation before an operation can dispatch a domain action.
15. WebMCP queries return bounded copies; no authoritative state, proposal, environment, or audit reference crosses the operations boundary.
16. Requesting human review names the exact current proposal ID and creates neither approval authority nor a HUMAN audit event.
17. Gate 2 exposes no consequential WebMCP capability.

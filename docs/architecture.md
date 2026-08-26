# Architecture (Gate 1.1 hardened domain foundation)

ChangeGate is a browser-hosted, deterministic IT-operations simulator. The domain operations, authorization policy, and state machine are authoritative. Human UI and WebMCP are separate interfaces; WebMCP is an adapter after runtime validation, not an authority.

## Future simulated environment

| Service | Future responsibility | Initial incident posture |
| --- | --- | --- |
| Web Server | Simulated request handling and health reporting | Healthy |
| Database | Simulated application data dependency | Healthy |
| Agent Gateway | Simulated agent-facing routing and policy boundary | **DEGRADED** |
| Knowledge Store | Simulated runbook and diagnostic data | Healthy |

The flagship incident is `Agent Gateway = DEGRADED`.

## Planned flow

`read-only inspection -> diagnosis event -> proposed change -> visible human approval -> scoped execution -> independent verification -> audit record -> optional rollback`

The UI will present state and future approval controls. It does not directly mutate domain state. Gate 1.1 keeps the pure synchronous domain layer browser-compatible; WebMCP remains unimplemented and may not bypass UI approval or policy checks.

## Deterministic reset

A future visible UI reset will restore the fixed seed state, including `Agent Gateway = DEGRADED`; remove proposals, approvals, execution and rollback authorization; invalidate every transient authorization; restore deterministic audit state; and reset sequence counters.

## Deployment boundary

This is a Vercel-ready Next.js app. The simulator will use only synthetic local scenario state and will not connect to real infrastructure or private data.

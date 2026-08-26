# Architecture (Gate 2 safe WebMCP boundary)

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

The UI will present future approval controls. It does not directly mutate domain state. Gate 2 mounts a small Client Component that feature-detects native WebMCP, creates one component-scoped operations instance, and registers seven tools. WebMCP cannot bypass UI approval or policy checks.

## Gate 2 boundary

`document.modelContext -> seven-tool catalog -> Zod validation -> scoped operations -> pure reducer`

- The operations closure privately owns current reducer state; registered callbacks query it at invocation time and cannot capture a stale React snapshot.
- Query operations return bounded, recursively copied projections rather than authoritative references.
- A shared registration `AbortController` gives the seven registrations all-or-cleanup behavior. Partial failure aborts registrations that already succeeded.
- Registration lifetime and per-invocation cancellation use distinct signals.
- The component reads `document` only inside `useEffect`, so SSR and module evaluation remain browser-API free.
- Missing `document.modelContext` is an ordinary unsupported-browser state; no polyfill or fake capability is installed.

## Deterministic reset

A future visible UI reset will restore the fixed seed state, including `Agent Gateway = DEGRADED`; remove proposals, approvals, execution and rollback authorization; invalidate every transient authorization; restore deterministic audit state; and reset sequence counters.

## Deployment boundary

This is a Vercel-ready Next.js app. The simulator will use only synthetic local scenario state and will not connect to real infrastructure or private data.

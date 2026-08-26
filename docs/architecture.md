# Architecture (planned; not implemented)

ChangeGate is a browser-hosted, deterministic IT-operations simulator. An agent may inspect state and propose a repair; a human remains the approval authority for consequential actions.

## Future simulated environment

| Service | Future responsibility | Initial incident posture |
| --- | --- | --- |
| Web Server | Simulated request handling and health reporting | Healthy |
| Database | Simulated application data dependency | Healthy |
| Agent Gateway | Simulated agent-facing routing and policy boundary | **DEGRADED** |
| Knowledge Store | Simulated runbook and diagnostic data | Healthy |

The flagship incident is `Agent Gateway = DEGRADED`.

## Planned flow

`read-only inspection -> diagnosis -> proposed change -> visible human approval -> scoped execution -> verification -> audit record -> optional rollback`

The UI will show authoritative simulator state and approval controls. WebMCP will expose carefully scoped tools; it will not bypass UI approval.

## Deterministic reset

A future visible UI reset will restore the fixed seed state, including `Agent Gateway = DEGRADED`, clear transient proposals and approvals, and preserve/reset audit data only according to a documented demonstration mode. Reset will be reproducible from a fixed scenario definition.

## Deployment boundary

This is a Vercel-ready Next.js app. The simulator will use only synthetic local scenario state and will not connect to real infrastructure or private data.

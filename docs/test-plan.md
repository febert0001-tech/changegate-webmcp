# Test plan

## Gate 0 checks

1. Install dependencies with `npm install`.
2. Start `npm run dev` and verify the local home page responds.
3. Run `npm run build` for a production build.
4. Run `npm run typecheck`.
5. Run `npm run lint`.
6. Inspect the tracked file list and scan for common secret-file names and credential markers.
7. Confirm the Git root is `changegate-webmcp`, not a parent project.

No application test suite is configured at Gate 0 because no application behavior beyond the scaffold exists.

## Future acceptance tests (not Gate 0)

- Reset always restores the fixed four-service seed state with `Agent Gateway = DEGRADED`.
- Read-only WebMCP tools cannot mutate simulator state.
- There is no `approve_change` or equivalent WebMCP tool.
- An agent cannot transition a proposal to approved, including replay, substitution, expiry bypass, or prompt injection.
- Execution accepts only a single matching UI approval for an immutable proposal.
- Failed verification and rollback require accurately recorded, separately authorized transitions.
- Audit events distinguish human approval from agent actions.

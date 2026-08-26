# Test plan

## Gate 1 checks

1. Install dependencies with `npm install`.
2. Start `npm run dev` and verify the local home page responds.
3. Run `npm test` to prove the canonical scenario fixture.
4. Run `npm run build` for a production build.
5. Run `npm run typecheck`.
6. Run `npm run lint`.
6. Inspect the tracked file list and scan for common secret-file names and credential markers.
7. Confirm the Git root is `changegate-webmcp`, not a parent project.

The Vitest suite proves the exact fixture, legal lifecycle paths, rejected transitions, digest binding, consumed/reset-invalid approvals, active-reset rejection, deterministic reset, and deterministic audit actors/sequences. It has no current-time or random dependency.

## Future interface acceptance tests (not Gate 1)

- execution before approval -> DENIED
- agent attempts self-approval -> IMPOSSIBLE/DENIED
- wrong proposal ID -> DENIED
- changed action, target, parameters, or preconditions after approval -> DENIED
- expired, rejected, consumed, or reset-invalidated approval -> DENIED
- approval for Change A used for Change B -> DENIED
- unsupported command -> DENIED; malformed WebMCP payload -> REJECTED
- failed verification -> does not become SUCCEEDED
- rollback without separate approval -> DENIED
- Reset always restores the fixed four-service seed state with `Agent Gateway = DEGRADED`.
- Read-only WebMCP tools cannot mutate simulator state.
- There is no `approve_change` or equivalent WebMCP tool.
- An agent cannot transition a proposal to approved, including replay, substitution, expiry bypass, or prompt injection.
- Execution accepts only a single matching UI approval for an immutable proposal.
- Failed verification and rollback require accurately recorded, separately authorized transitions.
- Audit events distinguish human approval from agent actions.

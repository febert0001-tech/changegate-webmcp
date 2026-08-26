# Test plan

## Gate 2 checks

1. Install dependencies with `npm install`.
2. Start `npm run dev` and verify the local home page responds.
3. Run `npm test` to prove the canonical scenario fixture.
4. Run `npm run build` for a production build.
5. Run `npm run typecheck`.
6. Run `npm run lint`.
6. Inspect the tracked file list and scan for common secret-file names and credential markers.
7. Confirm the Git root is `changegate-webmcp`, not a parent project.

The complete Vitest suite preserves every Gate 1.1 invariant and adds strict Zod rejection, exact proposal-ID review requests, bounded non-aliasing projections, exact seven-tool exposure, internally fixed AGENT commands, safe structured errors, current-state callbacks, registration cleanup/remount, partial-failure cleanup, unsupported-browser behavior, distinct registration/invocation signals, and static client-boundary checks.

The production build is the browser-bundle proof: the mounted Client Component imports the operations, Zod adapter, reducer, and browser-safe digest path without evaluating `document` during SSR.

## Deferred consequential-interface acceptance tests (after Gate 2)

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

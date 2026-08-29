# Challenge compliance (Gate 4 release)

## Scope boundary

ChangeGate is a standalone repository created for the 2026 OpenAI WebMCP Challenge. It uses only synthetic scenario data and does not contain employer, client, proprietary private-project, credential, or production-infrastructure material.

## Challenge requirements mapping

| Requirement | ChangeGate evidence |
| --- | --- |
| Working WebMCP-powered web app | Gate 4 production console is deployed and publicly reachable. |
| Working live URL | https://changegate-webmcp.vercel.app |
| WebMCP use | Exactly seven native WebMCP tools are registered through `document.modelContext`. |
| Human + agent collaboration | Agent can inspect, propose, and request review; human approval and human execution remain separate visible UI actions. |
| Text description | Public README and submission packet explain WebMCP fit, UX, human/agent collaboration, and implementation. |
| Public repository | Release URL: https://github.com/febert0001-tech/changegate-webmcp. Public visibility must be confirmed before final submission. |
| Open-source license | MIT `LICENSE` is present. |
| Demo video | Required public YouTube video under three minutes with audio; production recording remains a submission task. |

Official submission deadline: **September 3, 2026 at 1:00 p.m. Pacific Time**.

## Accepted Gate 4 evidence

- Final accepted implementation checkpoint: `869694380b9f3f2d18ff7339aa35419d962fc528`.
- Full regression suite: **335/335 tests PASS**.
- Typecheck: PASS.
- Lint: PASS.
- Production build: PASS.
- `git diff --check`: PASS.
- Exactly seven WebMCP tools remain exposed.
- No agent-callable human approval or execution capability exists.
- Native Chrome WebMCP Inspector proof completed for the seven-tool surface.
- Native end-to-end local proof completed: proposal → review request → human approval → separate human Execute → independent readback → `SUCCEEDED` / **VERIFIED**.
- Public Vercel production page renders correctly and reports **WebMCP · Available · 7 safe tools registered**.
- Native production `get_audit_trail` with `{}` returned `SUCCESS` with a clean initial audit state.

## Human/agent authority split

The WebMCP agent may:

- read bounded synthetic environment state;
- read service details, change policy, proposal state, and audit state;
- propose a strictly validated supported change; and
- request human review for the exact current proposal.

The WebMCP agent may **not**:

- approve or reject a proposal;
- execute a consequential action;
- create, choose, or replay human approval authority;
- mark execution as verified; or
- invoke rollback authority.

Human approval and human Execute are separate application actions outside the WebMCP tool surface.

## Flagship challenge scenario

- Synthetic Order #4821: `$129.00`.
- Policy maximum partial refund: `$30.00`.
- Agent proposal: `$25.00`.
- Human approves the exact immutable proposal.
- Approval alone does not execute.
- Human separately executes the exact approved refund.
- Synthetic ledger records the constrained effect.
- A separate reader independently inspects ledger state.
- Exact authorized/readback match produces visible **VERIFIED**.

## Fail-closed proofs

- `$75` refund above the `$30` maximum is rejected before approval/execution.
- Post-approval execution substitution to `$75` is blocked.
- Post-approval execution substitution to `$20` is blocked because it is not the exact authorization.
- Stale/replayed approval identity is denied.
- Duplicate execution is denied/contained.
- Forged or cloned verification evidence is rejected.
- Expected `$25` with independent readback of `$20` reaches terminal verification failure rather than success.

## Browser compatibility note

Chrome 151 testing exposed a compatibility case where native tool callbacks could arrive without a usable cancellation context. The accepted compatibility patch treats a missing cancellation context as “not cancelled” while preserving cancellation when a real signal is aborted. The patch changes no schemas, authority surfaces, business payloads, human controls, or verification trust boundaries.

## Release rules

Before final submission:

1. Complete public-documentation review.
2. Confirm the GitHub repository is public and the MIT license is detected/visible.
3. Record and publish the required `<3 minute` YouTube demo with audio.
4. Complete every required Devpost field.
5. Re-test the public live URL and native WebMCP path.

After the submission period closes, the submitted Devpost entry, repository, and live site must remain frozen through judging. Future development should use a separate fork/copy.

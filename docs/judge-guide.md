# ChangeGate — Judge Guide

ChangeGate is a human-governed WebMCP control layer for consequential workflows.

**Core pattern:** AI proposes. Humans authorize. ChangeGate verifies.

## Quick links

- Live demo: https://changegate-webmcp.vercel.app
- Repository: https://github.com/febert0001-tech/changegate-webmcp
- Architecture: ./architecture.md
- Challenge compliance: ./challenge-compliance.md
- Security model: ./security-model.md
- State machine: ./state-machine.md
- Test plan: ./test-plan.md
- Tool contracts: ./tool-contracts.md
- WebMCP tool catalog: ./webmcp-tools.md

## Fast judge path

1. Open the live demo in a WebMCP-capable environment.
2. Confirm the UI reports **WebMCP · Available · 7 safe tools registered**.
3. Call `get_audit_trail` with `{}`.
4. Create the synthetic refund proposal for **Order #4821** and **$25.00**.
5. Request human review.
6. In the visible UI, click **Approve exact proposal**.
7. Confirm approval still does **not** execute the refund.
8. Separately click **Execute approved $25.00 refund**.
9. Observe independent readback and the final **VERIFIED** state.

The policy ceiling in the demo is **$30.00**. The scenario is synthetic only; no real payment system or customer account is connected.

## Authority boundary

The agent receives exactly seven native WebMCP tools for inspection, proposal, and review-request functions. It does not receive tools that let it approve, execute, or self-verify a consequential action.

Human approval and human execution are separate decisions. After execution, ChangeGate uses independent readback before the result can become **VERIFIED**.

## Demo narration disclosure

The public demo uses a neutral stock synthetic voice from Narakeet rather than the entrant's natural voice. This was a privacy choice: the goal was to avoid publishing a reusable sample of the entrant's real voice that could later be used for voice cloning or impersonation. The narration is not a clone or imitation of the entrant's voice.

The narration and supporting copy were reviewed and edited to match the actual implemented and recorded behavior.

## Supporting engineering evidence

For reviewers who want deeper implementation detail, the linked repository documentation covers the architecture, security model, state machine, tool contracts, WebMCP tool surface, and test plan. The final accepted implementation passed **335/335 automated tests**, plus type checking, linting, production build, and diff checks.

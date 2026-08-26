# ChangeGate specification

## Scope

ChangeGate is a deterministic, synthetic IT-operations simulator for the 2026 OpenAI WebMCP Challenge. Gate 0.5 freezes contracts and architecture; no simulator behavior, approval UI, WebMCP tool registration, execution, rollback, persistence, or production integration exists.

## Interfaces and authority

The system has a Human UI and a WebMCP agent interface. Neither owns authority. The domain state machine and its policy checks are authoritative. React presents state and dispatches future requests; WebMCP adapts validated external input to future domain operations.

## Canonical incident

The fixed seed scenario contains exactly four synthetic services: `web-server`, `database`, `agent-gateway`, and `knowledge-store`. Their initial health is respectively `HEALTHY`, `HEALTHY`, `DEGRADED`, and `HEALTHY`.

## Reset contract

Future `RESET_SCENARIO` behavior restores the exact canonical service state; removes proposals, approvals, execution state, rollback authorization; invalidates every transient authorization; restores the deterministic demo/audit starting state; and resets deterministic sequence counters.

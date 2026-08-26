# ChangeGate specification

## Scope

ChangeGate is a deterministic, synthetic IT-operations simulator for the 2026 OpenAI WebMCP Challenge. Gate 1.1 hardens only the pure domain/state-machine foundation; it has no UI, WebMCP registration, network, persistence, or real infrastructure integration.

## Interfaces and authority

The system has a Human UI and a WebMCP agent interface. Neither owns authority. The domain state machine and its policy checks are authoritative. React presents state and dispatches future requests; WebMCP adapts validated external input to future domain operations.

## Canonical incident

The fixed seed scenario contains exactly four synthetic services: `web-server`, `database`, `agent-gateway`, and `knowledge-store`. Their initial health is respectively `HEALTHY`, `HEALTHY`, `DEGRADED`, and `HEALTHY`.

## Reset contract

`RESET_SCENARIO` restores the exact canonical service state; removes proposals, approvals, execution state, rollback authorization; invalidates every transient authorization; restores deterministic audit state; and resets sequence counters. It is legal from every non-active lifecycle state and rejected exactly while `EXECUTING`, `VERIFYING`, or `ROLLING_BACK`.

## Proposal digest authority

Trusted domain code recursively validates/copies proposal ID, target, action, parameters, and preconditions, sorts object keys, then computes synchronous SHA-256 with the browser-compatible `@noble/hashes` primitive. External callers never supply an authoritative digest; any material change yields a different binding.

## Rollback baseline

`BEGIN_EXECUTION` captures one frozen pre-change snapshot. Execution/verification failure and all rollback states carry that same snapshot. Rollback never recaptures or infers a baseline; success restores the original snapshot, while rollback failure leaves the current environment unchanged.

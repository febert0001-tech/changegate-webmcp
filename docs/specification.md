# ChangeGate specification

## Scope

ChangeGate is a deterministic, synthetic IT-operations simulator for the 2026 OpenAI WebMCP Challenge. Gate 1 implements only the pure domain/state-machine foundation; it has no UI, WebMCP registration, network, persistence, or real infrastructure integration.

## Interfaces and authority

The system has a Human UI and a WebMCP agent interface. Neither owns authority. The domain state machine and its policy checks are authoritative. React presents state and dispatches future requests; WebMCP adapts validated external input to future domain operations.

## Canonical incident

The fixed seed scenario contains exactly four synthetic services: `web-server`, `database`, `agent-gateway`, and `knowledge-store`. Their initial health is respectively `HEALTHY`, `HEALTHY`, `DEGRADED`, and `HEALTHY`.

## Reset contract

`RESET_SCENARIO` restores the exact canonical service state; removes proposals, approvals, execution state, rollback authorization; invalidates every transient authorization; restores deterministic audit state; and resets sequence counters. It is rejected while `EXECUTING`, `VERIFYING`, or `ROLLING_BACK`; it never silently interrupts active work.

## Proposal digest authority

Trusted domain code canonicalizes proposal ID, target, action, parameters, and preconditions, then computes the SHA-256 digest. External callers never supply an authoritative digest; any material change yields a different binding.

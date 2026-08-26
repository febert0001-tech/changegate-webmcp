# ChangeGate Engineering Constitution

1. The domain state machine is authority; React and WebMCP are interfaces.
2. The visible Human UI is the sole approval authority.
3. WebMCP is an adapter, never domain authority.
4. External input begins as `unknown` and requires runtime validation.
5. No `any` at security or authority boundaries.
6. Use discriminated unions, immutable typed commands, and separate environment/lifecycle models.
7. Approval binds one exact proposal, is single-use, and invalidates on any material change.
8. Keep reducers, policies, comparisons, and transitions pure and deterministic; keep side effects at edges.
9. Reset restores the exact fixture and revokes all transient authority; rollback requires separate approval.
10. Consequential capabilities require adversarial tests.
11. Current official documentation outranks stale examples and model memory.
12. Add no dependency or service without a demonstrated requirement.

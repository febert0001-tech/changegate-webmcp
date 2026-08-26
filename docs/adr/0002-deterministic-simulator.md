# Deterministic simulator fixture

Status: Accepted

Context: A challenge demonstration must be reproducible and safe.

Decision: Freeze one immutable four-service canonical scenario and explicit reset semantics.

Alternatives considered: Random incidents, real infrastructure, browser persistence.

Consequences: Tests and demos have stable starting state; no real systems are contacted.

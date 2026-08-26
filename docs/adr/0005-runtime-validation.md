# Runtime validation at the boundary

Status: Accepted

Context: WebMCP and agent inputs are external data.

Decision: Treat them as `unknown` and validate before domain policy; plan Zod when implementation requires it.

Alternatives considered: Trusting TypeScript compile-time types or using `any`.

Consequences: Gate 0.5 adds no Zod dependency or validator implementation.

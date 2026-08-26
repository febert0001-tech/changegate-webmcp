# Runtime validation at the boundary

Status: Accepted

Context: WebMCP and agent inputs are external data.

Decision: Treat them as `unknown`, reject non-JSON runtime containers, and apply strict Zod schemas before narrow domain operations.

Alternatives considered: Trusting TypeScript compile-time types or using `any`.

Consequences: Gate 2 adds Zod as its sole dependency and rejects malformed, unsupported, or authority-bearing external fields before reducer dispatch.

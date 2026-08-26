# WebMCP as an adapter

Status: Accepted

Context: Agent-facing integration must not control consequential authority.

Decision: Future WebMCP receives runtime-validated input and calls domain operations only.

Alternatives considered: Putting workflow and authorization logic in tool callbacks.

Consequences: `document.modelContext` integration is replaceable; no tools are registered in Gate 0.5.

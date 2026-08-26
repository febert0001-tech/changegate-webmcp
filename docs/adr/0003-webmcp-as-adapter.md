# WebMCP as an adapter

Status: Accepted

Context: Agent-facing integration must not control consequential authority.

Decision: Future WebMCP receives runtime-validated input and calls domain operations only.

Alternatives considered: Putting workflow and authorization logic in tool callbacks.

Consequences: Gate 2 registers exactly seven replaceable `document.modelContext` tools over strict validation and narrow operations. The adapter has no approval or consequential authority.

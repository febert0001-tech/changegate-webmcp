# Human-only approval

Status: Accepted

Context: An agent must never authorize its own consequential actions.

Decision: Only a visible UI human decision may approve one exact immutable proposal.

Alternatives considered: Agent approval tools, loose booleans, reusable authorization.

Consequences: There is never an `approve_change` tool or semantic equivalent; rollback is separately approved.

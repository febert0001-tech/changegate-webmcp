# Browser-safe synchronous SHA-256

Status: Accepted

Context: Proposal binding requires SHA-256, while the future client must import the synchronous pure domain reducer.

Decision: Use the audited, zero-dependency `@noble/hashes` SHA-256 submodule with explicit UTF-8 and hex utilities.

Alternatives considered: Node `crypto` (not browser-safe), asynchronous Web Crypto (would make the reducer asynchronous), and a homemade implementation (unnecessary security risk).

Consequences: One focused dependency preserves synchronous deterministic SHA-256 across Node and browser bundlers.

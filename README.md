# ChangeGate

Standalone entry for the 2026 OpenAI WebMCP Challenge.

ChangeGate will be a human-controlled IT-operations simulator: an agent may inspect a simulated environment, diagnose an incident, and propose a change. A person must authorize one exact proposal through the visible application UI before the simulator can execute it. The agent must never approve consequential actions.

## Gate 1.1 status

The environment and deterministic domain foundation are verified with hardened rollback snapshots, reset revocation, browser-safe SHA-256, and deeply immutable proposal/approval bindings. The project intentionally has no WebMCP interface, approval UI, persistence, or real execution effects.

## Stack

- Next.js 16.3.3
- React 19.2.8
- TypeScript 5 with `strict: true`
- ESLint 9 / `eslint-config-next`
- Vercel-ready Next.js application

## Commands

```bash
npm run dev
npm run build
npm run typecheck
npm run lint
npm test
```

## WebMCP direction

Future WebMCP integration will use the current imperative API at `document.modelContext`, specifically `registerTool` with an abort signal for lifecycle management. It will not use deprecated `navigator.modelContext` APIs. See [docs/webmcp-tools.md](docs/webmcp-tools.md).

## Documentation

- [Architecture](docs/architecture.md)
- [Specification](docs/specification.md)
- [State machine](docs/state-machine.md)
- [Domain model](docs/domain-model.md)
- [Engineering Constitution](docs/engineering-constitution.md)
- [WebMCP tool catalog](docs/webmcp-tools.md)
- [Security model](docs/security-model.md)
- [Challenge compliance](docs/challenge-compliance.md)
- [Test plan](docs/test-plan.md)

## License

MIT. See [LICENSE](LICENSE).

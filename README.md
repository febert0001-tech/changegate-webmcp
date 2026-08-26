# ChangeGate

Standalone entry for the 2026 OpenAI WebMCP Challenge.

ChangeGate will be a human-controlled IT-operations simulator: an agent may inspect a simulated environment, diagnose an incident, and propose a change. A person must authorize one exact proposal through the visible application UI before the simulator can execute it. The agent must never approve consequential actions.

## Gate 2 status

The verified Gate 1.1 domain foundation now has a safe browser-facing WebMCP boundary. Gate 2 registers five bounded read tools and two non-authoritative proposal tools after strict Zod validation. It intentionally has no human approval UI, consequential WebMCP capability, persistence, or real execution effects.

## Stack

- Next.js 16.3.3
- React 19.2.8
- TypeScript 5 with `strict: true`
- Zod 4 runtime validation
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

## WebMCP implementation

The browser integration uses the current imperative API at `document.modelContext`, specifically asynchronous `registerTool` calls with shared abort-signal lifecycle cleanup. Invocation cancellation remains separate. Unsupported browsers render normally without a polyfill. See [docs/webmcp-tools.md](docs/webmcp-tools.md).

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

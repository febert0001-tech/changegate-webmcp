# ChangeGate

**AI can propose. Humans authorize. ChangeGate independently verifies.**

ChangeGate is a human-governed WebMCP change-control demo for the 2026 OpenAI WebMCP Challenge. It explores a narrow but consequential question: **how can an AI agent participate in operational workflows without silently acquiring the authority to approve or execute consequential actions?**

The agent receives a deliberately restricted seven-tool WebMCP surface. It can inspect a bounded synthetic environment, read policy and audit state, propose a supported change, and request human review. It cannot approve, reject, execute, or verify a consequential action through WebMCP.

The flagship demo is a synthetic partial refund for Order #4821. The agent proposes a **$25.00** refund under a **$30.00** policy limit. A human must approve the exact immutable proposal, then make a second, separate **Execute** decision. After execution, ChangeGate independently reads the synthetic ledger and shows **VERIFIED** only when the observed result exactly matches what the human authorized.

## Live demo

https://changegate-webmcp.vercel.app

Use ChatGPT's WebMCP-capable in-app browser or Google Chrome 149+ with `chrome://flags/#enable-webmcp-testing` enabled.

## Why WebMCP

WebMCP is the **agent-facing collaboration boundary**, not the authority boundary.

Structured tools let the agent inspect state, form a bounded proposal, and request review without scraping the UI or guessing at controls. The absence of approval and execution tools is intentional: human authorization and human execution remain visible application actions outside the WebMCP surface.

The collaboration model is:

1. **AI proposes** a bounded action.
2. **Human approves** the exact immutable proposal.
3. **Human executes** through a second deliberate decision.
4. **ChangeGate independently verifies** what actually happened.

## Demo scenario

- Synthetic order: `#4821`
- Order value: `$129.00`
- Policy maximum partial refund: `$30.00`
- Proposed refund: `$25.00`
- Synthetic ledger before execution: `$0.00`
- Authorized execution: `$25.00`
- Independent readback: expected `$25.00` / observed `$25.00`
- Terminal result: `SUCCEEDED` / **VERIFIED**

The UI deliberately distinguishes **approved** from **executed**. Approval alone never causes the refund.

## WebMCP tool surface

ChangeGate exposes exactly seven WebMCP tools:

| Tool | Access | Purpose |
| --- | --- | --- |
| `get_environment_status` | Read-only | Read bounded synthetic environment status. |
| `get_service_details` | Read-only | Read details for one supported synthetic service. |
| `get_change_policy` | Read-only | Read the current bounded change policy. |
| `get_change_proposal` | Read-only | Read the current immutable proposal projection. |
| `get_audit_trail` | Read-only | Read bounded deterministic audit events. |
| `propose_change` | Non-authoritative command | Create a strictly validated supported proposal. |
| `request_change_approval` | Non-authoritative command | Request visible human review for the exact current proposal. |

There is intentionally **no WebMCP tool for human approval, rejection, execution, verification, or rollback**.

## Human authority boundary

Human approval is bound to the exact proposal lifecycle and immutable proposal digest. Each review lifecycle receives trusted internal identity material that the agent cannot choose or manufacture.

Refund execution is a separate human-only application action. The Execute path consumes only the trusted lifecycle identity captured from the state the person is viewing. It does **not** accept fresh amount, order ID, currency, action, policy, or execution ID fields after approval.

That prevents a caller from turning “approve $25” into “execute $75” after approval.

Approval is single-use and is consumed before the synthetic side effect begins.

## Independent verification

Executor success is not treated as proof of outcome.

The synthetic refund ledger is private in-memory state with separate writer and reader interfaces. After the exact authorized refund is applied, a separately composed verifier reads the ledger and compares the observed transaction with the immutable authorized execution binding.

- Exact readback match → `SUCCEEDED` / **VERIFIED**
- Readback mismatch or verification failure → `FAILED`
- Duplicate, stale, replayed, or substituted execution → denied

A failed verification does not claim that no side effect occurred; it means ChangeGate refuses to assert success without independent evidence.

## Attack proofs

The automated suite covers the authority failures this demo is designed to prevent:

- `$75` refund above the `$30` policy maximum → rejected before approval/execution.
- Human approves `$25`, attempted `$75` execution → blocked.
- Human approves `$25`, attempted `$20` execution → blocked because it is not the exact authorization.
- Stale or replayed lifecycle identity → denied.
- Duplicate execution → denied/contained.
- Hand-made or cloned verification evidence → rejected.
- Expected `$25`, independent reader reports `$20` → terminal verification failure.

## Running locally

```bash
npm install
npm run dev
```

Then open `http://localhost:3000` in a WebMCP-capable environment.

### Chrome WebMCP testing

1. Use Google Chrome 149 or later.
2. Open `chrome://flags/#enable-webmcp-testing`.
3. Enable the WebMCP testing flag.
4. Restart Chrome.
5. Open ChangeGate.

Unsupported browsers can still render the application, but native WebMCP registration will report unavailable.

## Judge test path

A normal native WebMCP success path is:

1. Confirm the app reports **7 safe tools registered**.
2. Call `get_audit_trail` with `{}` to confirm the native tool boundary.
3. Call `propose_change` with:

```json
{
  "proposalId": "refund-order-4821",
  "target": "order:4821",
  "action": "SYNTHETIC_PARTIAL_REFUND",
  "parameters": {
    "currency": "USD",
    "amountCents": 2500
  },
  "preconditions": [
    "order:4821 refunded amount is 0 cents"
  ]
}
```

4. Call `request_change_approval` with:

```json
{
  "proposalId": "refund-order-4821"
}
```

5. In the visible UI, click **Approve exact proposal**.
6. Observe that approval still leaves execution blocked.
7. Separately click **Execute approved $25.00 refund**.
8. Observe execution, independent readback, and **VERIFIED**.

## Verification commands

```bash
npm test
npm run typecheck
npm run lint
npm run build
git diff --check
```

Accepted Gate 4 implementation checkpoint: **335/335 tests PASS**, plus typecheck, lint, production build, and diff checks passing.

## Stack

- Next.js 16.3.3
- React 19.2.8
- TypeScript 5 with `strict: true`
- Zod 4 runtime validation
- Vitest
- ESLint 9 / `eslint-config-next`
- Native WebMCP imperative API via `document.modelContext`
- Synthetic in-memory ledger
- Vercel

## Architecture

```text
Agent WebMCP proposal
        ↓
Exact immutable proposal
        ↓
Visible human approval
        ↓
Separate human Execute
        ↓
Trusted authorized execution binding
        ↓
Synthetic ledger write
        ↓
Independent ledger readback
        ↓
VERIFIED or FAILED
```

## Synthetic-only scope

ChangeGate is a challenge demonstration. It does not process real payments, connect to production financial systems, or claim production-ready payment authorization. Order #4821 and the ledger are synthetic.

## Development approach

The project used a deliberately bounded human + AI engineering workflow. Architecture, acceptance criteria, risk boundaries, manual browser verification, and release decisions remained human-directed. AI coding assistance was used in small, reviewable implementation units, with deterministic Git/PowerShell checks and independent review used whenever a more expensive model turn was unnecessary. The commit history and acceptance checkpoints preserve the development trail during the challenge period.

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

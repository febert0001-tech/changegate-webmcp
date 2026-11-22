# Merchant refunds

The internal operator workspace is at `/merchant`. It uses a local SQLite database and keeps the existing synthetic WebMCP demonstration at `/`. Bind the merchant build to loopback and keep it off hosted environments. All seven native tool names are available after operator sign-in. The tools can inspect, propose and request review. The authenticated server handles the human decision, separate Execute, and read-only reconciliation.

## Local simulation

Use Node 24 or later and a fresh database path for a new rehearsal. Write the SQLite file outside the repository into a private local directory. These PowerShell settings are for the simulation only.

```powershell
$env:CHANGEGATE_MERCHANT_MODE = 'simulated'
$env:CHANGEGATE_OPERATOR_NAME = 'operator'
$env:CHANGEGATE_OPERATOR_PASSWORD = 'local-simulation-demo-only'
$env:CHANGEGATE_MERCHANT_DB = Join-Path (Get-Location) '..\changegate-merchant-demo.sqlite'
$env:CHANGEGATE_MAX_REFUND_CENTS = '10000'
npm ci
npm run dev -- --hostname 127.0.0.1 --port 3190
```

Sign in at `http://127.0.0.1:3190/merchant`. Find a transaction by order or capture reference, choose a capture, then enter a partial USD amount or leave it blank for the full remaining balance. Request review, approve, and choose Execute. The case and all reservations persist across app restarts.

| Capture reference | Expected simulated behavior |
| --- | --- |
| `DEMOCAPTURE100` | $18.99 captured. Full refund and matching independent readback. |
| `DEMOCAPTURE200` | $72.35 captured. Multiple partial refunds draw down the balance. |
| `DEMOCAPTURE300` | Provider records the refund, then loses the reply. Restart, open the uncertain case, and reconcile the original invoice reference through independent GET. |
| `DEMOCAPTURE400` | Independent readback reports pending. The reservation stays in place. |
| `DEMOCAPTURE500` | Independent readback reports an amount mismatch. The outcome remains uncertain. |
| `DEMOCAPTURE600` | Independent readback reports a matching failed refund. |
| `DEMOCAPTURE700` | Provider records the refund, loses the reply, and omits the refund from order history. Reconciliation keeps the case uncertain and the balance held. |

## PayPal Sandbox proof

Use a **separate** database, set `CHANGEGATE_MERCHANT_MODE=sandbox`, and supply `CHANGEGATE_MERCHANT_ID`, `CHANGEGATE_SANDBOX_CLIENT_ID`, and `CHANGEGATE_SANDBOX_CLIENT_SECRET` via the local process environment. Use a private operator password of at least 16 printable ASCII characters. Keep secrets out of checked-in files and command history. The default application origin is `http://127.0.0.1:3190`; set `CHANGEGATE_MERCHANT_ORIGIN` to the exact loopback origin if using another port. Reads can be checked before explicitly enabling the separate Sandbox execution switch `CHANGEGATE_SANDBOX_ALLOW_REFUNDS=1`. Use an eligible USD capture owned by the configured sandbox merchant. The adapter always targets the PayPal Sandbox origin.

The capture's PayPal order must name the configured merchant and contain the capture reference. Known prior refunds come from the order's refund references and independent refund GETs. Incomplete or inconsistent history blocks submission. This first slice assumes ChangeGate is the only writer for a capture during the pilot. PayPal still enforces the provider-side limit. Reconciliation checks the original refund ID, capture, amount, currency and status. Provider acceptance alone does not count as verification.

Before a possible POST, SQLite commits the attempt and holds its amount using the stable PayPal request ID. When the reply is lost, use **Reconcile original attempt**. The readback searches the original capture's refunds for the corresponding invoice and then independently fetches the refund. If discovery fails, an operator can supply the provider refund reference found in PayPal. The independent record still has to match the original invoice and capture. There is no automatic or manual second POST for the same attempt. Until there is sufficient evidence, leave the case visible and the reservation held. A documented PayPal rejection that establishes no refund was created moves the case to Failed and releases the reservation. An ambiguous error keeps it held.

Receipt export preserves decision and reconciliation history without credentials or request IDs. The offline viewer checks internal consistency. Simulation receipts identify their source as a simulated GET. **Provider verified** is reserved for a matching completed read from configured PayPal Sandbox.

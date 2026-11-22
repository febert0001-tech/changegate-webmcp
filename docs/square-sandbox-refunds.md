# Square Sandbox refund acceptance

The transaction workspace supports one configured Square Sandbox merchant and location. The adapter accepts completed USD card payments from that location. It uses the sandbox API host for every provider request. The configured ChangeGate merchant is the only workspace with access.

Set these variables in the existing staging service's secret store:

| Variable | Value |
| --- | --- |
| `CHANGEGATE_SQUARE_SANDBOX_ACCESS_TOKEN` | Authorized sandbox access token with merchant profile read and payments read/write access |
| `CHANGEGATE_SQUARE_TEAM_MERCHANT_ID` | ChangeGate merchant ID from the staging roster |
| `CHANGEGATE_SQUARE_SANDBOX_MERCHANT_ID` | Square Sandbox seller ID |
| `CHANGEGATE_SQUARE_SANDBOX_LOCATION_ID` | Location ID for that sandbox seller |

1. Create a fresh completed sandbox USD card sale with enough balance to exceed the ChangeGate manager threshold. Record the original Square payment ID and confirm that its refund list is empty.
2. As a cashier, select **Square Sandbox** in **New refund**. Find the original sale and submit a refund that reaches the store threshold. Confirm that the request is held and a fresh Square payment lookup still shows zero refunds.
3. Sign in separately as a supervisor. Verify the sale and amount on **Approval** and approve with the supervisor's own password. On **Execution**, submit the refund. Repeat the same action or recover the original attempt if a response was lost.
4. Use a fresh provider payment lookup to count refunds and use the refund endpoint to verify the single refund ID, payment ID, amount, currency and completed status. Compare the provider readback with **Receipt**. Leave a pending or uncertain case open for reconciliation.

ChangeGate blocks another refund if the payment history contains a Square refund with status `FAILED`. [Square Refunds API](https://developer.squareup.com/reference/square/refunds)

ChangeGate persists one idempotency key and the exact provider terms before the first refund call. If the provider response was lost, the local retry window allows another call with that same key through exactly 15 minutes after the original attempt. After that instant, keep the balance reserved and reconcile the original attempt in Square. Once a refund ID exists, checking its status issues only a read. Cashier use of Square's native register and phone lock-screen alerts require their own tests.

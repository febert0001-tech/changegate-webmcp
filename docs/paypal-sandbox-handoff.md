# PayPal Sandbox activation handoff

ChangeGate binds each electronic refund to its saved sale. Square sales use Square. PayPal captures use PayPal. The provider, merchant, capture, approved USD amount, and original PayPal request ID stay bound across restart. PayPal routes only to `api-m.sandbox.paypal.com`.

## Private configuration

In Railway staging, store credentials in the service's secret store. For a loopback test, inject them into the local server process. Keep credentials out of Git, the browser, receipts, command history, and logs.

| Variable | Purpose |
| --- | --- |
| `CHANGEGATE_PAYPAL_MODE` | Set to `sandbox` to enable PayPal reads. Unset or any other value disables all PayPal traffic. |
| `CHANGEGATE_PAYPAL_TEAM_MERCHANT_ID` | Existing ChangeGate merchant ID from the staging employee roster. |
| `CHANGEGATE_PAYPAL_SANDBOX_MERCHANT_ID` | PayPal Sandbox payee merchant ID. |
| `CHANGEGATE_PAYPAL_SANDBOX_CLIENT_ID` | Client ID for the sandbox app authorized for that merchant. |
| `CHANGEGATE_PAYPAL_SANDBOX_CLIENT_SECRET` | Secret for that same sandbox app. |
| `CHANGEGATE_PAYPAL_SANDBOX_ALLOW_REFUNDS` | Set to `1` only for the authorized acceptance run. Leave unset for lookup and reconciliation only. |

## Acceptance

1. In read-only mode, choose **PayPal Sandbox** under **New refund** and find a fresh merchant-owned USD capture. Check that the PayPal capture links to the named merchant's order, confirm its balance, and save a redacted provider read showing zero previous refunds. Stop if the payee or refund history is unclear.
2. Enable sandbox submissions for the run. Submit one partial refund at or above the store approval threshold and open **Approval**. A fresh provider read must still show zero refunds with the request held. Have a different signed-in supervisor confirm the exact capture and amount.
3. Execute once. Reopen the saved request after restarting the app with the same SQLite volume. If the reply was lost, use **Reconcile original attempt**. The retry reads PayPal's refund history and independently fetches the matching refund by ID. The application never sends a second PayPal refund POST for this attempt.
4. Confirm exactly one refund for the capture after retry. Match the independently fetched refund ID, capture link, amount, currency, and `COMPLETED` status to the receipt. Keep any uncertain or pending attempt open and retain its reservation. The browser's **Verified** label requires a matching completed read.
5. Unset the submission switch and keep the same staging volume. Save the redacted receipt and provider evidence in the private project record.

## Disable and recover

Unset `CHANGEGATE_PAYPAL_SANDBOX_ALLOW_REFUNDS` to stop new submissions while retaining reads. Unset `CHANGEGATE_PAYPAL_MODE` to stop all PayPal traffic. Restart the server after applying environment changes. Preserve the SQLite volume during rollback. Saved receipts, attempt terms, and reservations remain available when the provider is disabled. If PayPal omits an original invoice from the capture history, investigate the original refund in PayPal before taking any further action.

The automated provider tests use a simulated transport. A real sandbox run and production release are separate decisions.

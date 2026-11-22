import type { RefundRequest, TransactionEvent } from "../../merchant-team/refund-requests";

type Alert = { phase: number; advisory: string | null };

function detail(event: TransactionEvent, request: RefundRequest) {
  switch (event.kind) {
    case "Request submitted":
      return `Requested ${request.terms.amount} ${request.terms.currency} against ${request.terms.reference}.`;
    case "Checks recorded":
      return [event.check.explanation, ...new Set(event.check.monitoring?.reasons)].filter(Boolean).join(" ");
    case "Decision recorded":
      return event.decision;
    case "Cash payout reported":
      return "Employee reported a test cash payout.";
    case "Execution stopped":
      return event.reason;
    case "PayPal attempt recorded":
    case "Square attempt recorded":
      return "Attempt saved. Provider confirmation is pending at this step.";
    case "PayPal response unavailable":
    case "Square response unavailable":
      return "Provider outcome unknown at this step.";
    case "PayPal refund response":
    case "Square refund response":
    case "PayPal refund recovered":
      return event.refund.status ?? "Refund reference received. Status unavailable.";
    case "Square independent lookup":
    case "PayPal independent lookup":
      return [event.result, event.refund?.status,
        event.refund && `${(event.refund.amountCents / 100).toFixed(2)} ${event.refund.currency}`].filter(Boolean).join(" · ");
  }
}

export function RefundHistory({ request, alerts }: { request: RefundRequest; alerts: Alert[] }) {
  const advisories = alerts.filter(alert => alert.advisory?.trim());
  return <section aria-label="Transaction history">
    <h3>Transaction history</h3>
    <ol>{request.events.map((event, index) => <li key={index}>
      <strong>{event.kind}</strong>
      <p>{detail(event, request)}</p>
      <small>{event.actor} · <time dateTime={event.occurredAt}>{event.occurredAt.replace("T", " ").replace(/\.\d+Z$/, "Z")}</time></small>
    </li>)}</ol>
    {advisories.length > 0 && <details>
      <summary>Saved AI explanation</summary>
      {advisories.map(alert => <p key={alert.phase}><strong>{alert.phase === 0 ? "Primary" : "Backup"} alert</strong> · {alert.advisory}</p>)}
    </details>}
  </section>;
}

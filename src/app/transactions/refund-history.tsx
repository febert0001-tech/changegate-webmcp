import { requestReceipt, type RefundRequest, type TransactionEvent } from "../../merchant-team/refund-requests";
import styles from "../merchant/merchant.module.css";

type Alert = { phase: number; advisory: string | null };

function detail(event: TransactionEvent, request: RefundRequest) {
  switch (event.kind) {
    case "Request submitted":
      return `Requested ${request.terms.amount} ${request.terms.currency} against ${request.terms.reference}.`;
    case "Checks recorded":
      return null;
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
  const receipt = requestReceipt(request);
  const lastCheck = request.events.findLastIndex(event => event.kind === "Checks recorded");
  const outcome = receipt.verification.status === "Verified" ? "Provider independently verified the refund" : receipt.execution.status;
  const decision = receipt.decision.status;
  const outcomeLabel = outcome === "Not submitted" && (decision === "Approved" || decision === "Rejected")
    ? `${decision} / Not submitted` : outcome;
  return <section aria-label="Transaction history" className={styles.history}>
    <h3>Transaction history</h3>
    <ol>
      {request.events.map((event, index) => <li key={index}>
        <div><strong>{event.kind}</strong>
          <span>{event.actor} · <time dateTime={event.occurredAt}>{event.occurredAt.replace("T", " ").replace(/\.\d+Z$/, "Z")}</time></span></div>
        {event.kind === "Checks recorded" ? <>
          <p>{event.check.explanation}</p>
          {[...new Set(event.check.monitoring?.reasons)].filter(reason => reason !== event.check.explanation)
            .map(reason => <p key={reason}>{reason}</p>)}
          {index === lastCheck && advisories.length > 0 && <div className={styles.comparisonFile}>
            <strong>Saved AI explanation</strong>
            {advisories.map(alert => <p key={alert.phase}>{alert.advisory}</p>)}
          </div>}
        </> : <p>{detail(event, request)}</p>}
      </li>)}
      <li>
        <strong>Recorded payment outcome</strong>
        <p>{outcomeLabel}</p>
      </li>
    </ol>
  </section>;
}

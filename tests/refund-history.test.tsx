import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RefundHistory } from "../src/app/transactions/refund-history";
import type { RefundRequest } from "../src/merchant-team/refund-requests";

const occurredAt = "2026-11-22T19:30:00.000Z";
const request: RefundRequest = {
  id: "example", terms: { reference: "sale-75", amount: "50.00", currency: "USD", reason: "Return" }, sale: null,
  events: [
    { kind: "Request submitted", actor: "maya", occurredAt },
    { kind: "Checks recorded", actor: "policy", occurredAt, check: {
      balanceCents: 7500, cumulativeCents: 5000, thresholdCents: 5000, route: "manager", explanation: "Reached the store threshold.",
    } },
    { kind: "Decision recorded", actor: "jordan", occurredAt, decision: "Approved" },
  ],
};

describe("receipt history", () => {
  it("uses the saved order for simultaneous events and preserves a human decision without inferring execution", () => {
    const html = renderToStaticMarkup(<RefundHistory request={request} alerts={[]}/>);
    expect(html.indexOf("Reached the store threshold.")).toBeGreaterThan(html.indexOf("maya"));
    expect(html.indexOf("Approved")).toBeGreaterThan(html.indexOf("Reached the store threshold."));
    expect(html).toContain("jordan");
    expect(html).not.toMatch(/Saved AI explanation|COMPLETED|independent lookup/i);
  });

  it("shows a lost response followed by independent evidence and escapes saved advisory text", () => {
    const html = renderToStaticMarkup(<RefundHistory request={{ ...request, events: [...request.events,
      { kind: "Square response unavailable", actor: "worker", occurredAt },
      { kind: "Square independent lookup", actor: "worker", occurredAt, result: "Verified",
        refund: { id: "refund-1", paymentId: "sale-75", currency: "USD", amountCents: 5000, status: "COMPLETED" } },
    ] }} alerts={[{phase: 0, advisory: "<test>"}]}/>);
    expect(html).toContain("Provider outcome unknown");
    expect(html).toContain("Verified · COMPLETED · 50.00 USD");
    expect(html).toContain("&lt;test&gt;");
  });
});

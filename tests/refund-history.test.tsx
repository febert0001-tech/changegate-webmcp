import { Window } from "happy-dom";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RefundHistory } from "../src/app/transactions/refund-history";
import { TransactionWorkspace } from "../src/app/transactions/transaction-workspace";
import type { TeamCommand } from "../src/merchant-team/contracts";
import type { RefundRequest, TransactionStep } from "../src/merchant-team/refund-requests";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

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
    expect(html).toContain("Approved / Not submitted");
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

describe("receipt payment state", () => {
  const square: RefundRequest = {
    ...request,
    sale: {
      reference: "sale-75", location: "Harbor Fuel", register: "Register 1", shift: "Evening",
      originalCents: 7500, priorCents: 0, tender: "Electronic",
      square: { merchantId: "test-merchant", locationId: "test-location" },
    },
  };

  async function view(record: RefundRequest, step: TransactionStep = "receipt", role: "cashier" | "manager" = "cashier") {
    const dom = new Window({ url: "http://localhost:3193" });
    vi.stubGlobal("window", dom);
    vi.stubGlobal("self", dom);
    vi.stubGlobal("document", dom.document);
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const root = createRoot(document.body.appendChild(document.createElement("div")));
    const send = async <T,>(command: TeamCommand): Promise<T> => {
      if (command.action === "openRefundRequest") return record as T;
      if (command.action === "refundAlertStatus") return [] as T;
      throw Error(`Unexpected action: ${command.action}`);
    };
    try {
      await act(async () => root.render(<TransactionWorkspace destination={{ id: record.id, step }}
        session={{ sessionVersion: "local-test", username: role === "manager" ? "jordan" : "maya",
          name: role === "manager" ? "Jordan Lee" : "Maya Chen", merchantName: "Harbor Goods",
          role, demoShift: true, coworkers: [] }} send={send} onSessionError={() => false} />));
      return {
        summary: document.querySelector('[aria-label="Refund status and next action"]')?.textContent,
        body: document.body.textContent,
        buttons: Array.from(document.querySelectorAll("button"), button => button.textContent),
      };
    } finally {
      await act(async () => root.unmount());
      vi.unstubAllGlobals();
      await dom.happyDOM.close();
    }
  }

  it("shows zero confirmed payout and no action only when the approved demo has no submission path", async () => {
    const { summary } = await view(request);
    expect(summary).toContain("Approved / Not submitted");
    expect(summary).toContain("Confirmed payout$0.00");
    expect(summary).toContain("No action needed. Payment submission is disabled in this demo.");
    expect(summary).toContain("Your refund was approved. It hasn’t been sent for payment.");
  });

  it("tells the cashier the request was sent and closes cashier action after rejection", async () => {
    const waiting = { ...request, events: request.events.slice(0, -1) };
    const held = await view(waiting, "approval");
    expect(held.summary).toContain("Waiting for supervisor review");
    expect(held.summary).toContain("You sent the request for review.");
    expect(held.summary).toContain("No refund has been paid yet.");
    expect(held.buttons).not.toContain("Approve");
    expect(held.buttons).not.toContain("Reject");

    const rejected = await view({ ...waiting, events: [...waiting.events,
      { kind: "Decision recorded", actor: "Jordan Lee", occurredAt, decision: "Rejected" },
    ] });
    expect(rejected.summary).toContain("Current step · Receipt");
    expect(rejected.summary).toContain("This request is closed.");
    expect(rejected.summary).toContain("A supervisor declined your refund request. No refund was paid.");
  });

  it("keeps the rejection and shows no payment action", async () => {
    const rejected: RefundRequest = { ...square, events: [...square.events.slice(0, -1),
      { kind: "Decision recorded", actor: "Jordan Lee", occurredAt, decision: "Rejected" },
    ] };
    const receipt = await view(rejected);
    expect(receipt.body).toContain("Rejected by Jordan Lee");
    expect(receipt.summary).toContain("No payout action is available");
    expect((await view(rejected, "execution")).buttons).not.toContain("Execute Square Sandbox refund");
  });

  it.each(["Approved", "Rejected"] as const)("shows the saved %s decision when a supervisor opens the approval link late", async decision => {
    const decided: RefundRequest = { ...request, events: [...request.events.slice(0, -1),
      { kind: "Decision recorded", actor: "Backup Supervisor", occurredAt, decision },
    ] };
    const { summary, buttons } = await view(decided, "approval", "manager");
    expect(summary).toContain(decision + " by Backup Supervisor");
    expect(summary).toContain("Current step · Receipt");
    if (decision === "Approved") {
      expect(summary).toContain("Approved / Not submitted");
      expect(summary).toContain("Confirmed payout$0.00");
    } else {
      expect(summary).toContain("This request is closed.");
      expect(summary).toContain("No payout recorded");
    }
    expect(buttons).not.toContain("Approve");
    expect(buttons).not.toContain("Reject");
  });

  it("tells the operator to submit an approved refund when submission is available", async () => {
    const { summary } = await view(square);
    expect(summary).toContain("Execute the refund in Square Sandbox.");
    expect(summary).not.toContain("No action needed");
    expect((await view(square, "execution")).buttons).toContain("Execute Square Sandbox refund");
  });

  it("leaves an attempted refund with a missing response unconfirmed", async () => {
    const { summary, body } = await view({ ...square, events: [...square.events,
      { kind: "Square attempt recorded", actor: "maya", occurredAt },
      { kind: "Square response unavailable", actor: "maya", occurredAt },
    ] });
    expect(summary).toContain("Sandbox outcome unconfirmed");
    expect(body).toContain("Provider outcome unknown");
    expect(summary).not.toContain("Confirmed payout");
    expect(summary).not.toContain("No action needed");
  });
});

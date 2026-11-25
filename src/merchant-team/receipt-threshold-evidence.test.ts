import { describe, expect, it } from "vitest";
import { receiptThresholdEvidence, type RefundPolicyHistory } from "./refund-threshold-preview";
import type { RefundRequest } from "./refund-requests";

const applied = {
  id: "lowered", location: "Harbor Fuel", actor: "Avery Chen",
  effectiveAt: "2026-11-25T20:00:00.000Z", oldCents: 5000, newCents: 3600,
};
const restored = {
  ...applied, id: "restored", effectiveAt: "2026-11-25T20:30:00.000Z", oldCents: 3600, newCents: 5000,
};
const policy: RefundPolicyHistory = { thresholdCents: 5000, changes: [restored, applied] };
const held: RefundRequest = {
  id: "held", terms: { reference: "TEST-MONITOR-5", amount: "36.00", currency: "USD", reason: "Synthetic check" },
  sale: null,
  events: [{
    kind: "Checks recorded", actor: "ChangeGate", occurredAt: "2026-11-25T20:15:00.000Z",
    check: { route: "manager", thresholdCents: 3600, cumulativeCents: 3600, balanceCents: 25000, explanation: "Threshold met." },
  }],
};

describe("receipt threshold evidence", () => {
  it("uses the first saved check and the change in force at the time", () => {
    const request: RefundRequest = { ...held, events: [...held.events, {
      kind: "Checks recorded", actor: "ChangeGate", occurredAt: "2026-11-25T20:40:00.000Z",
      check: { route: "routine", thresholdCents: 5000, cumulativeCents: 3600, balanceCents: 25000, explanation: "Later recheck." },
    }] };

    expect(receiptThresholdEvidence(request, policy)).toEqual({ thresholdCents: 3600, change: applied });
  });

  it("preserves available facts when the audit record cannot establish attribution", () => {
    expect(receiptThresholdEvidence(held, { ...policy, changes: [restored] }))
      .toEqual({ thresholdCents: 3600, change: undefined });
    expect(receiptThresholdEvidence(held, { ...policy, changes: [
      restored, { ...applied, effectiveAt: held.events[0]!.occurredAt },
    ] })).toEqual({ thresholdCents: 3600 });
    expect(receiptThresholdEvidence({ ...held, events: [] }, policy)).toEqual({ thresholdCents: undefined });
  });
});

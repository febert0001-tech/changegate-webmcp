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
  it("preserves the original hold when a later check is routine", () => {
    const request: RefundRequest = { ...held, events: [...held.events, {
      kind: "Checks recorded", actor: "ChangeGate", occurredAt: "2026-11-25T20:40:00.000Z",
      check: { route: "routine", thresholdCents: 5000, cumulativeCents: 3600, balanceCents: 25000, explanation: "Later recheck." },
    }] };

    expect(receiptThresholdEvidence(request, policy)).toEqual({ thresholdCents: 3600, whenHeld: true, change: applied });
  });

  it("attributes a later hold to its own check after the policy is restored", () => {
    const routine: RefundRequest["events"][number] = {
      kind: "Checks recorded", actor: "ChangeGate", occurredAt: "2026-11-25T19:55:00.000Z",
      check: { route: "routine", thresholdCents: 5000, cumulativeCents: 3600, balanceCents: 25000, explanation: "Within store policy." },
    };
    const request = { ...held, events: [routine, ...held.events] };
    const saved = structuredClone(request.events);

    expect(receiptThresholdEvidence(request, policy)).toEqual({ thresholdCents: 3600, whenHeld: true, change: applied });
    expect(request.events).toEqual(saved);
  });

  it("preserves available facts when the audit record cannot establish attribution", () => {
    expect(receiptThresholdEvidence(held, { ...policy, changes: [restored] }))
      .toEqual({ thresholdCents: 3600, whenHeld: true, change: undefined });
    expect(receiptThresholdEvidence(held, { ...policy, changes: [
      restored, { ...applied, effectiveAt: held.events[0]!.occurredAt },
    ] })).toEqual({ thresholdCents: 3600, whenHeld: true });
    expect(receiptThresholdEvidence({ ...held, events: [] }, policy)).toEqual({ thresholdCents: undefined, whenHeld: false });
  });

  it("does not attribute a seeded replay check to an audit entry based on its fictional time", () => {
    const replay: RefundRequest = { ...held, sale: {
      reference: held.terms.reference, location: "Harbor Fuel", register: "Register 1", shift: "Demo shift",
      originalCents: 25000, priorCents: 0, tender: "Electronic",
    } };

    expect(receiptThresholdEvidence(replay, policy)).toEqual({ thresholdCents: 3600, whenHeld: true });
  });
});

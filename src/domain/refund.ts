import type { ImmutableChangeProposal, RefundProposalInput } from "./change/contracts";

// Trusted scenario facts, never supplied by an execution caller.
const POLICY_MAXIMUM_CENTS = 3000;
const ORDER_AMOUNT_CENTS = 12900;

/** Narrow normalized content without changing its fields or canonical bytes. */
export function hasRefundProposalShape(
  proposal: Omit<ImmutableChangeProposal, "proposalDigest">,
): proposal is RefundProposalInput {
  return (
    proposal.target === "order:4821" &&
    proposal.action === "SYNTHETIC_PARTIAL_REFUND" &&
    Object.keys(proposal.parameters).length === 2 &&
    proposal.parameters.currency === "USD" &&
    typeof proposal.parameters.amountCents === "number" &&
    proposal.preconditions.length === 1 &&
    proposal.preconditions[0] === "order:4821 refunded amount is 0 cents"
  );
}

export function isAuthorizedRefundProposal(proposal: ImmutableChangeProposal): boolean {
  if (!hasRefundProposalShape(proposal)) return false;
  const amount = proposal.parameters.amountCents;
  return Number.isSafeInteger(amount) && amount > 0 &&
    amount <= POLICY_MAXIMUM_CENTS && amount <= ORDER_AMOUNT_CENTS;
}

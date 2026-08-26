import type { ServiceId } from "../scenario/types";

export type ChangeLifecycleState =
  | "PROPOSED"
  | "AWAITING_HUMAN_APPROVAL"
  | "REJECTED"
  | "EXPIRED"
  | "APPROVED"
  | "EXECUTING"
  | "VERIFYING"
  | "SUCCEEDED"
  | "FAILED"
  | "ROLLBACK_AWAITING_APPROVAL"
  | "ROLLING_BACK"
  | "ROLLED_BACK"
  | "ROLLBACK_FAILED";

export interface ChangeProposalInput {
  readonly proposalId: string;
  readonly target: ServiceId;
  readonly action: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly preconditions: readonly string[];
}

export interface ImmutableChangeProposal extends ChangeProposalInput {
  /** Computed only by trusted domain code from the canonical proposal fields. */
  readonly proposalDigest: string;
}

/** A future approval binds one human decision to exactly one immutable proposal. */
export interface HumanApproval {
  readonly approvalId: string;
  readonly proposalId: string;
  readonly proposalDigest: string;
  readonly target: ServiceId;
  readonly action: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly preconditions: readonly string[];
  readonly issuedBy: "HUMAN";
  readonly status: "ACTIVE" | "CONSUMED" | "INVALIDATED" | "EXPIRED" | "REJECTED";
}

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

export type JsonPrimitive = null | boolean | number | string;

export type JsonValue = JsonPrimitive | readonly JsonValue[] | JsonObject;

export interface JsonObject {
  readonly [key: string]: JsonValue;
}

export interface ChangeProposalInput {
  readonly proposalId: string;
  readonly target: ServiceId;
  readonly action: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly preconditions: readonly string[];
}

export interface ImmutableChangeProposal {
  readonly proposalId: string;
  readonly target: ServiceId;
  readonly action: string;
  readonly parameters: JsonObject;
  readonly preconditions: readonly string[];
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
  readonly parameters: JsonObject;
  readonly preconditions: readonly string[];
  readonly issuedBy: "HUMAN";
  readonly status: "ACTIVE" | "CONSUMED" | "INVALIDATED" | "EXPIRED" | "REJECTED";
}

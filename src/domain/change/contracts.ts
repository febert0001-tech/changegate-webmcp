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

export interface GatewayProposalInput {
  readonly proposalId: string;
  readonly target: ServiceId;
  readonly action: string;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly preconditions: readonly string[];
}

export interface ImmutableGatewayProposal {
  readonly proposalId: string;
  readonly target: ServiceId;
  readonly action: string;
  readonly parameters: JsonObject;
  readonly preconditions: readonly string[];
  /** Computed only by trusted domain code from the canonical proposal fields. */
  readonly proposalDigest: string;
}

export interface RefundProposalInput {
  readonly proposalId: string;
  readonly target: "order:4821";
  readonly action: "SYNTHETIC_PARTIAL_REFUND";
  readonly parameters: Readonly<{ currency: "USD"; amountCents: number }>;
  readonly preconditions: readonly ["order:4821 refunded amount is 0 cents"];
}

export interface ImmutableRefundProposal extends RefundProposalInput {
  readonly proposalDigest: string;
}

export type ChangeProposalInput = GatewayProposalInput | RefundProposalInput;
export type ImmutableChangeProposal = ImmutableGatewayProposal | ImmutableRefundProposal;
export type ChangeTarget = ImmutableChangeProposal["target"];

/** One human decision bound to the exact immutable proposal and review lifecycle. */
export type HumanApproval = ImmutableChangeProposal & {
  readonly approvalId: string;
  readonly reviewInstanceId: string;
  readonly issuedBy: "HUMAN";
  readonly status: "ACTIVE" | "CONSUMED" | "INVALIDATED" | "EXPIRED" | "REJECTED";
};

export interface RefundExecutionIdentity {
  readonly executionId: string;
}

export interface RefundExecutionBinding extends RefundExecutionIdentity {
  readonly proposalId: string;
  readonly proposalDigest: string;
  readonly reviewInstanceId: string;
  readonly approvalId: string;
  readonly effect: Readonly<{
    operation: "SYNTHETIC_PARTIAL_REFUND";
    orderId: "4821";
    currency: "USD";
    amountCents: number;
  }>;
}

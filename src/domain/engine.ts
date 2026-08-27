import { CANONICAL_SCENARIO } from "./scenario/canonical-scenario";
import type { CanonicalService } from "./scenario/types";
import type {
  ChangeLifecycleState,
  ChangeProposalInput,
  HumanApproval,
  ImmutableChangeProposal,
  ImmutableRefundProposal,
  RefundExecutionBinding,
  RefundExecutionIdentity,
} from "./change/contracts";
import { computeProposalDigest, createImmutableProposal } from "./change/proposal-digest";
import { isAuthorizedRefundProposal } from "./refund";

export type AuditActor = "HUMAN" | "AGENT" | "SYSTEM";

export interface AuditEvent {
  readonly sequence: number;
  readonly actor: AuditActor;
  readonly type: string;
  readonly lifecycle: ChangeLifecycleState | "NONE";
}

export interface EnvironmentState {
  readonly services: readonly CanonicalService[];
}

interface ProposalState {
  readonly proposal: ImmutableChangeProposal;
}

interface AwaitingHumanApprovalState extends ProposalState {
  readonly reviewInstanceId: string;
}

interface ApprovedState extends AwaitingHumanApprovalState {
  readonly approval: HumanApproval;
}

interface ExecutionState extends ApprovedState {
  readonly executionKind: "GATEWAY";
  readonly preChangeSnapshot: EnvironmentState;
}

interface RefundExecutionState extends ApprovedState {
  readonly executionKind: "REFUND";
  readonly proposal: ImmutableRefundProposal;
  readonly refundExecution: RefundExecutionBinding;
}

interface RefundFailedState extends RefundExecutionState {
  readonly failureStage: "EXECUTION";
}

interface FailedState extends AwaitingHumanApprovalState {
  readonly executionKind: "GATEWAY";
  readonly failureStage: "EXECUTION" | "VERIFICATION";
  readonly preChangeSnapshot: EnvironmentState;
}

interface RollbackAwaitingApprovalState extends FailedState {
  readonly rollbackApproval?: HumanApproval;
}

interface RollingBackState extends FailedState {
  readonly rollbackApproval: HumanApproval;
}

export type ChangeLifecycle =
  | ({ readonly status: "PROPOSED" } & ProposalState)
  | ({ readonly status: "AWAITING_HUMAN_APPROVAL" } & AwaitingHumanApprovalState)
  | ({ readonly status: "REJECTED" } & ProposalState)
  | ({ readonly status: "EXPIRED" } & ProposalState)
  | ({ readonly status: "APPROVED" } & ApprovedState)
  | ({ readonly status: "EXECUTING" } & (ExecutionState | RefundExecutionState))
  | ({ readonly status: "VERIFYING" } & (ExecutionState | RefundExecutionState))
  | ({ readonly status: "SUCCEEDED" } & ApprovedState)
  | ({ readonly status: "FAILED" } & (FailedState | RefundFailedState))
  | ({ readonly status: "ROLLBACK_AWAITING_APPROVAL" } & RollbackAwaitingApprovalState)
  | ({ readonly status: "ROLLING_BACK" } & RollingBackState)
  | ({ readonly status: "ROLLED_BACK" } & FailedState)
  | ({ readonly status: "ROLLBACK_FAILED" } & FailedState);

export interface ChangeGateState {
  readonly environment: EnvironmentState;
  readonly change: ChangeLifecycle | null;
  readonly audit: readonly AuditEvent[];
  readonly nextSequence: number;
  readonly nextReviewInstance: number;
}

export type DomainAction =
  | { readonly type: "PROPOSE_CHANGE"; readonly actor: "HUMAN" | "AGENT"; readonly proposal: ChangeProposalInput }
  | {
      readonly type: "REQUEST_HUMAN_APPROVAL";
      readonly actor: "HUMAN" | "AGENT";
      readonly proposalId: string;
    }
  | {
      readonly type: "HUMAN_APPROVE";
      readonly proposalId: string;
      readonly proposalDigest: string;
      readonly reviewInstanceId: string;
      readonly approvalId: string;
    }
  | {
      readonly type: "HUMAN_REJECT";
      readonly proposalId: string;
      readonly proposalDigest: string;
      readonly reviewInstanceId: string;
    }
  | { readonly type: "EXPIRE_PROPOSAL" }
  | { readonly type: "BEGIN_EXECUTION" }
  | {
      readonly type: "BEGIN_REFUND_EXECUTION";
      readonly expectedProposalId: string;
      readonly expectedProposalDigest: string;
      readonly expectedReviewInstanceId: string;
      readonly expectedApprovalId: string;
    }
  | ({ readonly type: "REFUND_EXECUTION_SUCCEEDED" } & RefundExecutionIdentity)
  | ({ readonly type: "REFUND_EXECUTION_FAILED" } & RefundExecutionIdentity)
  // Refund verification completion requires independent evidence in a later unit.
  // There is deliberately no identity-only verification-success action.
  | { readonly type: "EXECUTION_SUCCEEDED" }
  | { readonly type: "EXECUTION_FAILED" }
  | { readonly type: "VERIFICATION_SUCCEEDED" }
  | { readonly type: "VERIFICATION_FAILED" }
  | { readonly type: "REQUEST_ROLLBACK_APPROVAL"; readonly actor: "HUMAN" | "AGENT" }
  | { readonly type: "HUMAN_APPROVE_ROLLBACK"; readonly approvalId: string }
  | { readonly type: "BEGIN_ROLLBACK" }
  | { readonly type: "ROLLBACK_SUCCEEDED" }
  | { readonly type: "ROLLBACK_FAILED" }
  | { readonly type: "RESET_SCENARIO" };

export interface DomainTransitionError {
  readonly code: "ILLEGAL_TRANSITION";
  readonly action: DomainAction["type"];
  readonly currentState: ChangeLifecycleState | "NONE";
}

export type DomainTransitionResult =
  | { readonly ok: true; readonly state: ChangeGateState }
  | { readonly ok: false; readonly error: DomainTransitionError };

function cloneEnvironment(): EnvironmentState {
  return Object.freeze({
    services: Object.freeze(
      CANONICAL_SCENARIO.services.map((service) => Object.freeze({ ...service })),
    ),
  });
}

function cloneSnapshot(environment: EnvironmentState): EnvironmentState {
  return Object.freeze({
    services: Object.freeze(environment.services.map((service) => Object.freeze({ ...service }))),
  });
}

function createApproval(approvalId: string, proposal: ImmutableChangeProposal, reviewInstanceId: string): HumanApproval {
  return Object.freeze({
    ...proposal,
    approvalId,
    reviewInstanceId,
    issuedBy: "HUMAN",
    status: "ACTIVE",
  });
}

function consumed(approval: HumanApproval): HumanApproval {
  return Object.freeze({ ...approval, status: "CONSUMED" });
}

export function isApprovalBoundToProposal(approval: HumanApproval, proposal: ImmutableChangeProposal): boolean {
  const trustedProposalDigest = computeProposalDigest(proposal);
  const approvalContentDigest = computeProposalDigest(approval);

  return (
    approval.issuedBy === "HUMAN" &&
    approval.status === "ACTIVE" &&
    approval.proposalId === proposal.proposalId &&
    proposal.proposalDigest === trustedProposalDigest &&
    approval.proposalDigest === proposal.proposalDigest &&
    approvalContentDigest === trustedProposalDigest &&
    approval.target === proposal.target &&
    approval.action === proposal.action
  );
}

function appendAudit(
  state: ChangeGateState,
  actor: AuditActor,
  type: string,
  lifecycle: ChangeLifecycleState | "NONE",
): Pick<ChangeGateState, "audit" | "nextSequence"> {
  return {
    audit: [...state.audit, { sequence: state.nextSequence, actor, type, lifecycle }],
    nextSequence: state.nextSequence + 1,
  };
}

function success(
  state: ChangeGateState,
  change: ChangeLifecycle | null,
  actor: AuditActor,
  eventType: string,
  environment: EnvironmentState = state.environment,
): DomainTransitionResult {
  return {
    ok: true,
    state: {
      ...state,
      environment,
      change,
      ...appendAudit(state, actor, eventType, change?.status ?? "NONE"),
    },
  };
}

function illegal(state: ChangeGateState, action: DomainAction): DomainTransitionResult {
  return {
    ok: false,
    error: {
      code: "ILLEGAL_TRANSITION",
      action: action.type,
      currentState: state.change?.status ?? "NONE",
    },
  };
}

function canReset(change: ChangeLifecycle | null): boolean {
  return (
    change === null ||
    (change.status !== "EXECUTING" &&
      change.status !== "VERIFYING" &&
      change.status !== "ROLLING_BACK")
  );
}

export function createInitialState(): ChangeGateState {
  return {
    environment: cloneEnvironment(),
    change: null,
    audit: [],
    nextSequence: 1,
    nextReviewInstance: 1,
  };
}

export function reduceChangeGate(state: ChangeGateState, action: DomainAction): DomainTransitionResult {
  const change = state.change;

  if (action.type === "RESET_SCENARIO") {
    if (!canReset(change)) return illegal(state, action);

    return {
      ok: true,
      state: {
        environment: cloneEnvironment(),
        change: null,
        audit: [{ sequence: 1, actor: "SYSTEM", type: "SCENARIO_RESET", lifecycle: "NONE" }],
        nextSequence: 2,
        nextReviewInstance: state.nextReviewInstance,
      },
    };
  }

  switch (action.type) {
    case "PROPOSE_CHANGE":
      return change === null
        ? success(state, { status: "PROPOSED", proposal: createImmutableProposal(action.proposal) }, action.actor, action.type)
        : illegal(state, action);
    case "REQUEST_HUMAN_APPROVAL":
      return change?.status === "PROPOSED" &&
        action.proposalId === change.proposal.proposalId &&
        Number.isSafeInteger(state.nextReviewInstance) &&
        state.nextReviewInstance > 0 &&
        state.nextReviewInstance < Number.MAX_SAFE_INTEGER
        ? success(
            { ...state, nextReviewInstance: state.nextReviewInstance + 1 },
            {
              status: "AWAITING_HUMAN_APPROVAL",
              proposal: change.proposal,
              reviewInstanceId: `human-review:${state.nextReviewInstance}`,
            },
            action.actor,
            action.type,
          )
        : illegal(state, action);
    case "HUMAN_APPROVE":
      return change?.status === "AWAITING_HUMAN_APPROVAL" &&
        action.proposalId === change.proposal.proposalId &&
        action.proposalDigest === change.proposal.proposalDigest &&
        action.reviewInstanceId === change.reviewInstanceId
        ? success(state, { status: "APPROVED", proposal: change.proposal, reviewInstanceId: change.reviewInstanceId, approval: createApproval(action.approvalId, change.proposal, change.reviewInstanceId) }, "HUMAN", action.type)
        : illegal(state, action);
    case "HUMAN_REJECT":
      return change?.status === "AWAITING_HUMAN_APPROVAL" &&
        action.proposalId === change.proposal.proposalId &&
        action.proposalDigest === change.proposal.proposalDigest &&
        action.reviewInstanceId === change.reviewInstanceId
        ? success(state, { status: "REJECTED", proposal: change.proposal }, "HUMAN", action.type)
        : illegal(state, action);
    case "EXPIRE_PROPOSAL":
      return change?.status === "AWAITING_HUMAN_APPROVAL"
        ? success(state, { status: "EXPIRED", proposal: change.proposal }, "SYSTEM", action.type)
        : illegal(state, action);
    case "BEGIN_EXECUTION":
      return change?.status === "APPROVED" && change.proposal.target !== "order:4821" && isApprovalBoundToProposal(change.approval, change.proposal)
        ? success(state, { ...change, status: "EXECUTING", executionKind: "GATEWAY", approval: consumed(change.approval), preChangeSnapshot: cloneSnapshot(state.environment) }, "SYSTEM", action.type)
        : illegal(state, action);
    case "BEGIN_REFUND_EXECUTION": {
      if (
        change?.status !== "APPROVED" ||
        change.proposal.target !== "order:4821" ||
        !isAuthorizedRefundProposal(change.proposal) ||
        !isApprovalBoundToProposal(change.approval, change.proposal) ||
        change.approval.reviewInstanceId !== change.reviewInstanceId ||
        action.expectedProposalId !== change.proposal.proposalId ||
        action.expectedProposalDigest !== change.proposal.proposalDigest ||
        action.expectedReviewInstanceId !== change.reviewInstanceId ||
        action.expectedApprovalId !== change.approval.approvalId ||
        Reflect.ownKeys(action).length !== 5 ||
        Reflect.ownKeys(action).some((key) => ![
          "type", "expectedProposalId", "expectedProposalDigest", "expectedReviewInstanceId", "expectedApprovalId",
        ].includes(String(key)))
      ) return illegal(state, action);

      const refundExecution: RefundExecutionBinding = Object.freeze({
        executionId: JSON.stringify(["refund-execution-v1", change.reviewInstanceId, change.approval.approvalId]),
        proposalId: change.proposal.proposalId,
        proposalDigest: change.proposal.proposalDigest,
        reviewInstanceId: change.reviewInstanceId,
        approvalId: change.approval.approvalId,
        effect: Object.freeze({
          operation: change.proposal.action,
          orderId: "4821",
          currency: change.proposal.parameters.currency,
          amountCents: change.proposal.parameters.amountCents,
        }),
      });
      return success(state, {
        ...change,
        status: "EXECUTING",
        executionKind: "REFUND",
        proposal: change.proposal,
        approval: consumed(change.approval),
        refundExecution,
      }, "SYSTEM", action.type);
    }
    case "REFUND_EXECUTION_SUCCEEDED":
      return change?.status === "EXECUTING" && change.executionKind === "REFUND" &&
        action.executionId === change.refundExecution.executionId
        ? success(state, { ...change, status: "VERIFYING" }, "SYSTEM", action.type)
        : illegal(state, action);
    case "REFUND_EXECUTION_FAILED":
      return change?.status === "EXECUTING" && change.executionKind === "REFUND" &&
        action.executionId === change.refundExecution.executionId
        ? success(state, { ...change, status: "FAILED", failureStage: "EXECUTION" }, "SYSTEM", action.type)
        : illegal(state, action);
    case "EXECUTION_SUCCEEDED":
      return change?.status === "EXECUTING" && change.executionKind === "GATEWAY"
        ? success(state, { ...change, status: "VERIFYING" }, "SYSTEM", action.type)
        : illegal(state, action);
    case "EXECUTION_FAILED":
      return change?.status === "EXECUTING" && change.executionKind === "GATEWAY"
        ? success(state, { status: "FAILED", executionKind: "GATEWAY", proposal: change.proposal, reviewInstanceId: change.reviewInstanceId, failureStage: "EXECUTION", preChangeSnapshot: change.preChangeSnapshot }, "SYSTEM", action.type)
        : illegal(state, action);
    case "VERIFICATION_SUCCEEDED":
      return change?.status === "VERIFYING" && change.executionKind === "GATEWAY"
        ? success(state, { status: "SUCCEEDED", proposal: change.proposal, reviewInstanceId: change.reviewInstanceId, approval: change.approval }, "SYSTEM", action.type)
        : illegal(state, action);
    case "VERIFICATION_FAILED":
      return change?.status === "VERIFYING" && change.executionKind === "GATEWAY"
        ? success(state, { status: "FAILED", executionKind: "GATEWAY", proposal: change.proposal, reviewInstanceId: change.reviewInstanceId, failureStage: "VERIFICATION", preChangeSnapshot: change.preChangeSnapshot }, "SYSTEM", action.type)
        : illegal(state, action);
    case "REQUEST_ROLLBACK_APPROVAL":
      return change?.status === "FAILED" && change.executionKind === "GATEWAY"
        ? success(state, { ...change, status: "ROLLBACK_AWAITING_APPROVAL" }, action.actor, action.type)
        : illegal(state, action);
    case "HUMAN_APPROVE_ROLLBACK":
      return change?.status === "ROLLBACK_AWAITING_APPROVAL" && change.rollbackApproval === undefined
        ? success(state, { ...change, rollbackApproval: createApproval(action.approvalId, change.proposal, change.reviewInstanceId) }, "HUMAN", action.type)
        : illegal(state, action);
    case "BEGIN_ROLLBACK":
      return change?.status === "ROLLBACK_AWAITING_APPROVAL" &&
        change.rollbackApproval !== undefined &&
        isApprovalBoundToProposal(change.rollbackApproval, change.proposal)
        ? success(state, { ...change, status: "ROLLING_BACK", rollbackApproval: consumed(change.rollbackApproval) }, "SYSTEM", action.type)
        : illegal(state, action);
    case "ROLLBACK_SUCCEEDED":
      return change?.status === "ROLLING_BACK"
        ? success(state, { status: "ROLLED_BACK", executionKind: "GATEWAY", proposal: change.proposal, reviewInstanceId: change.reviewInstanceId, failureStage: change.failureStage, preChangeSnapshot: change.preChangeSnapshot }, "SYSTEM", action.type, change.preChangeSnapshot)
        : illegal(state, action);
    case "ROLLBACK_FAILED":
      return change?.status === "ROLLING_BACK"
        ? success(state, { status: "ROLLBACK_FAILED", executionKind: "GATEWAY", proposal: change.proposal, reviewInstanceId: change.reviewInstanceId, failureStage: change.failureStage, preChangeSnapshot: change.preChangeSnapshot }, "SYSTEM", action.type)
        : illegal(state, action);
  }
}

import { CANONICAL_SCENARIO } from "./scenario/canonical-scenario";
import type { CanonicalService } from "./scenario/types";
import type {
  ChangeLifecycleState,
  ChangeProposalInput,
  HumanApproval,
  ImmutableChangeProposal,
} from "./change/contracts";
import { createImmutableProposal } from "./change/proposal-digest";

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

interface ApprovedState extends ProposalState {
  readonly approval: HumanApproval;
}

interface ExecutionState extends ApprovedState {
  readonly preChangeSnapshot: EnvironmentState;
}

interface FailedState extends ProposalState {
  readonly failureStage: "EXECUTION" | "VERIFICATION";
}

interface RollbackAwaitingApprovalState extends FailedState {
  readonly rollbackApproval?: HumanApproval;
}

interface RollingBackState extends FailedState {
  readonly rollbackApproval: HumanApproval;
  readonly preChangeSnapshot: EnvironmentState;
}

export type ChangeLifecycle =
  | ({ readonly status: "PROPOSED" } & ProposalState)
  | ({ readonly status: "AWAITING_HUMAN_APPROVAL" } & ProposalState)
  | ({ readonly status: "REJECTED" } & ProposalState)
  | ({ readonly status: "EXPIRED" } & ProposalState)
  | ({ readonly status: "APPROVED" } & ApprovedState)
  | ({ readonly status: "EXECUTING" } & ExecutionState)
  | ({ readonly status: "VERIFYING" } & ExecutionState)
  | ({ readonly status: "SUCCEEDED" } & ApprovedState)
  | ({ readonly status: "FAILED" } & FailedState)
  | ({ readonly status: "ROLLBACK_AWAITING_APPROVAL" } & RollbackAwaitingApprovalState)
  | ({ readonly status: "ROLLING_BACK" } & RollingBackState)
  | ({ readonly status: "ROLLED_BACK" } & FailedState)
  | ({ readonly status: "ROLLBACK_FAILED" } & FailedState);

export interface ChangeGateState {
  readonly environment: EnvironmentState;
  readonly change: ChangeLifecycle | null;
  readonly audit: readonly AuditEvent[];
  readonly nextSequence: number;
}

export type DomainAction =
  | { readonly type: "PROPOSE_CHANGE"; readonly actor: "HUMAN" | "AGENT"; readonly proposal: ChangeProposalInput }
  | { readonly type: "REQUEST_HUMAN_APPROVAL"; readonly actor: "HUMAN" | "AGENT" }
  | { readonly type: "HUMAN_APPROVE"; readonly approvalId: string }
  | { readonly type: "HUMAN_REJECT" }
  | { readonly type: "EXPIRE_PROPOSAL" }
  | { readonly type: "BEGIN_EXECUTION" }
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
  return {
    services: CANONICAL_SCENARIO.services.map((service) => ({ ...service })),
  };
}

function cloneSnapshot(environment: EnvironmentState): EnvironmentState {
  return { services: environment.services.map((service) => ({ ...service })) };
}

function createApproval(approvalId: string, proposal: ImmutableChangeProposal): HumanApproval {
  return {
    approvalId,
    proposalId: proposal.proposalId,
    proposalDigest: proposal.proposalDigest,
    target: proposal.target,
    action: proposal.action,
    parameters: { ...proposal.parameters },
    preconditions: [...proposal.preconditions],
    issuedBy: "HUMAN",
    status: "ACTIVE",
  };
}

function consumed(approval: HumanApproval): HumanApproval {
  return { ...approval, status: "CONSUMED" };
}

export function isApprovalBoundToProposal(approval: HumanApproval, proposal: ImmutableChangeProposal): boolean {
  return (
    approval.issuedBy === "HUMAN" &&
    approval.status === "ACTIVE" &&
    approval.proposalId === proposal.proposalId &&
    approval.proposalDigest === proposal.proposalDigest &&
    approval.target === proposal.target &&
    approval.action === proposal.action &&
    JSON.stringify(approval.parameters) === JSON.stringify(proposal.parameters) &&
    JSON.stringify(approval.preconditions) === JSON.stringify(proposal.preconditions)
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
): DomainTransitionResult {
  return {
    ok: true,
    state: {
      ...state,
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
    change.status === "PROPOSED" ||
    change.status === "REJECTED" ||
    change.status === "EXPIRED" ||
    change.status === "SUCCEEDED" ||
    change.status === "FAILED" ||
    change.status === "ROLLED_BACK" ||
    change.status === "ROLLBACK_FAILED"
  );
}

export function createInitialState(): ChangeGateState {
  return { environment: cloneEnvironment(), change: null, audit: [], nextSequence: 1 };
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
      },
    };
  }

  switch (action.type) {
    case "PROPOSE_CHANGE":
      return change === null
        ? success(state, { status: "PROPOSED", proposal: createImmutableProposal(action.proposal) }, action.actor, action.type)
        : illegal(state, action);
    case "REQUEST_HUMAN_APPROVAL":
      return change?.status === "PROPOSED"
        ? success(state, { status: "AWAITING_HUMAN_APPROVAL", proposal: change.proposal }, action.actor, action.type)
        : illegal(state, action);
    case "HUMAN_APPROVE":
      return change?.status === "AWAITING_HUMAN_APPROVAL"
        ? success(state, { status: "APPROVED", proposal: change.proposal, approval: createApproval(action.approvalId, change.proposal) }, "HUMAN", action.type)
        : illegal(state, action);
    case "HUMAN_REJECT":
      return change?.status === "AWAITING_HUMAN_APPROVAL"
        ? success(state, { status: "REJECTED", proposal: change.proposal }, "HUMAN", action.type)
        : illegal(state, action);
    case "EXPIRE_PROPOSAL":
      return change?.status === "AWAITING_HUMAN_APPROVAL"
        ? success(state, { status: "EXPIRED", proposal: change.proposal }, "SYSTEM", action.type)
        : illegal(state, action);
    case "BEGIN_EXECUTION":
      return change?.status === "APPROVED" && isApprovalBoundToProposal(change.approval, change.proposal)
        ? success(state, { status: "EXECUTING", proposal: change.proposal, approval: consumed(change.approval), preChangeSnapshot: cloneSnapshot(state.environment) }, "SYSTEM", action.type)
        : illegal(state, action);
    case "EXECUTION_SUCCEEDED":
      return change?.status === "EXECUTING"
        ? success(state, { ...change, status: "VERIFYING" }, "SYSTEM", action.type)
        : illegal(state, action);
    case "EXECUTION_FAILED":
      return change?.status === "EXECUTING"
        ? success(state, { status: "FAILED", proposal: change.proposal, failureStage: "EXECUTION" }, "SYSTEM", action.type)
        : illegal(state, action);
    case "VERIFICATION_SUCCEEDED":
      return change?.status === "VERIFYING"
        ? success(state, { status: "SUCCEEDED", proposal: change.proposal, approval: change.approval }, "SYSTEM", action.type)
        : illegal(state, action);
    case "VERIFICATION_FAILED":
      return change?.status === "VERIFYING"
        ? success(state, { status: "FAILED", proposal: change.proposal, failureStage: "VERIFICATION" }, "SYSTEM", action.type)
        : illegal(state, action);
    case "REQUEST_ROLLBACK_APPROVAL":
      return change?.status === "FAILED"
        ? success(state, { ...change, status: "ROLLBACK_AWAITING_APPROVAL" }, action.actor, action.type)
        : illegal(state, action);
    case "HUMAN_APPROVE_ROLLBACK":
      return change?.status === "ROLLBACK_AWAITING_APPROVAL" && change.rollbackApproval === undefined
        ? success(state, { ...change, rollbackApproval: createApproval(action.approvalId, change.proposal) }, "HUMAN", action.type)
        : illegal(state, action);
    case "BEGIN_ROLLBACK":
      return change?.status === "ROLLBACK_AWAITING_APPROVAL" &&
        change.rollbackApproval !== undefined &&
        isApprovalBoundToProposal(change.rollbackApproval, change.proposal)
        ? success(state, { status: "ROLLING_BACK", proposal: change.proposal, failureStage: change.failureStage, rollbackApproval: consumed(change.rollbackApproval), preChangeSnapshot: cloneSnapshot(state.environment) }, "SYSTEM", action.type)
        : illegal(state, action);
    case "ROLLBACK_SUCCEEDED":
      return change?.status === "ROLLING_BACK"
        ? success(state, { status: "ROLLED_BACK", proposal: change.proposal, failureStage: change.failureStage }, "SYSTEM", action.type)
        : illegal(state, action);
    case "ROLLBACK_FAILED":
      return change?.status === "ROLLING_BACK"
        ? success(state, { status: "ROLLBACK_FAILED", proposal: change.proposal, failureStage: change.failureStage }, "SYSTEM", action.type)
        : illegal(state, action);
  }
}

import type { ChangeLifecycleState, ChangeTarget, JsonObject, JsonValue } from "../domain/change/contracts";
import {
  createInitialState,
  isApprovalBoundToProposal,
  reduceChangeGate,
  type AuditActor,
  type ChangeGateState,
} from "../domain/engine";
import type { ServiceHealth, ServiceId } from "../domain/scenario/types";
import { isAuthorizedRefundProposal } from "../domain/refund";
import { createRefundVerifier } from "./refund-verifier";
import { createSyntheticRefundLedger, type RefundWriteResult } from "./synthetic-refund-ledger";

const AUDIT_TRAIL_LIMIT = 50;

export const FLAGSHIP_TARGET = "agent-gateway" as const;
export const FLAGSHIP_ACTION = "RESTART_SIMULATED_GATEWAY" as const;
export const FLAGSHIP_PRECONDITION = "agent-gateway is DEGRADED" as const;

export interface FlagshipChangeInput {
  readonly proposalId: string;
  readonly target: typeof FLAGSHIP_TARGET;
  readonly action: typeof FLAGSHIP_ACTION;
  readonly parameters: {
    readonly mode: "safe";
    readonly retryLimit: number;
  };
  readonly preconditions: readonly [typeof FLAGSHIP_PRECONDITION];
}

export interface ServiceProjection {
  readonly id: ServiceId;
  readonly displayName: string;
  readonly health: ServiceHealth;
}

export interface EnvironmentStatusProjection {
  readonly services: readonly ServiceProjection[];
}

export interface ChangePolicyProjection {
  readonly consequentialChangesRequireVisibleHumanApproval: true;
  readonly approvalBindsExactProposal: true;
  readonly approvalIsSingleUse: true;
  readonly rollbackRequiresSeparateHumanApproval: true;
}

export interface ChangeProposalProjection {
  readonly lifecycle: ChangeLifecycleState;
  readonly proposalId: string;
  readonly target: ChangeTarget;
  readonly action: string;
  readonly parameters: JsonObject;
  readonly preconditions: readonly string[];
  readonly proposalDigest: string;
}

export interface AuditEventProjection {
  readonly sequence: number;
  readonly actor: AuditActor;
  readonly type: string;
  readonly lifecycle: ChangeLifecycleState | "NONE";
}

export interface AuditTrailProjection {
  readonly events: readonly AuditEventProjection[];
  readonly totalEvents: number;
  readonly truncated: boolean;
}

export type ChangeCommandResult =
  | {
      readonly status: "SUCCESS";
      readonly proposal: ChangeProposalProjection;
    }
  | {
      readonly status: "DENIED";
      readonly lifecycle: ChangeLifecycleState | "NONE";
      readonly reason: "TRANSITION_NOT_PERMITTED";
    };

export interface ChangeGateWebMcpOperations {
  readonly getEnvironmentStatus: () => EnvironmentStatusProjection;
  readonly getServiceDetails: (serviceId: ServiceId) => ServiceProjection | null;
  readonly getChangePolicy: () => ChangePolicyProjection;
  readonly getChangeProposal: () => ChangeProposalProjection | null;
  readonly getAuditTrail: () => AuditTrailProjection;
  readonly proposeChange: (input: FlagshipChangeInput) => ChangeCommandResult;
  readonly requestChangeApproval: (proposalId: string) => ChangeCommandResult;
}

/** Human intent identifies an approval lifecycle; it supplies no business authority. */
export interface HumanExecuteIdentity {
  readonly proposalId: string;
  readonly proposalDigest: string;
  readonly reviewInstanceId: string;
  readonly approvalId: string;
}

export interface ChangeGateOperations extends ChangeGateWebMcpOperations {
  readonly getRevision: () => number;
  readonly subscribe: (listener: () => void) => () => void;
  readonly approvePendingChange: () => ChangeCommandResult;
  readonly rejectPendingChange: () => ChangeCommandResult;
  readonly getPendingRefundExecution: () => HumanExecuteIdentity | null;
  readonly executeApprovedRefund: (expected: HumanExecuteIdentity) => ChangeCommandResult;
}

const HUMAN_EXECUTE_KEYS = ["proposalId", "proposalDigest", "reviewInstanceId", "approvalId"] as const;

function captureExecuteIdentity(value: unknown): HumanExecuteIdentity | null {
  if (typeof value !== "object" || value === null) return null;
  try {
    const keys = Reflect.ownKeys(value);
    if (keys.length !== HUMAN_EXECUTE_KEYS.length) return null;
    const identity = {} as Record<typeof HUMAN_EXECUTE_KEYS[number], string>;
    for (const key of HUMAN_EXECUTE_KEYS) {
      // Own data properties only: never invoke caller accessors or retain mutable input.
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !descriptor.enumerable || !("value" in descriptor) ||
          typeof descriptor.value !== "string" || descriptor.value.length === 0) return null;
      identity[key] = descriptor.value;
    }
    return Object.freeze(identity);
  } catch {
    // Malformed/revoked proxies are denied at the same boundary.
    return null;
  }
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function copyJsonValue(value: JsonValue): JsonValue {
  if (value === null || typeof value !== "object") return value;
  if (isJsonArray(value)) return Object.freeze(value.map(copyJsonValue));

  const copy: Record<string, JsonValue> = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    copy[key] = copyJsonValue(value[key]!);
  }
  return Object.freeze(copy);
}

function projectService(service: ServiceProjection): ServiceProjection {
  return Object.freeze({
    id: service.id,
    displayName: service.displayName,
    health: service.health,
  });
}

function projectProposal(state: ChangeGateState): ChangeProposalProjection | null {
  const change = state.change;
  if (change === null) return null;

  return Object.freeze({
    lifecycle: change.status,
    proposalId: change.proposal.proposalId,
    target: change.proposal.target,
    action: change.proposal.action,
    parameters: copyJsonValue(change.proposal.parameters) as JsonObject,
    preconditions: Object.freeze([...change.proposal.preconditions]),
    proposalDigest: change.proposal.proposalDigest,
  });
}

function denied(state: ChangeGateState): ChangeCommandResult {
  return Object.freeze({
    status: "DENIED",
    lifecycle: state.change?.status ?? "NONE",
    reason: "TRANSITION_NOT_PERMITTED",
  });
}

export function createWebMcpOperationsFacade(
  operations: ChangeGateWebMcpOperations,
): ChangeGateWebMcpOperations {
  return Object.freeze({
    getEnvironmentStatus: operations.getEnvironmentStatus,
    getServiceDetails: operations.getServiceDetails,
    getChangePolicy: operations.getChangePolicy,
    getChangeProposal: operations.getChangeProposal,
    getAuditTrail: operations.getAuditTrail,
    proposeChange: operations.proposeChange,
    requestChangeApproval: operations.requestChangeApproval,
  });
}

export function createChangeGateOperations(): ChangeGateOperations {
  let currentState = createInitialState();
  // Trusted composition only. These capabilities never leave this closure.
  const ledger = createSyntheticRefundLedger();
  const verifier = createRefundVerifier(ledger.reader);
  let revision = 0;
  const listeners = new Set<() => void>();

  const publish = (): void => {
    revision += 1;
    for (const listener of [...listeners]) {
      try {
        listener();
      } catch {
        continue;
      }
    }
  };

  const completeTransition = (
    result: ReturnType<typeof reduceChangeGate>,
  ): ChangeCommandResult => {
    if (!result.ok) return denied(currentState);

    const proposal = projectProposal(result.state);
    if (proposal === null) return denied(currentState);

    currentState = result.state;
    publish();
    return Object.freeze({ status: "SUCCESS", proposal });
  };

  const getEnvironmentStatus = (): EnvironmentStatusProjection =>
    Object.freeze({
      services: Object.freeze(currentState.environment.services.map(projectService)),
    });

  const getServiceDetails = (serviceId: ServiceId): ServiceProjection | null => {
    const service = currentState.environment.services.find(({ id }) => id === serviceId);
    return service === undefined ? null : projectService(service);
  };

  const getChangePolicy = (): ChangePolicyProjection =>
    Object.freeze({
      consequentialChangesRequireVisibleHumanApproval: true,
      approvalBindsExactProposal: true,
      approvalIsSingleUse: true,
      rollbackRequiresSeparateHumanApproval: true,
    });

  const getChangeProposal = (): ChangeProposalProjection | null => projectProposal(currentState);

  const getAuditTrail = (): AuditTrailProjection => {
    const totalEvents = currentState.audit.length;
    const events = currentState.audit.slice(-AUDIT_TRAIL_LIMIT).map((event) =>
      Object.freeze({
        sequence: event.sequence,
        actor: event.actor,
        type: event.type,
        lifecycle: event.lifecycle,
      }),
    );

    return Object.freeze({
      events: Object.freeze(events),
      totalEvents,
      truncated: totalEvents > AUDIT_TRAIL_LIMIT,
    });
  };

  const getRevision = (): number => revision;

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };

  const proposeChange = (input: FlagshipChangeInput): ChangeCommandResult => {
    const result = reduceChangeGate(currentState, {
      type: "PROPOSE_CHANGE",
      actor: "AGENT",
      proposal: input,
    });
    return completeTransition(result);
  };

  const requestChangeApproval = (proposalId: string): ChangeCommandResult => {
    const result = reduceChangeGate(currentState, {
      type: "REQUEST_HUMAN_APPROVAL",
      actor: "AGENT",
      proposalId,
    });
    return completeTransition(result);
  };

  const approvePendingChange = (): ChangeCommandResult => {
    const change = currentState.change;
    if (change?.status !== "AWAITING_HUMAN_APPROVAL") return denied(currentState);

    const result = reduceChangeGate(currentState, {
      type: "HUMAN_APPROVE",
      proposalId: change.proposal.proposalId,
      proposalDigest: change.proposal.proposalDigest,
      reviewInstanceId: change.reviewInstanceId,
      approvalId: `human-ui:${change.reviewInstanceId}`,
    });
    return completeTransition(result);
  };

  const rejectPendingChange = (): ChangeCommandResult => {
    const change = currentState.change;
    if (change?.status !== "AWAITING_HUMAN_APPROVAL") return denied(currentState);

    const result = reduceChangeGate(currentState, {
      type: "HUMAN_REJECT",
      proposalId: change.proposal.proposalId,
      proposalDigest: change.proposal.proposalDigest,
      reviewInstanceId: change.reviewInstanceId,
    });
    return completeTransition(result);
  };

  const getPendingRefundExecution = (): HumanExecuteIdentity | null => {
    const change = currentState.change;
    if (change?.status !== "APPROVED" || !isAuthorizedRefundProposal(change.proposal) ||
        !isApprovalBoundToProposal(change.approval, change.proposal) ||
        change.approval.reviewInstanceId !== change.reviewInstanceId) return null;

    return Object.freeze({
      proposalId: change.proposal.proposalId,
      proposalDigest: change.proposal.proposalDigest,
      reviewInstanceId: change.reviewInstanceId,
      approvalId: change.approval.approvalId,
    });
  };

  const executeApprovedRefund = (expected: HumanExecuteIdentity): ChangeCommandResult => {
    const identity = captureExecuteIdentity(expected);
    const pending = getPendingRefundExecution();
    if (identity === null || pending === null ||
        HUMAN_EXECUTE_KEYS.some((key) => identity[key] !== pending[key])) return denied(currentState);

    const begun = completeTransition(reduceChangeGate(currentState, {
      type: "BEGIN_REFUND_EXECUTION",
      expectedProposalId: identity.proposalId,
      expectedProposalDigest: identity.proposalDigest,
      expectedReviewInstanceId: identity.reviewInstanceId,
      expectedApprovalId: identity.approvalId,
    }));
    if (begun.status !== "SUCCESS") return begun;

    // Read authority from committed current state, after approval consumption/publication.
    const executing = currentState.change;
    if (executing?.status !== "EXECUTING" || executing.executionKind !== "REFUND") return denied(currentState);
    const binding = executing.refundExecution;
    const failExecution = (): ChangeCommandResult => completeTransition(reduceChangeGate(currentState, {
      type: "REFUND_EXECUTION_FAILED", executionId: binding.executionId,
    }));

    let write: RefundWriteResult;
    try {
      write = ledger.writer.applyAuthorizedRefund(binding);
    } catch {
      // No rollback or retry: an attempted effect must never restore approval.
      return failExecution();
    }
    // The private writer proves exact execution/effect equality for ALREADY_APPLIED.
    if (write.status !== "APPLIED" && write.status !== "ALREADY_APPLIED") return failExecution();

    const verifying = completeTransition(reduceChangeGate(currentState, {
      type: "REFUND_EXECUTION_SUCCEEDED", executionId: binding.executionId,
    }));
    if (verifying.status !== "SUCCESS") return verifying;

    const evidence = verifier.verify(binding);
    return completeTransition(reduceChangeGate(currentState, {
      type: "REFUND_VERIFICATION_COMPLETED", evidence,
    }));
  };

  return Object.freeze({
    getEnvironmentStatus,
    getServiceDetails,
    getChangePolicy,
    getChangeProposal,
    getAuditTrail,
    getRevision,
    subscribe,
    proposeChange,
    requestChangeApproval,
    approvePendingChange,
    rejectPendingChange,
    getPendingRefundExecution,
    executeApprovedRefund,
  });
}

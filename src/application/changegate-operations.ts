import type { ChangeLifecycleState, JsonObject, JsonValue } from "../domain/change/contracts";
import {
  createInitialState,
  reduceChangeGate,
  type AuditActor,
  type ChangeGateState,
} from "../domain/engine";
import type { ServiceHealth, ServiceId } from "../domain/scenario/types";

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
  readonly target: ServiceId;
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

export interface ChangeGateOperations {
  readonly getEnvironmentStatus: () => EnvironmentStatusProjection;
  readonly getServiceDetails: (serviceId: ServiceId) => ServiceProjection | null;
  readonly getChangePolicy: () => ChangePolicyProjection;
  readonly getChangeProposal: () => ChangeProposalProjection | null;
  readonly getAuditTrail: () => AuditTrailProjection;
  readonly proposeChange: (input: FlagshipChangeInput) => ChangeCommandResult;
  readonly requestChangeApproval: (proposalId: string) => ChangeCommandResult;
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

export function createChangeGateOperations(): ChangeGateOperations {
  let currentState = createInitialState();

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

  const proposeChange = (input: FlagshipChangeInput): ChangeCommandResult => {
    const result = reduceChangeGate(currentState, {
      type: "PROPOSE_CHANGE",
      actor: "AGENT",
      proposal: input,
    });
    if (!result.ok) return denied(currentState);

    currentState = result.state;
    const proposal = projectProposal(currentState);
    if (proposal === null) return denied(currentState);
    return Object.freeze({ status: "SUCCESS", proposal });
  };

  const requestChangeApproval = (proposalId: string): ChangeCommandResult => {
    const result = reduceChangeGate(currentState, {
      type: "REQUEST_HUMAN_APPROVAL",
      actor: "AGENT",
      proposalId,
    });
    if (!result.ok) return denied(currentState);

    currentState = result.state;
    const proposal = projectProposal(currentState);
    if (proposal === null) return denied(currentState);
    return Object.freeze({ status: "SUCCESS", proposal });
  };

  return Object.freeze({
    getEnvironmentStatus,
    getServiceDetails,
    getChangePolicy,
    getChangeProposal,
    getAuditTrail,
    proposeChange,
    requestChangeApproval,
  });
}

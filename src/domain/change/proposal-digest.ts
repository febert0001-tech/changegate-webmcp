import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js";

import type {
  ChangeProposalInput,
  GatewayProposalInput,
  ImmutableChangeProposal,
  ImmutableGatewayProposal,
  ImmutableRefundProposal,
  JsonObject,
  JsonValue,
  RefundProposalInput,
} from "./contracts";
import { hasRefundProposalShape } from "../refund";

function isPlainRecord(value: object): value is Readonly<Record<string, unknown>> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonArray(value: JsonValue): value is readonly JsonValue[] {
  return Array.isArray(value);
}

function normalizeJsonValue(value: unknown, ancestors: WeakSet<object>): JsonValue {
  if (value === null) return null;

  switch (typeof value) {
    case "boolean":
    case "string":
      return value;
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Proposal numbers must be finite.");
      }
      return value;
    case "object": {
      if (ancestors.has(value)) {
        throw new TypeError("Proposal values must not contain cycles.");
      }

      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          if (Object.getPrototypeOf(value) !== Array.prototype) {
            throw new TypeError("Proposal arrays must be ordinary arrays.");
          }
          if (Object.getOwnPropertySymbols(value).length > 0) {
            throw new TypeError("Proposal arrays must not contain symbol properties.");
          }

          const enumerableKeys = Object.keys(value);
          if (
            enumerableKeys.length !== value.length ||
            enumerableKeys.some((key, index) => key !== String(index))
          ) {
            throw new TypeError("Proposal arrays must be dense and contain only indexed values.");
          }

          const normalized: JsonValue[] = [];
          for (let index = 0; index < value.length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (descriptor === undefined || !("value" in descriptor)) {
              throw new TypeError("Proposal arrays must contain data values only.");
            }
            normalized.push(normalizeJsonValue(descriptor.value, ancestors));
          }
          return Object.freeze(normalized);
        }

        if (!isPlainRecord(value)) {
          throw new TypeError("Proposal values must use plain objects.");
        }
        if (Object.getOwnPropertySymbols(value).length > 0) {
          throw new TypeError("Proposal objects must not contain symbol properties.");
        }

        const normalized: Record<string, JsonValue> = Object.create(null);
        for (const key of Object.keys(value).sort()) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor === undefined || !("value" in descriptor)) {
            throw new TypeError("Proposal objects must contain data values only.");
          }
          normalized[key] = normalizeJsonValue(descriptor.value, ancestors);
        }
        return Object.freeze(normalized);
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      throw new TypeError("Proposal values must be JSON-compatible.");
  }
}

function normalizeParameters(parameters: Readonly<Record<string, unknown>>): JsonObject {
  const normalized = normalizeJsonValue(parameters, new WeakSet<object>());
  if (normalized === null || isJsonArray(normalized) || typeof normalized !== "object") {
    throw new TypeError("Proposal parameters must be a plain object.");
  }
  return normalized;
}

function normalizePreconditions(preconditions: readonly string[]): readonly string[] {
  return Object.freeze(
    preconditions.map((precondition) => {
      if (typeof precondition !== "string") {
        throw new TypeError("Proposal preconditions must be strings.");
      }
      return precondition;
    }),
  );
}

function canonicalize(value: JsonValue): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
    case "string":
      return JSON.stringify(value);
    case "object":
      if (isJsonArray(value)) {
        return `[${value.map(canonicalize).join(",")}]`;
      }
      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key]!)}`)
        .join(",")}}`;
  }
}

function canonicalProposalContent(proposal: {
  readonly proposalId: string;
  readonly target: ImmutableChangeProposal["target"];
  readonly action: string;
  readonly parameters: JsonObject;
  readonly preconditions: readonly string[];
}): JsonObject {
  return Object.freeze({
    action: proposal.action,
    parameters: proposal.parameters,
    preconditions: Object.freeze([...proposal.preconditions]),
    proposalId: proposal.proposalId,
    target: proposal.target,
  });
}

export function canonicalizeProposal(proposal: ChangeProposalInput | ImmutableChangeProposal): string {
  const parameters = normalizeParameters(proposal.parameters);
  const preconditions = normalizePreconditions(proposal.preconditions);
  return canonicalize(canonicalProposalContent({ ...proposal, parameters, preconditions }));
}

export function computeProposalDigest(proposal: ChangeProposalInput | ImmutableChangeProposal): string {
  return bytesToHex(sha256(utf8ToBytes(canonicalizeProposal(proposal))));
}

export function createImmutableProposal(proposal: GatewayProposalInput): ImmutableGatewayProposal;
export function createImmutableProposal(proposal: RefundProposalInput): ImmutableRefundProposal;
export function createImmutableProposal(proposal: ChangeProposalInput): ImmutableChangeProposal;
export function createImmutableProposal(proposal: ChangeProposalInput): ImmutableChangeProposal {
  const parameters = normalizeParameters(proposal.parameters);
  const preconditions = normalizePreconditions(proposal.preconditions);
  const proposalDigest = bytesToHex(
    sha256(
      utf8ToBytes(
        canonicalize(canonicalProposalContent({ ...proposal, parameters, preconditions })),
      ),
    ),
  );

  const content = {
    proposalId: proposal.proposalId,
    target: proposal.target,
    action: proposal.action,
    parameters,
    preconditions,
  };
  if (content.target === "order:4821" || content.action === "SYNTHETIC_PARTIAL_REFUND") {
    if (!hasRefundProposalShape(content)) {
      throw new TypeError("Refund proposal must match the supported refund contract.");
    }
    return Object.freeze({ ...content, proposalDigest });
  }
  return Object.freeze({ ...content, target: content.target, proposalDigest });
}

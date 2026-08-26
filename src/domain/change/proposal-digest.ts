import { createHash } from "node:crypto";

import type { ChangeProposalInput, ImmutableChangeProposal } from "./contracts";

function isPlainRecord(value: object): value is Readonly<Record<string, unknown>> {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function canonicalize(value: unknown): string {
  if (value === null) return "null";

  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("Proposal values must use finite numbers.");
      }
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value);
    case "object":
      if (Array.isArray(value)) {
        return `[${value.map(canonicalize).join(",")}]`;
      }

      if (!isPlainRecord(value)) {
        throw new TypeError("Proposal values must be plain objects.");
      }

      return `{${Object.keys(value)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`)
        .join(",")}}`;
    default:
      throw new TypeError("Proposal values must be JSON-compatible.");
  }
}

export function canonicalizeProposal(proposal: ChangeProposalInput): string {
  return canonicalize({
    action: proposal.action,
    parameters: proposal.parameters,
    preconditions: proposal.preconditions,
    proposalId: proposal.proposalId,
    target: proposal.target,
  });
}

export function computeProposalDigest(proposal: ChangeProposalInput): string {
  return createHash("sha256").update(canonicalizeProposal(proposal), "utf8").digest("hex");
}

export function createImmutableProposal(proposal: ChangeProposalInput): ImmutableChangeProposal {
  return {
    ...proposal,
    parameters: { ...proposal.parameters },
    preconditions: [...proposal.preconditions],
    proposalDigest: computeProposalDigest(proposal),
  };
}

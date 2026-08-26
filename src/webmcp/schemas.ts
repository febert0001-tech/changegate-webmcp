import { z } from "zod";

import {
  FLAGSHIP_ACTION,
  FLAGSHIP_PRECONDITION,
  FLAGSHIP_TARGET,
} from "../application/changegate-operations";
import { SERVICE_IDS } from "../domain/scenario/types";

const proposalIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u);

export const emptyInputSchema = z.object({}).strict();

export const serviceDetailsInputSchema = z
  .object({
    serviceId: z.enum(SERVICE_IDS),
  })
  .strict();

export const proposeChangeInputSchema = z
  .object({
    proposalId: proposalIdSchema,
    target: z.literal(FLAGSHIP_TARGET),
    action: z.literal(FLAGSHIP_ACTION),
    parameters: z
      .object({
        mode: z.literal("safe"),
        retryLimit: z.number().int().min(1).max(3),
      })
      .strict(),
    preconditions: z.tuple([z.literal(FLAGSHIP_PRECONDITION)]),
  })
  .strict();

export const requestChangeApprovalInputSchema = z
  .object({
    proposalId: proposalIdSchema,
  })
  .strict();

export type ServiceDetailsInput = z.output<typeof serviceDetailsInputSchema>;
export type ProposeChangeInput = z.output<typeof proposeChangeInputSchema>;
export type RequestChangeApprovalInput = z.output<typeof requestChangeApprovalInputSchema>;

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isJsonData(value: unknown, ancestors: WeakSet<object>): boolean {
  if (value === null) return true;

  switch (typeof value) {
    case "boolean":
    case "string":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object": {
      if (ancestors.has(value)) return false;
      ancestors.add(value);
      try {
        if (Array.isArray(value)) {
          if (Object.getPrototypeOf(value) !== Array.prototype) return false;
          if (Object.getOwnPropertySymbols(value).length !== 0) return false;
          const names = Object.getOwnPropertyNames(value);
          if (names.length !== value.length + 1 || names.at(-1) !== "length") return false;

          for (let index = 0; index < value.length; index += 1) {
            if (names[index] !== String(index)) return false;
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (descriptor === undefined || !("value" in descriptor)) return false;
            if (!isJsonData(descriptor.value, ancestors)) return false;
          }
          return true;
        }

        if (!isPlainRecord(value)) return false;
        if (Object.getOwnPropertySymbols(value).length !== 0) return false;
        const names = Object.getOwnPropertyNames(value);
        const enumerableKeys = Object.keys(value);
        if (names.length !== enumerableKeys.length) return false;

        for (const key of enumerableKeys) {
          const descriptor = Object.getOwnPropertyDescriptor(value, key);
          if (descriptor === undefined || !("value" in descriptor)) return false;
          if (!isJsonData(descriptor.value, ancestors)) return false;
        }
        return true;
      } finally {
        ancestors.delete(value);
      }
    }
    default:
      return false;
  }
}

export type ExternalParseResult<T> =
  | { readonly success: true; readonly data: T }
  | { readonly success: false };

export function parseExternalInput<Schema extends z.ZodType>(
  schema: Schema,
  input: unknown,
): ExternalParseResult<z.output<Schema>> {
  try {
    if (!isJsonData(input, new WeakSet<object>())) return { success: false };
    const result = schema.safeParse(input);
    return result.success
      ? { success: true, data: result.data }
      : { success: false };
  } catch {
    return { success: false };
  }
}

export function toWebMcpInputSchema(schema: z.ZodType): Readonly<Record<string, unknown>> {
  const generated = z.toJSONSchema(schema, { target: "draft-07", io: "input" });
  return Object.freeze({ ...generated });
}

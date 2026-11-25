import { z } from "zod";
import { ARTIFACT_TYPES } from "../policy/catalog.js";

// The shape of what the admin API accepts. The meaning of a policy is checked afterwards by validatePolicy.
const role = z.enum(["gpt", "claude", "po"]);
const slot = z.union([role, z.object({ field: z.enum(["executor", "validator"]) }).strict()]);
const rule = z.object({
  from: z.string(), to: z.string(), allow: z.array(slot),
  artifact: z.enum(ARTIFACT_TYPES), mode: z.enum(["initial", "correction"]).optional(),
}).strict();
const entity = z.object({
  states: z.record(z.string(), z.object({ owner: slot.nullable() }).strict()),
  governed: z.union([z.literal("all"), z.array(z.string())]),
  transitions: z.array(rule),
}).strict();

export const policySchema = z.object({
  schemaVersion: z.literal(1), roles: z.array(role),
  entities: z.object({ task: entity, userstory: entity, epic: entity }).strict(),
}).strict();

export const proposeBody = z.object({ policy: policySchema }).strict();
export const rollbackBody = z.object({ toRevision: z.number().int().positive() }).strict();
export const approveBody = z.object({ expectedRevision: z.number().int().positive().nullable(), hash: z.string().regex(/^[0-9a-f]{64}$/), reason: z.string().trim().min(1).max(500) }).strict();
export const rejectBody = z.object({ reason: z.string().trim().min(1).max(500) }).strict();
export const simulateBody = z.object({
  entity: z.enum(["task", "userstory", "epic"]), role: role.nullable(), from: z.string(), to: z.string(),
  facts: z.object({ executor: role.optional(), validator: role.optional() }).strict().optional(),
}).strict();
export const pageQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), offset: z.coerce.number().int().min(0).default(0) });
export const proposalsQuery = pageQuery.extend({ state: z.enum(["pending", "approved", "rejected", "active"]).optional() });
export const uuid = z.uuid();
export const reconcileBody = z.object({ apply: z.boolean().default(false) }).strict();

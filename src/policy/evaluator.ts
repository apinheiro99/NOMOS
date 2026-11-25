import type { ActorRole } from "../workflow/actor.js";
import type { ActionRow, EntityKind } from "../workflow/policy.js";
import type { Decision, Facts, Policy, Slot } from "./types.js";

const label = (s: Slot) => (typeof s === "string" ? s : s.field);
const holds = (slot: Slot, role: ActorRole, facts: Facts) => (typeof slot === "string" ? slot === role : facts[slot.field] === role);

// Pure: the same policy and facts always give the same decision. Used only by tests until a later phase wires it in.
export function evaluate(policy: Policy, entity: EntityKind, role: ActorRole | null, from: string, to: string, facts: Facts = {}): Decision {
  if (from === to) return { kind: "denied", reason: `the card is already in "${to}"` };
  const rules = policy.entities[entity];
  if (rules.governed !== "all" && !rules.governed.includes(to)) return { kind: "legacy" };
  const candidates = rules.transitions.filter((t) => t.from === from && t.to === to);
  const rule = role ? candidates.find((t) => t.allow.some((slot) => holds(slot, role, facts))) : undefined;
  if (rule) return { kind: "typed", artifact: rule.artifact, mode: rule.mode, override: false };
  // The PO may override any governed transition, leaving a structured Decision.
  if (role === "po") return { kind: "typed", artifact: "po_decision", override: true };
  const owners = candidates[0]?.allow.map(label).join("/");
  return { kind: "denied", reason: owners ? `"${from}" -> "${to}" is reserved for ${owners}` : `no transition "${from}" -> "${to}" exists for ${role ?? "an unrecognized caller"}` };
}

export const ownerOf = (policy: Policy, entity: EntityKind, status: string): Slot | null => policy.entities[entity].states[status]?.owner ?? null;

// The read model of what `role` may do next from `current`: DERIVED from evaluate for every state, so it can never advertise an action the
// policy refuses. Same shape as the legacy actionsFor.
export function allowedActions(policy: Policy, entity: EntityKind, role: ActorRole | null, current: string, names?: Iterable<string>, facts: Facts = {}): { allowed: ActionRow[]; denied: ActionRow[] } {
  const have = names ? new Set(names) : null;
  const allowed: ActionRow[] = [];
  const denied: ActionRow[] = [];
  for (const target of Object.keys(policy.entities[entity].states)) {
    if (target === current || (have && !have.has(target))) continue;
    const d = evaluate(policy, entity, role, current, target, facts);
    if (d.kind === "typed") allowed.push({ action: "workflow_transition", target, artifact: d.artifact, mode: d.mode, override: d.override, allowed: true });
    else if (d.kind === "denied") denied.push({ action: "workflow_transition", target, allowed: false, why: d.reason });
  }
  return { allowed, denied };
}

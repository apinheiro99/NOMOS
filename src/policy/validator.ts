import { ARTIFACT_TYPES } from "./catalog.js";
import { norm } from "../workflow/policy.js";
import type { Policy } from "./types.js";

export interface Violation { code: string; where: string; detail: string }

const TERMINAL = new Set(["done", "cancelled"]);

// Returns every rule the policy breaks; an empty list means it is sound. Pure, so the same policy always gives the same answer.
export function validatePolicy(policy: Policy): Violation[] {
  const out: Violation[] = [];
  const add = (code: string, where: string, detail: string) => out.push({ code, where, detail });
  const roles = new Set(policy.roles);

  for (const [entity, rules] of Object.entries(policy.entities)) {
    const names = Object.keys(rules.states);
    for (const n of names) {
      if (norm(n) !== n) add("state_not_normalized", `${entity}.${n}`, "status keys are lower-case, trimmed, single-spaced");
      const owner = rules.states[n].owner;
      if (owner && !roles.has(owner)) add("role_without_binding", `${entity}.${n}`, `owner "${owner}" has no binding`);
      if (TERMINAL.has(n) && owner !== null) add("invariant_terminal_owner", `${entity}.${n}`, "Done and Cancelled have no owner");
      if (n === "human decision" && owner !== "po") add("invariant_human_decision_owner", `${entity}.${n}`, "Human Decision belongs to the PO only");
    }
    const aliases = new Map<string, string[]>();
    for (const n of names) aliases.set(norm(n), [...(aliases.get(norm(n)) ?? []), n]);
    for (const [alias, keys] of aliases) if (keys.length > 1) add("ambiguous_alias", `${entity}.${alias}`, `keys ${keys.join(", ")} mean the same status`);

    const seen = new Set<string>();
    for (const t of rules.transitions) {
      const where = `${entity}.${t.from}->${t.to}`;
      for (const end of [t.from, t.to]) if (!(end in rules.states)) add("unknown_state", where, `"${end}" is not a state of ${entity}`);
      if (t.from === t.to) add("impossible_transition", where, "a transition to the same status does not exist");
      if (!(ARTIFACT_TYPES as readonly string[]).includes(t.artifact)) add("unknown_artifact", where, `"${t.artifact}" is not a known artifact`);
      if (!t.allow.length) add("no_role", where, "no role may take this transition");
      for (const r of t.allow) {
        if (!roles.has(r)) add("role_without_binding", where, `role "${r}" has no binding`);
        const key = `${t.from}>${t.to}>${r}`;
        if (seen.has(key)) add("duplicate_transition", where, `role "${r}" is allowed twice`);
        seen.add(key);
      }
    }

    // Every non-terminal state must have a way out: a typed transition, or a target that is a plain (ungoverned) update.
    for (const n of names.filter((s) => !TERMINAL.has(s))) {
      const typedExit = rules.transitions.some((t) => t.from === n);
      const plainExit = rules.governed !== "all" && names.some((s) => s !== n && !rules.governed.includes(s));
      if (!typedExit && !plainExit) add("no_exit", `${entity}.${n}`, "no transition leaves this status");
    }
  }
  return out;
}

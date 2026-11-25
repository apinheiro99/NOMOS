import { ownerRole, pairsFor, requiredStatusNames, semanticStatusNames } from "../workflow/policy.js";
import type { EntityKind } from "../workflow/policy.js";
import type { EntityPolicy, Policy, TransitionRule } from "./types.js";
import { OPERATIONS } from "./operations.js";

const ENTITIES: EntityKind[] = ["task", "userstory", "epic"];
// Mirrors the governed targets of policy.ts: every Task target, the Story ones that carry an artifact, the Epic card names.
const GOVERNED: Record<EntityKind, "all" | string[]> = { task: "all", userstory: ["in progress", "gpt validation", "done"], epic: ["gpt validation", "done"] };

function entityPolicy(entity: EntityKind): EntityPolicy {
  const names = [...new Set([...requiredStatusNames(entity), ...semanticStatusNames(entity)])];
  const transitions: TransitionRule[] = pairsFor(entity).flatMap((p) => {
    // The wildcard becomes explicit pairs. Request is a closed state: no wildcard enters or leaves it (only its own explicit pairs).
    const froms = p.from === "*" ? names.filter((n) => n !== "request" && n !== p.to) : [p.from];
    return froms.map((from) => ({ from, to: p.to, allow: p.roles, artifact: p.artifact, mode: p.mode }));
  });
  // Request -> Cancelled is the explicit PO exception coded apart from the pairs.
  if (entity === "task") transitions.push({ from: "request", to: "cancelled", allow: ["po"], artifact: "po_decision" });
  return { states: Object.fromEntries(names.map((n) => [n, { owner: ownerRole(n) }])), governed: GOVERNED[entity], transitions };
}

// The legacy workflow expressed as policy data, generated from the code that decides today (never retyped).
export const legacySeed = (): Policy => ({
  schemaVersion: 1,
  roles: ["gpt", "claude", "po"],
  // The legacy code never checked the role of a plain write, so the seed lists every one of them for every role (the guards that follow still apply).
  operations: Object.fromEntries(OPERATIONS.filter((o) => o.access === "write" && o.rule !== "workflow").map((o) => [o.id, ["gpt", "claude", "po"]])),
  entities: Object.fromEntries(ENTITIES.map((e) => [e, entityPolicy(e)])) as Policy["entities"],
});

// Legacy policy oracle (F1): characterizes what the CURRENT code decides, so the policy engine can be proven equal to it.
// It records actual behavior, not intended behavior. `node scripts/policy-oracle.ts --write` refreshes the golden file;
// the test fails when the file and the code disagree, so a behavior change can never go unnoticed.
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ownerRole, requiredStatusNames, resolveTransition, semanticStatusNames } from "../dist/workflow/policy.js";
import type { EntityKind } from "../dist/workflow/policy.js";
import type { ActorRole } from "../dist/workflow/actor.js";

export const GOLDEN_PATH = fileURLToPath(new URL("../test/fixtures/policy/legacy-golden.json", import.meta.url));

const ENTITIES: EntityKind[] = ["task", "userstory", "epic"];
// Roles: the three authenticated actors, an anonymous caller (null) and an authenticated-looking but unknown one.
const ROLES: (ActorRole | null | "mallory")[] = ["gpt", "claude", "po", null, "mallory"];
// "limbo" is a status the workflow does not know: it must never be allowed to move anywhere.
const states = (entity: EntityKind) => [...new Set([...requiredStatusNames(entity), ...semanticStatusNames(entity)]), "limbo"];

export function legacyGolden() {
  const transitions = ENTITIES.flatMap((entity) =>
    states(entity).flatMap((from) =>
      states(entity).flatMap((to) =>
        ROLES.map((role) => ({ entity, from, to, role, result: resolveTransition(entity, role as ActorRole | null, from, to) })),
      ),
    ),
  );
  const owners = [...new Set(ENTITIES.flatMap(states))].map((status) => ({ status, owner: ownerRole(status) }));
  return { transitions, owners };
}

export const serialize = (golden: ReturnType<typeof legacyGolden>) =>
  `{\n"owners": ${JSON.stringify(golden.owners)},\n"transitions": [\n${golden.transitions.map((t) => JSON.stringify(t)).join(",\n")}\n]\n}\n`;

if (process.argv[1] === fileURLToPath(import.meta.url) && process.argv.includes("--write")) {
  writeFileSync(GOLDEN_PATH, serialize(legacyGolden()));
  console.log(`wrote ${GOLDEN_PATH}`);
}

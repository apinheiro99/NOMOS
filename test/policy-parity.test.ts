import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GOLDEN_PATH } from "../scripts/policy-oracle.ts";
import { evaluate, ownerOf } from "../dist/policy/evaluator.js";
import { legacySeed } from "../dist/policy/legacy-seed.js";

// F1.2: the pure evaluator, fed with the legacy seed, decides exactly what the legacy code decided (golden file).
type Result = { kind: string; artifact?: string; mode?: string; override?: boolean };
type Entry = { entity: "task" | "userstory" | "epic"; from: string; to: string; role: "gpt" | "claude" | "po" | null; result: Result };
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as { owners: { status: string; owner: string | null }[]; transitions: Entry[] };
const seed = legacySeed();

// Legacy quirk found by the oracle (D-16): the `* -> cancelled` wildcard also matches a status the workflow does not know.
// The seed holds only real states, so these two entries differ on purpose; nothing else may.
const QUIRK = new Set(["task limbo cancelled gpt", "task limbo cancelled po"]);
const key = (e: Entry) => `${e.entity} ${e.from} ${e.to} ${e.role}`;
const shape = (r: Result) => ({ kind: r.kind, artifact: r.artifact, mode: r.mode, override: r.override });

test("the evaluator with the legacy seed equals the golden file, except the documented wildcard quirk", () => {
  const diff = golden.transitions.filter((e) => {
    const got = evaluate(seed, e.entity, e.role, e.from, e.to);
    return JSON.stringify(shape(got)) !== JSON.stringify(shape(e.result));
  });
  assert.deepEqual(new Set(diff.map(key)), QUIRK);
});

test("D-16 legacy lets GPT cancel a task sitting in an unknown status; the seed does not", () => {
  const e = golden.transitions.find((t) => key(t) === "task limbo cancelled gpt")!;
  assert.equal(e.result.kind, "typed");
  assert.equal(evaluate(seed, "task", "gpt", "limbo", "cancelled").kind, "denied");
});

test("the owner of every state equals the legacy owner", () => {
  for (const entity of ["task", "userstory", "epic"] as const) {
    for (const status of Object.keys(seed.entities[entity].states)) {
      assert.equal(ownerOf(seed, entity, status), golden.owners.find((o) => o.status === status)?.owner);
    }
  }
});

test("the seed carries no wildcard and no duplicated pair", () => {
  for (const entity of ["task", "userstory", "epic"] as const) {
    const keys = seed.entities[entity].transitions.map((t) => `${t.from}>${t.to}>${t.allow.join()}`);
    assert.equal(keys.some((k) => k.startsWith("*")), false);
    assert.equal(new Set(keys).size, keys.length);
  }
});

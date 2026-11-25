import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePolicy } from "../dist/policy/validator.js";
import { legacySeed } from "../dist/policy/legacy-seed.js";
import type { Policy } from "../dist/policy/types.js";

// F1.3: one negative case per rule the validator promises, and the legacy seed passes clean.
const fresh = (): Policy => structuredClone(legacySeed());
const codes = (p: Policy) => validatePolicy(p).map((v) => v.code);
const task = (p: Policy) => p.entities.task;

test("the legacy seed is a sound policy", () => {
  assert.deepEqual(validatePolicy(legacySeed()), []);
});

test("rejects a transition to or from a state that does not exist", () => {
  const p = fresh();
  task(p).transitions.push({ from: "to do", to: "limbo", allow: ["gpt"], artifact: "po_decision" });
  assert.ok(codes(p).includes("unknown_state"));
});

test("rejects two keys that mean the same status", () => {
  const p = fresh();
  task(p).states["In Progress"] = { owner: "claude" };
  assert.ok(codes(p).includes("ambiguous_alias"));
  assert.ok(codes(p).includes("state_not_normalized"));
});

test("rejects a role that has no binding", () => {
  const p = fresh();
  p.roles = ["gpt", "po"];
  assert.ok(codes(p).includes("role_without_binding"));
});

test("rejects an artifact the catalog does not know", () => {
  const p = fresh();
  (task(p).transitions[0] as { artifact: string }).artifact = "free_text";
  assert.ok(codes(p).includes("unknown_artifact"));
});

test("rejects a role allowed twice on the same transition", () => {
  const p = fresh();
  task(p).transitions.push({ ...task(p).transitions[0] });
  assert.ok(codes(p).includes("duplicate_transition"));
});

test("rejects a transition to the same status and a transition nobody may take", () => {
  const p = fresh();
  task(p).transitions.push({ from: "to do", to: "to do", allow: ["gpt"], artifact: "po_decision" });
  task(p).transitions.push({ from: "to do", to: "done", allow: [], artifact: "po_decision" });
  assert.ok(codes(p).includes("impossible_transition"));
  assert.ok(codes(p).includes("no_role"));
});

test("rejects a status with no way out", () => {
  const p = fresh();
  task(p).transitions = task(p).transitions.filter((t) => t.from !== "request");
  assert.deepEqual(validatePolicy(p).filter((v) => v.code === "no_exit").map((v) => v.where), ["task.request"]);
});

test("rejects policies that break an invariant", () => {
  const p = fresh();
  task(p).transitions.push({ from: "to do", to: "done", allow: ["gpt"], artifact: "po_decision" });
  task(p).states["human decision"].owner = "claude";
  assert.ok(codes(p).includes("invariant_done_needs_approval"));
  assert.ok(codes(p).includes("invariant_human_decision_owner"));
});

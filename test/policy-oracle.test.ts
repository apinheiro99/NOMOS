import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { GOLDEN_PATH, legacyGolden } from "../scripts/policy-oracle.ts";

// F1: the golden file characterizes the CURRENT policy. If the code changes, this fails until the change is reviewed and the golden refreshed.
type Entry = { entity: string; from: string; to: string; role: string | null; result: { kind: string; artifact?: string; override?: boolean } };
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as { owners: { status: string; owner: string | null }[]; transitions: Entry[] };
const at = (entity: string, from: string, to: string, role: string | null) => {
  const hit = golden.transitions.filter((t) => t.entity === entity && t.from === from && t.to === to && t.role === role);
  assert.equal(hit.length, 1, `exactly one golden entry for ${entity} ${from} -> ${to} (${role})`);
  return hit[0].result;
};
const owner = (status: string) => golden.owners.find((o) => o.status === status)?.owner;

test("the golden file equals what the code decides today", () => {
  assert.deepEqual(golden, JSON.parse(JSON.stringify(legacyGolden())));
});

test("every state pair is covered for every role, the diagonal and an unknown state are denied", () => {
  assert.equal(golden.transitions.length, 645);
  for (const role of ["gpt", "claude", "po", null, "mallory"]) {
    assert.equal(at("task", "to do", "to do", role).kind, "denied");
    if (role !== "po") assert.notEqual(at("task", "limbo", "in progress", role).kind, "typed", "an unknown origin is typed only for the PO override");
  }
});

// D-1..D-15 of matrix-alignment.md section 3A: where the legacy code differs from the 64-pair matrix. Named so v2 can flip each one on purpose.
test("D-1 In Progress -> GPT Validation is Claude only", () => {
  assert.equal(at("task", "in progress", "gpt validation", "claude").kind, "typed");
  assert.equal(at("task", "in progress", "gpt validation", "gpt").kind, "denied");
});
test("D-2 In Progress -> Human Decision is Claude only", () => {
  assert.equal(at("task", "in progress", "human decision", "claude").kind, "typed");
  assert.equal(at("task", "in progress", "human decision", "gpt").kind, "denied");
});
test("D-3 Request -> In Progress is Claude only", () => {
  assert.equal(at("task", "request", "in progress", "claude").artifact, "request_resume");
  assert.equal(at("task", "request", "in progress", "gpt").kind, "denied");
});
test("D-4 Request -> Cancelled is PO only", () => {
  assert.equal(at("task", "request", "cancelled", "po").kind, "typed");
  assert.equal(at("task", "request", "cancelled", "gpt").kind, "denied");
});
test("D-5 Human Decision -> Cancelled is allowed to GPT by the wildcard", () => {
  assert.equal(at("task", "human decision", "cancelled", "gpt").artifact, "po_decision");
});
test("D-6 Done -> Cancelled is allowed to GPT by the wildcard", () => {
  assert.equal(at("task", "done", "cancelled", "gpt").artifact, "po_decision");
});
test("D-7 GPT Validation -> In Progress / Done is not allowed to Claude", () => {
  assert.equal(at("task", "gpt validation", "in progress", "claude").kind, "denied");
  assert.equal(at("task", "gpt validation", "done", "claude").kind, "denied");
});
test("D-8 and D-9 the owner of In Progress is claude and of GPT Validation is gpt, fixed", () => {
  assert.equal(owner("in progress"), "claude");
  assert.equal(owner("gpt validation"), "gpt");
});
test("D-10 Done and Cancelled have no owner", () => {
  assert.equal(owner("done"), null);
  assert.equal(owner("cancelled"), null);
});
test("D-15 the status is still named GPT Validation", () => {
  assert.ok(golden.transitions.some((t) => t.from === "gpt validation"));
  assert.equal(golden.transitions.some((t) => t.from === "validation"), false);
});
// D-11 (no Executor/Validator fields), D-12 (notification has no recipient), D-13 (resolve tool and fixed return status) and D-14 (no manual-move reconcile)
// are not decisions of resolveTransition; they are outside this oracle and are covered where they live (notify, human-decision and assignment tests).

test("anonymous and unknown callers never get a typed move on a task", () => {
  const typed = golden.transitions.filter((t) => t.entity === "task" && (t.role === null || t.role === "mallory") && t.result.kind === "typed");
  assert.deepEqual(typed, []);
});

test("the PO override is typed and flagged for every pair the roles do not own", () => {
  const r = at("task", "to do", "done", "po");
  assert.deepEqual([r.kind, r.artifact, r.override], ["typed", "po_decision", true]);
});

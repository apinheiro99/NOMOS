import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { evaluate, ownerOf } from "../dist/policy/evaluator.js";
import { validatePolicy } from "../dist/policy/validator.js";
import type { Policy } from "../dist/policy/types.js";

// F1.4: two policies that are data only. GPT-only is meant to work; the 64-pair matrix (v2) is only validated, never active.
const load = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/policy/${name}.json`, import.meta.url), "utf8")) as Policy;
const gptOnly = load("gpt-only");
const v2 = load("v2-matrix");

test("GPT-only is a sound policy and mentions no Claude anywhere", () => {
  assert.deepEqual(validatePolicy(gptOnly), []);
  assert.equal(JSON.stringify(gptOnly).includes("claude"), false);
});

test("GPT-only: a Task goes To Do -> In Progress -> GPT Validation -> Done with GPT alone", () => {
  for (const [from, to] of [["to do", "in progress"], ["in progress", "gpt validation"], ["gpt validation", "done"]]) {
    const d = evaluate(gptOnly, "task", "gpt", from, to);
    assert.equal(d.kind, "typed", `${from} -> ${to}`);
    assert.equal(d.kind === "typed" && d.override, false);
  }
});

test("GPT-only: Claude can do nothing, and Human Decision belongs to the PO", () => {
  for (const from of Object.keys(gptOnly.entities.task.states)) {
    for (const to of Object.keys(gptOnly.entities.task.states)) assert.notEqual(evaluate(gptOnly, "task", "claude", from, to).kind, "typed", `${from} -> ${to}`);
  }
  assert.equal(ownerOf(gptOnly, "task", "human decision"), "po");
  assert.equal(ownerOf(gptOnly, "task", "in progress"), "gpt");
});

test("v2 matrix is a sound policy with 8 task states and 25 automatic pairs", () => {
  assert.deepEqual(validatePolicy(v2), []);
  assert.equal(Object.keys(v2.entities.task.states).length, 8);
  assert.equal(v2.entities.task.transitions.length, 25);
});

test("v2 matrix: the Executor and the Validator come from the Task, not from a fixed role", () => {
  const claudeRuns = { executor: "claude", validator: "gpt" } as const;
  assert.equal(evaluate(v2, "task", "claude", "in progress", "validation", claudeRuns).kind, "typed");
  assert.equal(evaluate(v2, "task", "gpt", "in progress", "validation", claudeRuns).kind, "denied");
  const gptRuns = { executor: "gpt", validator: "gpt" } as const; // D-1: GPT as Executor can hand off
  assert.equal(evaluate(v2, "task", "gpt", "in progress", "validation", gptRuns).kind, "typed");
  const claudeValidates = { executor: "gpt", validator: "claude" } as const; // D-7: Claude as Validator can approve
  assert.equal(evaluate(v2, "task", "claude", "validation", "done", claudeValidates).kind, "typed");
});

test("v2 matrix: diagonal and skipped steps are denied, and the PO can still override by hand", () => {
  const facts = { executor: "claude", validator: "gpt" } as const;
  for (const s of Object.keys(v2.entities.task.states)) assert.equal(evaluate(v2, "task", "po", s, s, facts).kind, "denied");
  assert.equal(evaluate(v2, "task", "gpt", "to do", "done", facts).kind, "denied");
  assert.equal(evaluate(v2, "task", "gpt", "request", "done", facts).kind, "denied");
  const manual = evaluate(v2, "task", "po", "human decision", "in progress", facts);
  assert.deepEqual([manual.kind, manual.kind === "typed" && manual.override], ["typed", true]);
});

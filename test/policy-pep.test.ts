import { test } from "node:test";
import assert from "node:assert/strict";
import { enforce, assertCataloged } from "../dist/policy/pep.js";
import { OPERATIONS } from "../dist/policy/operations.js";

// F3.2b: one decision before any handler. A fake client records every call so "no side effects" is checked, not assumed.
const calls: string[] = [];
const client = { get: async (path: string) => { calls.push(`GET ${path}`); return { project: 7 }; } } as never;
const blocked = { forProject: async (p: number) => { throw new Error(`project ${p} is drift: governed writes are blocked`); } } as never;
const open = { forProject: async () => null } as never;

const args = (param: string) => ({ [param]: 11 });

test("every cataloged write resolves a project, or is global, workflow or self-scoped: nothing is left to guess", async () => {
  for (const o of OPERATIONS.filter((x) => x.access === "write" && x.rule !== "workflow")) {
    const a = o.scope.kind === "global" ? {} : args(o.scope.param);
    assert.equal(await enforce(o.id, a, client, open), null, o.id);
  }
});

test("a write in a project the runtime blocks is refused, and the refusal touches nothing but the project lookup", async () => {
  calls.length = 0;
  assert.match((await enforce("taiga_tasks_update", { id: 5 }, client, blocked))!, /drift/);
  assert.match((await enforce("taiga_epics_create", { project: 7 }, client, blocked))!, /drift/);
  assert.deepEqual(calls, ["GET /tasks/5"]);
});

test("reads, global bootstrap and the workflow tools are not decided here", async () => {
  assert.equal(await enforce("taiga_tasks_get", { id: 5 }, client, blocked), null);
  assert.equal(await enforce("taiga_projects_create", {}, client, blocked), null);
  assert.equal(await enforce("taiga_workflow_transition", { id: 5 }, client, blocked), null);
});

test("an unknown tool is refused at call time and cannot even be registered", async () => {
  assert.match((await enforce("taiga_made_up", {}, client, open))!, /not in the policy catalog/);
  assert.throws(() => assertCataloged("taiga_made_up"), /not in the policy catalog/);
  assert.doesNotThrow(() => assertCataloged("taiga_tasks_update"));
});

test("bulk, field, order, import and alias paths are all cataloged writes and so all pass through the same decision", async () => {
  const names = ["taiga_tasks_bulk_create", "taiga_userstories_bulk_create", "taiga_tasks_bulk_update_taskboard_order", "taiga_userstories_bulk_update_sprint_order", "taiga_epics_related_userstories_update_order", "taiga_issue_statuses_bulk_update_order", "taiga_project_import", "taiga_issues_promote_to_userstory", "taiga_issue_move_to_backlog", "taiga_userstory_move_to_backlog"];
  for (const n of names) assert.equal(OPERATIONS.find((o) => o.id === n)?.access, "write", n);
});

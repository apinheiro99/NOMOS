import { test } from "node:test";
import assert from "node:assert/strict";
import { enforce, assertCataloged } from "../dist/policy/pep.js";
import { OPERATIONS } from "../dist/policy/operations.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTaigaMcpServer } from "../dist/server.js";
import { actorFor } from "../dist/workflow/actor.js";
import { legacySeed } from "../dist/policy/legacy-seed.js";

// F3.2b: one decision before any handler. A fake client records every call so "no side effects" is checked, not assumed.
const calls: string[] = [];
const client = { get: async (path: string) => { calls.push(`GET ${path}`); return { project: 7 }; } } as never;
const blocked = { forProject: async (p: number) => { throw new Error(`project ${p} is drift: governed writes are blocked`); } } as never;
const open = { forProject: async () => null } as never;
const ROLE = "po" as const;

const args = (param: string) => ({ [param]: 11 });

test("every cataloged write resolves a project, or is global, workflow or self-scoped: nothing is left to guess", async () => {
  for (const o of OPERATIONS.filter((x) => x.access === "write" && x.rule !== "workflow")) {
    const a = o.scope.kind === "global" ? {} : args(o.scope.param);
    assert.equal(await enforce(o.id, a, client, open, ROLE), null, o.id);
  }
});

test("a write in a project the runtime blocks is refused, and the refusal touches nothing but the project lookup", async () => {
  calls.length = 0;
  assert.match((await enforce("taiga_tasks_update", { id: 5 }, client, blocked, ROLE))!, /drift/);
  assert.match((await enforce("taiga_epics_create", { project: 7 }, client, blocked, ROLE))!, /drift/);
  assert.deepEqual(calls, ["GET /tasks/5"]);
});

test("reads and global bootstrap are not decided here; a workflow write in a blocked project is refused like any other", async () => {
  assert.equal(await enforce("taiga_tasks_get", { id: 5 }, client, blocked, ROLE), null);
  assert.equal(await enforce("taiga_projects_create", {}, client, blocked, ROLE), null);
  assert.match((await enforce("taiga_workflow_transition", { entity: "task", id: 5 }, client, blocked, ROLE))!, /drift/);
  assert.equal(await enforce("taiga_workflow_transition", { entity: "task", id: 5 }, client, open, ROLE), null, "its permission is the transitions, not an operation entry");
});

test("an unknown tool is refused at call time and cannot even be registered", async () => {
  assert.match((await enforce("taiga_made_up", {}, client, open, ROLE))!, /not in the policy catalog/);
  assert.throws(() => assertCataloged("taiga_made_up"), /not in the policy catalog/);
  assert.doesNotThrow(() => assertCataloged("taiga_tasks_update"));
});

test("bulk, field, order, import and alias paths are all cataloged writes and so all pass through the same decision", async () => {
  const names = ["taiga_tasks_bulk_create", "taiga_userstories_bulk_create", "taiga_tasks_bulk_update_taskboard_order", "taiga_userstories_bulk_update_sprint_order", "taiga_epics_related_userstories_update_order", "taiga_issue_statuses_bulk_update_order", "taiga_project_import", "taiga_issues_promote_to_userstory", "taiga_issue_move_to_backlog", "taiga_userstory_move_to_backlog"];
  for (const n of names) assert.equal(OPERATIONS.find((o) => o.id === n)?.access, "write", n);
});

// A real server, a real tool, a policy that lists the operation for GPT only: Claude is refused and Taiga sees nothing but the project lookup.
const policy = () => { const p = legacySeed(); p.operations["taiga_tasks_update"] = ["gpt"]; delete p.operations["taiga_epics_create"]; return p; };
async function call(role: "gpt" | "claude" | "po" | null, tool: string, args: Record<string, unknown>) {
  const seen: string[] = [];
  const fake = {
    get: async (path: string) => { seen.push(`GET ${path}`); return { project: 7, version: 1, status: 1 }; },
    patch: async (path: string) => { seen.push(`PATCH ${path}`); return {}; }, post: async (path: string) => { seen.push(`POST ${path}`); return {}; },
  } as never;
  const runtime = { forProject: async () => ({ projectId: "p", activationId: "a", revision: 4, policy: policy() }), hold: async () => async () => undefined } as never;
  const server = createTaigaMcpServer(fake, { mode: "authenticated", actor: role ? actorFor(role) : null }, runtime);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const result = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { result, seen };
}

test("a role the policy does not list is refused and nothing is written; an unlisted operation and an unauthenticated caller are refused too", async () => {
  const denied = await call("claude", "taiga_tasks_update", { id: 5, version: 1, subject: "x" });
  assert.match(denied.result.content[0].text, /not permitted to claude .*revision 4/);
  assert.deepEqual(denied.seen, ["GET /tasks/5"], "only the project lookup ran");
  assert.match((await call("po", "taiga_epics_create", { project: 7, subject: "e" })).result.content[0].text, /not permitted to po/);
  const anonymous = await call(null, "taiga_tasks_update", { id: 5, version: 1, subject: "x" });
  assert.match(anonymous.result.content[0].text, /unauthenticated/);
  assert.equal(anonymous.seen.some((s) => s.startsWith("PATCH")), false);
});

test("the role the policy lists reaches the handler", async () => {
  const allowed = await call("gpt", "taiga_tasks_update", { id: 5, version: 1, subject: "x" });
  assert.equal(allowed.seen.some((s) => s.startsWith("PATCH /tasks/5")), true);
});

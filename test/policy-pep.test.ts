import { test } from "node:test";
import assert from "node:assert/strict";
import { guard, assertCataloged } from "../dist/policy/pep.js";
import { OPERATIONS } from "../dist/policy/operations.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTaigaMcpServer } from "../dist/server.js";
import { actorFor } from "../dist/workflow/actor.js";
import { legacySeed } from "../dist/policy/legacy-seed.js";

// F3.2b: one decision before any handler. A fake client records every call so "no side effects" is checked, not assumed.
const calls: string[] = [];
const client = { get: async (path: string) => { calls.push(`GET ${path}`); return { project: 7 }; } } as never;
const blocked = { hold: async (p: number) => { throw new Error(`project ${p} is drift: governed writes are blocked`); } } as never;
const held = (policy = legacySeed()) => ({ hold: async () => ({ managed: { projectId: "p", activationId: "a", revision: 4, policy }, release: async () => undefined }) }) as never;
const legacy = { hold: async () => null } as never;
const ROLE = "po" as const;
const refusal = async (...a: Parameters<typeof guard>) => { const g = await guard(...a); return "refusal" in g ? g.refusal : null; };

// Arguments that name the project for every operation, including the ones whose target kind is itself an argument.
const argsFor = (o: (typeof OPERATIONS)[number]) => ({ ...(o.scope.kind === "global" ? {} : { [o.scope.param]: 11 }), kind: "task", entity: "task" });

test("every cataloged write resolves its project or is global: nothing is left to guess, and nothing is exempt", async () => {
  for (const o of OPERATIONS.filter((x) => x.access === "write")) {
    const g = await guard(o.id, argsFor(o), client, held(), ROLE);
    assert.equal("refusal" in g, false, `${o.id}: ${"refusal" in g ? g.refusal : ""}`);
  }
});

test("a scope that cannot be resolved is a refusal, never a permission", async () => {
  assert.match((await refusal("taiga_epics_create", {}, client, held(), ROLE))!, /project is required/);
  assert.match((await refusal("taiga_tasks_update", { id: Number.NaN }, client, held(), ROLE))!, /id is required/);
  assert.match((await refusal("taiga_tasks_update", {}, client, held(), ROLE))!, /id is required/);
});

test("a write in a project the runtime blocks is refused, and the refusal touches nothing but the project lookup", async () => {
  calls.length = 0;
  assert.match((await refusal("taiga_tasks_update", { id: 5 }, client, blocked, ROLE))!, /drift/);
  assert.match((await refusal("taiga_epics_create", { project: 7 }, client, blocked, ROLE))!, /drift/);
  assert.deepEqual(calls, ["GET /tasks/5"]);
});

test("reads and global bootstrap are not decided here; the workflow writes are refused in a blocked project like any other", async () => {
  assert.equal(await refusal("taiga_tasks_get", { id: 5 }, client, blocked, ROLE), null);
  assert.equal(await refusal("taiga_projects_create", {}, client, blocked, ROLE), null);
  for (const [name, a] of [["taiga_workflow_transition", { entity: "task", id: 5 }], ["taiga_workflow_request_create", { task_id: 5 }], ["taiga_human_decision_resolve", { task_id: 5 }]] as const) {
    assert.match((await refusal(name, a, client, blocked, ROLE))!, /drift/, name);
  }
  assert.equal(await refusal("taiga_workflow_transition", { entity: "task", id: 5 }, client, held(), "claude"), null, "the transition is decided by the transitions, not by an operation entry");
});

test("the other workflow writes are decided by the policy's operation permissions, not by hard-coded rules", async () => {
  const policy = legacySeed();
  policy.operations["taiga_workflow_request_create"] = ["gpt", "po"];
  assert.match((await refusal("taiga_workflow_request_create", { task_id: 5 }, client, held(policy), "claude"))!, /not permitted to claude/);
  assert.equal(await refusal("taiga_workflow_request_create", { task_id: 5 }, client, held(policy), "gpt"), null);
});

test("an unknown tool is refused at call time and cannot even be registered", async () => {
  assert.match((await refusal("taiga_made_up", {}, client, legacy, ROLE))!, /not in the policy catalog/);
  assert.throws(() => assertCataloged("taiga_made_up"), /not in the policy catalog/);
  assert.doesNotThrow(() => assertCataloged("taiga_tasks_update"));
});

test("bulk, field, order, import and alias paths are all cataloged writes and so all pass through the same decision", async () => {
  const names = ["taiga_tasks_bulk_create", "taiga_userstories_bulk_create", "taiga_tasks_bulk_update_taskboard_order", "taiga_userstories_bulk_update_sprint_order", "taiga_epics_related_userstories_update_order", "taiga_issue_statuses_bulk_update_order", "taiga_project_import", "taiga_issues_promote_to_userstory", "taiga_issue_move_to_backlog", "taiga_userstory_move_to_backlog"];
  for (const n of names) assert.equal(OPERATIONS.find((o) => o.id === n)?.access, "write", n);
});

// A real server, a real tool, a policy that lists the operation for GPT only: Claude is refused and Taiga sees nothing but the project lookup.
const policy = () => { const p = legacySeed(); p.operations["taiga_tasks_update"] = ["gpt"]; delete p.operations["taiga_epics_create"]; return p; };
async function call(role: "gpt" | "claude" | "po" | null, tool: string, args: Record<string, unknown>, rt: unknown = held(policy())) {
  const seen: string[] = [];
  const fake = {
    get: async (path: string) => { seen.push(`GET ${path}`); return { project: 7, version: 1, status: 1 }; },
    patch: async (path: string) => { seen.push(`PATCH ${path}`); return {}; }, post: async (path: string) => { seen.push(`POST ${path}`); return {}; },
  } as never;
  const runtime = rt as never;
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

test("governance OFF frees a legacy project but never a managed one: the invariants still hold", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const file = join(mkdtempSync(join(tmpdir(), "gov-")), "governance.json");
  writeFileSync(file, JSON.stringify({ enabled: false }));
  process.env.TAIGA_MCP_GOVERNANCE_FILE = file;
  try {
    const status = { id: 5, version: 1, status: 2 };
    const managed = await call("gpt", "taiga_tasks_update", status);
    assert.match(managed.result.content[0].text, /taiga_workflow_transition/, "a raw status write is still refused in a managed project");
    assert.equal(managed.seen.some((x) => x.startsWith("PATCH")), false);
    const free = await call("gpt", "taiga_tasks_update", status, legacy);
    assert.equal(free.seen.some((x) => x.startsWith("PATCH /tasks/5")), true, "a legacy project is free while governance is OFF");
  } finally { delete process.env.TAIGA_MCP_GOVERNANCE_FILE; }
});

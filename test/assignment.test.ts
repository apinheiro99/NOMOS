import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { legacySeed } from "../dist/policy/legacy-seed.js";
import { assigneeProblem, assigneeRole, resolveAssignee } from "../dist/workflow/assignment.js";

const accounts = { TAIGA_MCP_EXPECTED_ACCOUNT_GPT: "chatgpt", TAIGA_MCP_EXPECTED_ACCOUNT_CLAUDE: "claudecode", TAIGA_MCP_EXPECTED_ACCOUNT_PO: "po" };
const fake = (users: unknown[], assigned?: number) => ({ getAll: async () => users, get: async () => ({ assigned_to: assigned }) }) as never;
const members = [{ id: 1, username: "chatgpt", is_active: true }, { id: 2, username: "claudecode", is_active: true }, { id: 3, username: "po", is_active: true }];

test("the owner role per entity: Task and Epic follow the status owner, a Story is GPT/PO-orchestrated", () => {
  assert.equal(assigneeRole("task", "in progress"), "claude");
  assert.equal(assigneeRole("task", "gpt validation"), "gpt");
  assert.equal(assigneeRole("task", "request"), "gpt");
  assert.equal(assigneeRole("task", "human decision"), "po");
  assert.equal(assigneeRole("task", "done"), null);
  assert.equal(assigneeRole("userstory", "in progress"), "gpt", "Claude never owns a Story");
  assert.equal(assigneeRole("userstory", "ready"), "gpt");
  assert.equal(assigneeRole("userstory", "human decision"), "po");
  assert.equal(assigneeRole("epic", "gpt validation"), "gpt");
  assert.equal(assigneeRole("epic", "in progress"), "claude");
});

test("a managed project asks its policy: the legacy seed gives the legacy owners exactly, GPT-only gives GPT everywhere", () => {
  const seed = legacySeed();
  for (const entity of ["task", "userstory", "epic"] as const) {
    for (const status of Object.keys(seed.entities[entity].states)) assert.equal(assigneeRole(entity, status, seed), assigneeRole(entity, status), `${entity} ${status}`);
  }
  const gptOnly = JSON.parse(readFileSync(new URL("./fixtures/policy/gpt-only.json", import.meta.url), "utf8"));
  assert.equal(assigneeRole("task", "in progress", gptOnly), "gpt", "the legacy rule would say claude");
  assert.equal(assigneeRole("userstory", "in progress", gptOnly), "gpt");
});

test("the Taiga user comes from the configured account and the active project members, never a stored id", async () => {
  assert.deepEqual(await resolveAssignee(fake(members), 5, "task", "in progress", accounts), { id: 2 });
  assert.deepEqual(await resolveAssignee(fake(members), 5, "userstory", "in progress", accounts), { id: 1 });
  assert.deepEqual(await resolveAssignee(fake(members), 5, "task", "done", accounts), {}, "closed statuses are not projected");
  assert.deepEqual(await resolveAssignee(fake(members), 5, "task", "in progress", {}), {}, "no account configured: projection off");
});

test("missing, inactive, ambiguous or unconfigured owners fail closed", async () => {
  assert.match((await resolveAssignee(fake([]), 5, "task", "in progress", accounts)).problem!, /no active project member "claudecode"/);
  assert.match((await resolveAssignee(fake([{ id: 2, username: "claudecode", is_active: false }]), 5, "task", "in progress", accounts)).problem!, /no active/);
  assert.match((await resolveAssignee(fake([...members, { id: 9, username: "claudecode", is_active: true }]), 5, "task", "in progress", accounts)).problem!, /ambiguous/);
  assert.match((await resolveAssignee(fake(members), 5, "task", "in progress", { TAIGA_MCP_EXPECTED_ACCOUNT_GPT: "chatgpt" })).problem!, /TAIGA_MCP_EXPECTED_ACCOUNT_CLAUDE is not configured/);
});

test("the reread card must carry the projected assignee", () => {
  assert.equal(assigneeProblem({ assigned_to: 2 }, 2), null);
  assert.match(assigneeProblem({ assigned_to: 9 }, 2)!, /not the projected owner/);
  assert.match(assigneeProblem({}, 2)!, /undefined/);
  assert.equal(assigneeProblem({ assigned_to: 9 }, undefined), null, "no projection, nothing to verify");
});

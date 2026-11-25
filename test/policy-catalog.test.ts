import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { renderOperations } from "../scripts/policy-catalog.ts";
import { toolInventory } from "../scripts/tools-inventory.ts";
import { INTERNAL_MUTATORS } from "../dist/policy/catalog.js";
import { OPERATIONS } from "../dist/policy/operations.js";

// F3.2a: the operation catalog is the runtime tool registry, classified. Nothing may be a tool without an operation, or the reverse.
const inventory = await toolInventory();
const ids = OPERATIONS.map((o) => o.id);
const access = JSON.parse(readFileSync("scripts/tool-access.json", "utf8")) as { read: string[]; write: string[] };

test("every tool is classified read or write by a person, once, and the lists name only real tools", () => {
  const all = [...access.read, ...access.write];
  assert.equal(new Set(all).size, all.length, "no tool in both lists or twice");
  assert.deepEqual([...all].sort(), inventory.map((t) => t.name).sort());
});

test("the catalog equals tools/list exactly, in both directions", () => {
  assert.equal(OPERATIONS.length, inventory.length, "one operation per tool the server really lists");
  assert.equal(new Set(ids).size, ids.length, "no operation twice");
  assert.deepEqual([...ids].sort(), inventory.map((t) => t.name).sort());
});

test("the catalog file is the generated one (a tool added or changed without regenerating fails here)", async () => {
  assert.equal(readFileSync("src/policy/operations.ts", "utf8"), await renderOperations());
});

test("every operation has an access, a scope whose parameter really exists, and a rule", () => {
  const tool = new Map(inventory.map((t) => [t.name, t]));
  for (const o of OPERATIONS) {
    assert.equal(o.access, tool.get(o.id)!.mutating ? "write" : "read", o.id);
    if (o.scope.kind !== "global") assert.ok(tool.get(o.id)!.params.includes(o.scope.param), `${o.id}: scope parameter ${o.scope.param}`);
    assert.ok(["baseline", "workflow", "bootstrap"].includes(o.rule), o.id);
  }
});

test("a tool that is a write although its name reads like a read is a write", () => {
  const access = (id: string) => OPERATIONS.find((o) => o.id === id)!.access;
  for (const id of ["taiga_human_decision_resolve", "taiga_issues_promote_to_userstory", "taiga_uuid_initialize_project", "taiga_workflow_transition"]) assert.equal(access(id), "write", id);
  for (const id of ["taiga_uuid_resolve", "taiga_task_workflow_state", "taiga_search"]) assert.equal(access(id), "read", id);
});

test("creating or importing a project is bootstrap, the lifecycle is workflow, and only global tools have no project", () => {
  const rule = (id: string) => OPERATIONS.find((o) => o.id === id)!.rule;
  assert.deepEqual([rule("taiga_projects_create"), rule("taiga_project_import"), rule("taiga_workflow_transition")], ["bootstrap", "bootstrap", "workflow"]);
  assert.deepEqual(OPERATIONS.filter((o) => o.scope.kind === "global").map((o) => o.id).sort(), ["taiga_governance_status", "taiga_project_import", "taiga_projects_create", "taiga_projects_get_by_slug", "taiga_projects_list", "taiga_timeline_profile", "taiga_timeline_user", "taiga_users_me", "taiga_workflow_template"]);
});

// Writes to Taiga that no tool owns: the code outside src/tools that calls post/patch/put/delete.
function writers(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const path = join(dir, e.name);
    if (e.isDirectory()) return e.name === "tools" ? [] : writers(path);
    return e.name.endsWith(".ts") && /\.(post|patch|put|delete|postMultipart)\(/.test(readFileSync(path, "utf8")) ? [path] : [];
  });
}

test("the internal mutators are exactly the files that write to Taiga outside the tools, and each names real operations", () => {
  assert.deepEqual(writers("src").sort(), Object.keys(INTERNAL_MUTATORS).sort());
  for (const [file, ops] of Object.entries(INTERNAL_MUTATORS)) for (const op of ops) assert.ok(ids.includes(op), `${file} -> ${op}`);
});

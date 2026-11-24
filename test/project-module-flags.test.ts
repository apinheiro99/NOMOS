import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerProjectTools } from "../dist/tools/projects.js";

// Issue #210 / Story #225 / Task #226 (RED). Settings > Project > Modules also has Epics and Contact, but
// taiga_projects_create/update only expose backlog/issues/kanban/wiki, so those two modules cannot be toggled.
// Input goes through the registered zod shape first (as the MCP SDK does), so a flag missing from the schema
// is stripped exactly like in production.
function setup() {
  const reg = {};
  const server = { tool: (name, _d, schema, handler) => { reg[name] = { schema, handler }; } };
  const calls = [];
  const client = {
    post: async (path, body) => { calls.push(["post", path, body]); return { id: 1, ...body }; },
    patch: async (path, body) => { calls.push(["patch", path, body]); return { id: 1, ...body }; },
  };
  registerProjectTools(server, client);
  const run = async (name, input) => {
    const parsed = z.object(reg[name].schema).parse(input);
    return reg[name].handler(parsed, {});
  };
  return { reg, calls, run };
}

for (const flag of ["is_epics_activated", "is_contact_activated"]) {
  test(`taiga_projects_update forwards ${flag} true and false`, async () => {
    for (const value of [true, false]) {
      const { calls, run } = setup();
      await run("taiga_projects_update", { id: 4, [flag]: value });
      assert.deepEqual(calls, [["patch", "/projects/4", { [flag]: value }]]);
    }
  });
  test(`taiga_projects_create forwards ${flag}`, async () => {
    const { calls, run } = setup();
    await run("taiga_projects_create", { name: "P", [flag]: true, apply_profile: false });
    assert.deepEqual(calls, [["post", "/projects", { name: "P", [flag]: true }]]);
  });
  test(`${flag} is optional and boolean-only on both tools`, () => {
    const { reg } = setup();
    for (const t of ["taiga_projects_create", "taiga_projects_update"]) {
      assert.ok(flag in reg[t].schema, `${t} exposes ${flag}`);
      assert.equal(reg[t].schema[flag].isOptional(), true);
      assert.equal(reg[t].schema[flag].safeParse("yes").success, false);
    }
  });
}

test("update with both new flags and an existing one forwards all three", async () => {
  const { calls, run } = setup();
  await run("taiga_projects_update", { id: 4, is_epics_activated: true, is_contact_activated: false, is_wiki_activated: true });
  assert.deepEqual(calls[0][2], { is_epics_activated: true, is_contact_activated: false, is_wiki_activated: true });
});

test("controls: existing flags are still forwarded on update and create", async () => {
  let t = setup();
  await t.run("taiga_projects_update", { id: 4, is_backlog_activated: false, is_issues_activated: true, is_kanban_activated: true, is_wiki_activated: false });
  assert.deepEqual(t.calls[0][2], { is_backlog_activated: false, is_issues_activated: true, is_kanban_activated: true, is_wiki_activated: false });
  t = setup();
  await t.run("taiga_projects_create", { name: "P", is_backlog_activated: true, is_private: true, apply_profile: false });
  assert.deepEqual(t.calls[0][2], { name: "P", is_backlog_activated: true, is_private: true });
});

test("controls: omitting the new flags adds nothing to the body", async () => {
  const { calls, run } = setup();
  await run("taiga_projects_update", { id: 4, name: "N" });
  assert.deepEqual(calls[0][2], { name: "N" });
});

test("a profiled project is born with Epics, Kanban, Wiki and Contact on, and an explicit flag still wins", async () => {
  let t = setup();
  await t.run("taiga_projects_create", { name: "P" });
  assert.deepEqual(t.calls[0], ["post", "/projects", { is_epics_activated: true, is_kanban_activated: true, is_wiki_activated: true, is_contact_activated: true, name: "P" }]);
  t = setup();
  await t.run("taiga_projects_create", { name: "P", is_wiki_activated: false });
  assert.equal(t.calls[0][2].is_wiki_activated, false);
});

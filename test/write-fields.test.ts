import { test } from "node:test";
import assert from "node:assert/strict";
import { addCompactParam } from "../dist/fields.js";

const FAMILIES = ["epics", "userstories", "tasks", "issues", "milestones"];
const big = () => ({
  id: 7, ref: 3, version: 4, status: 333, subject: "S", description: "d".repeat(500),
  owner_extra_info: { username: "u" }, watchers: [5], tags: [], total_comments: 2,
});
const text = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });

function setup(name, result, seen = {}) {
  const reg = {};
  const server = { tool: (n, _d, schema, handler) => { reg[n] = { schema, handler }; } };
  addCompactParam(server);
  server.tool(name, "d", {}, async (args) => { seen.args = args; return result; });
  return reg[name];
}

for (const fam of FAMILIES) {
  for (const verb of ["create", "update"]) {
    const name = `taiga_${fam}_${verb}`;
    test(`${name}: fields projects the write response and keeps id/ref/version`, async () => {
      const t = setup(name, text(big()));
      assert.ok("fields" in t.schema, "schema exposes fields");
      const parsed = JSON.parse((await t.handler({ fields: "description" }, {})).content[0].text);
      assert.deepEqual(Object.keys(parsed).sort(), ["description", "id", "ref", "version"]);
    });
    test(`${name}: explicit fields wins over compact`, async () => {
      const t = setup(name, text(big()));
      const parsed = JSON.parse((await t.handler({ fields: "description", compact: true }, {})).content[0].text);
      assert.deepEqual(Object.keys(parsed).sort(), ["description", "id", "ref", "version"]);
    });
  }
}

test("comment_create tools expose fields and honour precedence", async () => {
  for (const n of ["taiga_userstory_comment_create", "taiga_task_comment_create", "taiga_issue_comment_create", "taiga_wiki_comment_create"]) {
    const t = setup(n, text(big()));
    assert.ok("fields" in t.schema, n);
    const parsed = JSON.parse((await t.handler({ fields: "tags", compact: true }, {})).content[0].text);
    assert.deepEqual(Object.keys(parsed).sort(), ["id", "ref", "tags", "version"]);
  }
});

test("compact alone still yields the five-key ACK; default stays byte-identical", async () => {
  const full = text(big());
  const t = setup("taiga_tasks_update", full);
  assert.deepEqual(await t.handler({}, {}), full);
  const parsed = JSON.parse((await t.handler({ compact: true }, {})).content[0].text);
  assert.deepEqual(Object.keys(parsed).sort(), ["id", "ref", "status", "subject", "version"]);
});

test("fields and compact are stripped before the underlying handler", async () => {
  const seen = {};
  const t = setup("taiga_tasks_update", text(big()), seen);
  await t.handler({ task_id: 1, fields: "status", compact: true }, {});
  assert.deepEqual(seen.args, { task_id: 1 });
});

test("errors and non-JSON pass through intact with fields", async () => {
  const err = { isError: true, content: [{ type: "text", text: "Taiga API error" }] };
  assert.deepEqual(await setup("taiga_tasks_update", err).handler({ fields: "status" }, {}), err);
  const raw = { content: [{ type: "text", text: "not json" }] };
  assert.deepEqual(await setup("taiga_tasks_update", raw).handler({ fields: "status" }, {}), raw);
});

test("read tools and other tools do not get write-fields from addCompactParam", () => {
  assert.ok(!("fields" in setup("taiga_tasks_get", text(big())).schema));
  assert.ok(!("fields" in setup("taiga_tasks_delete", text(big())).schema));
});

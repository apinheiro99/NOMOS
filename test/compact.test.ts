import { test } from "node:test";
import assert from "node:assert/strict";
import { addCompactParam } from "../dist/fields.js";

const FAMILIES = ["epics", "userstories", "tasks", "issues", "milestones"];
const big = () => ({
  id: 7, ref: 3, version: 4, status: 333, subject: "S", description: "d".repeat(500),
  owner_extra_info: { username: "u", photo: null }, project_extra_info: { name: "p", slug: "p" },
  watchers: [5], tags: [], attachments: [], total_comments: 2,
});
const text = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });

function setup(name, result) {
  const reg = {};
  const server = { tool: (n, _d, schema, handler) => { reg[n] = { schema, handler }; } };
  addCompactParam(server);
  server.tool(name, "d", {}, async () => result);
  return reg[name];
}

for (const fam of FAMILIES) {
  for (const verb of ["create", "update"]) {
    const name = `taiga_${fam}_${verb}`;
    test(`${name}: compact is opt-in, default byte-identical, compact much smaller`, async () => {
      const full = text(big());
      const t = setup(name, full);
      assert.ok("compact" in t.schema, "schema exposes compact");
      assert.deepEqual(await t.handler({}, {}), full);
      const c = await t.handler({ compact: true }, {});
      const parsed = JSON.parse(c.content[0].text);
      assert.deepEqual(Object.keys(parsed).sort(), ["id", "ref", "status", "subject", "version"]);
      assert.ok(c.content[0].text.length * 3 < full.content[0].text.length);
    });
  }
}

test("comment_create tools get compact too", () => {
  for (const n of ["taiga_userstory_comment_create", "taiga_task_comment_create", "taiga_issue_comment_create"]) {
    assert.ok("compact" in setup(n, text(big())).schema);
  }
});

test("read tools and other tools do not get compact", () => {
  assert.ok(!("compact" in setup("taiga_tasks_get", text(big())).schema));
  assert.ok(!("compact" in setup("taiga_tasks_delete", text(big())).schema));
});

test("errors and non-JSON pass through intact with compact", async () => {
  const err = { isError: true, content: [{ type: "text", text: "Taiga API error" }] };
  assert.deepEqual(await setup("taiga_tasks_update", err).handler({ compact: true }, {}), err);
  const raw = { content: [{ type: "text", text: "not json" }] };
  assert.deepEqual(await setup("taiga_tasks_update", raw).handler({ compact: true }, {}), raw);
});

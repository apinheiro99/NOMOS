import { test } from "node:test";
import assert from "node:assert/strict";
import { addFieldsParam } from "../dist/fields.js";

const FAMILIES = ["epics", "userstories", "tasks", "issues", "milestones"];
const VERBS = ["list", "get", "get_by_ref"];
const item = (i) => ({
  id: i, ref: 10 + i, version: 4, status: 333, subject: `S${i}`,
  owner_extra_info: { username: "u", full_name_display: "U", photo: "p".repeat(80), gravatar_id: "g".repeat(32) },
  assigned_to_extra_info: { username: "a", photo: "p".repeat(80), gravatar_id: "g".repeat(32) },
  project_extra_info: { name: "p", slug: "p", logo_small_url: "l".repeat(80) },
  status_extra_info: { name: "New", color: "#fff", is_closed: false },
  watchers: [1, 2, 3], total_watchers: 3, is_watcher: false, total_voters: 2, is_voter: false,
  backlog_order: 1, sprint_order: 2, kanban_order: 3, epics_order: 4, order: 5,
});
const text = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });
const DROPPED = /extra_info|gravatar|photo|watchers|voters|is_watcher|is_voter|_order$|^order$/;

function setup(name, result) {
  const reg = {};
  const server = { tool: (n, _d, schema, handler) => { reg[n] = { schema, handler }; } };
  addFieldsParam(server);
  server.tool(name, "d", {}, async () => result);
  return reg[name];
}

for (const fam of FAMILIES) {
  for (const verb of fam === "milestones" ? ["list", "get"] : VERBS) {
    const name = `taiga_${fam}_${verb}`;
    const shape = verb === "list" ? [item(1), item(2), item(3)] : item(1);
    test(`${name}: compact is accepted, json format byte-identical, compact drops decoration`, async () => {
      const full = text(shape);
      const t = setup(name, full);
      assert.ok("compact" in t.schema, "schema exposes compact");
      assert.deepEqual(await t.handler({ format: "json" }, {}), full);
      const c = await t.handler({ format: "json", compact: true }, {});
      const parsed = JSON.parse(c.content[0].text);
      for (const it of [].concat(parsed)) {
        for (const k of ["id", "ref", "version"]) assert.ok(k in it, `${k} kept`);
        assert.deepEqual(Object.keys(it).filter((k) => DROPPED.test(k)), []);
      }
      assert.ok(c.content[0].text.length * 3 < full.content[0].text.length);
    });
  }
}

test("explicit fields keeps precedence over compact on reads", async () => {
  const t = setup("taiga_tasks_get", text(item(1)));
  const parsed = JSON.parse((await t.handler({ format: "json", fields: "status", compact: true }, {})).content[0].text);
  assert.deepEqual(Object.keys(parsed).sort(), ["id", "ref", "status", "version"]);
});

test("errors and non-JSON pass through with compact on reads", async () => {
  const err = { isError: true, content: [{ type: "text", text: "Taiga API error" }] };
  assert.deepEqual(await setup("taiga_tasks_get", err).handler({ format: "json", compact: true }, {}), err);
  const raw = { content: [{ type: "text", text: "not json" }] };
  assert.deepEqual(await setup("taiga_tasks_get", raw).handler({ format: "json", compact: true }, {}), raw);
});

test("compact drops noise recursively and keeps non-noise nested data", async () => {
  const nested = { ...item(1), user_stories: [{ ...item(2), tags: ["a"], deep: { owner_extra_info: { x: 1 }, kept: 1, list: [{ order: 3, keep: 2 }] } }] };
  const t = setup("taiga_milestones_get", text(nested));
  const parsed = JSON.parse((await t.handler({ format: "json", compact: true }, {})).content[0].text);
  const noisy = [];
  const walk = (v) => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { if (DROPPED.test(k)) noisy.push(k); walk(x); } };
  walk(parsed);
  assert.deepEqual(noisy, []);
  const us = parsed.user_stories[0];
  assert.deepEqual([us.id, us.ref, us.version, us.subject, us.tags], [2, 12, 4, "S2", ["a"]]);
  assert.deepEqual(us.deep, { kept: 1, list: [{ keep: 2 }] });
  assert.deepEqual(await t.handler({ format: "json" }, {}), text(nested));
});

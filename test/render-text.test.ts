import { test } from "node:test";
import assert from "node:assert/strict";
import { renderText } from "../dist/render.js";
import { addFieldsParam } from "../dist/fields.js";

const task = {
  id: 5016, ref: 803, version: 16, subject: "Prove and repair", status: 330, due_date: null, comment: "",
  tags: [["scheduler", null], ["tech-debt", null]], attachments: [],
  owner_extra_info: { username: "x", gravatar_id: "g" }, watchers: [5],
  description: "**Purpose**\nClose Issue #798\n\n**Do not**\nPush.",
};
const wrap = (o) => ({ content: [{ type: "text", text: JSON.stringify(o) }] });


function tool(name, result) {
  let handler;
  const server = { tool: (n, _d, _s, h) => { if (n === name) handler = h; } };
  addFieldsParam(server);
  server.tool(name, "d", {}, async () => result);
  return handler;
}

test("renderText keeps scalar values, drops null/empty, and keeps multi-line text verbatim", () => {
  const out = renderText({ id: 1, subject: "S", due_date: null, comment: "", attachments: [], description: "a\nb" });
  assert.match(out, /id: 1 \| subject: S/);
  assert.doesNotMatch(out, /due_date|comment|attachments/);
  assert.match(out, /description:\n {2}a\n {2}b/);
});

test("renderText flattens tag tuples and lists of scalars", () => {
  assert.match(renderText(task), /tags: scheduler, tech-debt/);
});

test("reads default to text without JSON syntax or noise", async () => {
  const res = await tool("taiga_tasks_get", wrap(task))({}, {});
  const t = res.content[0].text;
  assert.doesNotMatch(t, /[{}"]/);
  assert.doesNotMatch(t, /extra_info|gravatar|watchers/);
  assert.match(t, /\*\*Purpose\*\*/);
  assert.ok(t.length < JSON.stringify(task).length);
});

test("format=json keeps the raw JSON; fields still projects", async () => {
  const h = tool("taiga_tasks_get", wrap(task));
  assert.deepEqual(await h({ format: "json" }, {}), wrap(task));
  const f = await h({ format: "json", fields: "subject" }, {});
  assert.deepEqual(JSON.parse(f.content[0].text), { id: 5016, ref: 803, version: 16, subject: "Prove and repair" });
});

test("fields in text format renders only the projection", async () => {
  const t = (await tool("taiga_tasks_get", wrap(task))({ fields: "subject" }, {})).content[0].text;
  assert.match(t, /subject: Prove and repair/);
  assert.doesNotMatch(t, /description|status/);
});

test("lists render one block per item", async () => {
  const t = (await tool("taiga_tasks_list", wrap([task, { ...task, ref: 804 }]))({}, {})).content[0].text;
  assert.equal(t.split("\n- ").length + (t.startsWith("- ") ? 0 : 0) >= 2, true);
  assert.match(t, /ref: 804/);
});

test("history and search are text-by-default read tools; errors pass through", async () => {
  assert.ok(tool("taiga_task_history", wrap([{ comment: "hello" }])));
  const err = { isError: true, content: [{ type: "text", text: "Taiga API error" }] };
  assert.deepEqual(await tool("taiga_search", err)({}, {}), err);
});

test("history text drops the duplicated id-based diff but json keeps it", async () => {
  const h = [{ id: "a", created_at: "t", comment: "why it moved", diff: { status: [1, 2] }, values_diff: { status: ["A", "B"] }, values: { x: 1 }, key: "tasks.task:1" }];
  const text = (await tool("taiga_task_history", wrap(h))({}, {})).content[0].text;
  assert.match(text, /why it moved/);
  assert.match(text, /status:/);
  assert.doesNotMatch(text, /tasks\.task|values:\s*\n?\s*x/);
  assert.doesNotMatch(text, /\b1, 2\b/);
  const edit = [{ id: "b", values_diff: {}, diff: { description: ["old text", "new text"] } }];
  const et = (await tool("taiga_task_history", wrap(edit))({}, {})).content[0].text;
  assert.match(et, /old text/);
  assert.match(et, /new text/);
  const json = JSON.parse((await tool("taiga_task_history", wrap(h))({ format: "json" }, {})).content[0].text);
  assert.ok(json[0].diff && json[0].key);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { registerTaskTools } from "../dist/tools/tasks.js";

// Issue #190 / Story #217. Same Taiga contract as create (Issue #67): a task linked to a user story always
// belongs to that story's Sprint and Taiga silently ignores a different milestone on PATCH, so update must
// reject the conflict before the PATCH instead of reporting a successful no-op.
function setup({ taskStory = null, stories = { 5: 127, 6: 127 } } = {}) {
  const reg = {};
  const server = { tool: (name, _d, schema, handler) => { reg[name] = { schema, handler }; } };
  const calls = [];
  const client = {
    get: async (path) => {
      calls.push(["get", path]);
      if (path === "/tasks/9") return { id: 9, user_story: taskStory, milestone: taskStory ? stories[taskStory] : 70, version: 3 };
      const m = path.match(/^\/userstories\/(\d+)$/);
      if (m) return { id: Number(m[1]), milestone: stories[m[1]] ?? null };
      throw new Error(`unexpected GET ${path}`);
    },
    patch: async (path, body) => { calls.push(["patch", path, body]); return { id: 9, ...body }; },
  };
  registerTaskTools(server, client);
  return { update: reg["taiga_tasks_update"], calls };
}
const kinds = (calls) => calls.map((c) => c[0]);

test("standalone task: milestone update is forwarded, no story is read", async () => {
  const { update, calls } = setup({ taskStory: null });
  const res = await update.handler({ id: 9, milestone: 70, version: 3 }, {});
  assert.equal(res.isError, undefined);
  assert.equal(calls.filter((c) => c[0] === "patch").length, 1);
  assert.ok(!calls.some((c) => String(c[1]).startsWith("/userstories")));
});

test("linked task with its story's own milestone: updated normally", async () => {
  const { update, calls } = setup({ taskStory: 5 });
  const res = await update.handler({ id: 9, milestone: 127, version: 3 }, {});
  assert.equal(res.isError, undefined);
  assert.equal(kinds(calls).at(-1), "patch");
});

test("linked task with a conflicting milestone: rejected before the PATCH", async () => {
  for (const storyMilestone of [127, null]) {
    const { update, calls } = setup({ taskStory: 5, stories: { 5: storyMilestone } });
    const res = await update.handler({ id: 9, milestone: 70, version: 3 }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /inherits the story's Sprint/);
    assert.ok(!kinds(calls).includes("patch"), "no PATCH must be sent");
  }
});

test("linked task update without milestone: no story lookup, updated normally", async () => {
  const { update, calls } = setup({ taskStory: 5 });
  await update.handler({ id: 9, subject: "x", version: 3 }, {});
  assert.deepEqual(kinds(calls), ["patch"]);
});

test("combined user_story + milestone validates against the TARGET story", async () => {
  let t = setup({ taskStory: 5, stories: { 5: 70, 6: 127 } });
  let res = await t.update.handler({ id: 9, user_story: 6, milestone: 127, version: 3 }, {});
  assert.equal(res.isError, undefined);
  assert.equal(kinds(t.calls).at(-1), "patch");
  t = setup({ taskStory: 5, stories: { 5: 70, 6: 127 } });
  res = await t.update.handler({ id: 9, user_story: 6, milestone: 70, version: 3 }, {});
  assert.equal(res.isError, true);
  assert.ok(!kinds(t.calls).includes("patch"));
});

test("schema documents the contract", () => {
  const { update } = setup();
  assert.match(update.schema.milestone.description, /standalone/i);
});

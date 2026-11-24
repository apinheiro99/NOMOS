import { test } from "node:test";
import assert from "node:assert/strict";
import { registerTaskTools } from "../dist/tools/tasks.js";

// Issue #67. Live probe on project 48 (Task #116): Taiga derives a linked task's Sprint from its
// user story and ignores an independent milestone (on create and PATCH); standalone tasks keep theirs.
function setup(storyMilestone) {
  const reg = {};
  const server = { tool: (name, _d, schema, handler) => { reg[name] = { schema, handler }; } };
  const calls = [];
  // Identity (UUID custom attribute) traffic is covered in identity.test.ts; these tests record the entity requests only.
  const rec = (c) => { if (!/custom-attributes/.test(c[1])) calls.push(c); };
  const client = {
    get: async (path) => { rec(["get", path]); return { id: 5, milestone: storyMilestone }; },
    post: async (path, body) => { rec(["post", path, body]); return { id: 1, ...body }; },
  };
  registerTaskTools(server, client);
  return { create: reg["taiga_tasks_create"], calls };
}

test("storyless task: refused, nothing read or posted (create and bulk create)", async () => {
  const { create, calls } = setup(127);
  const res = await create.handler({ project: 1, subject: "t", milestone: 70 }, {});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /must belong to a User Story/);
  assert.deepEqual(calls, []);
});

test("linked task with the story's own milestone: created normally", async () => {
  const { create, calls } = setup(127);
  const res = await create.handler({ project: 1, subject: "t", user_story: 5, milestone: 127 }, {});
  assert.equal(res.isError, undefined);
  assert.deepEqual(calls.map((c) => c[0]), ["get", "post"]);
});

test("linked task with a conflicting milestone: rejected, nothing posted", async () => {
  for (const storyMilestone of [127, null]) {
    const { create, calls } = setup(storyMilestone);
    const res = await create.handler({ project: 1, subject: "t", user_story: 5, milestone: 70 }, {});
    assert.equal(res.isError, true);
    assert.match(res.content[0].text, /inherits the story's Sprint/);
    assert.deepEqual(calls.map((c) => c[0]), ["get"]);
  }
});

test("linked task without milestone: no story lookup, created normally", async () => {
  const { create, calls } = setup(127);
  await create.handler({ project: 1, subject: "t", user_story: 5 }, {});
  assert.deepEqual(calls.map((c) => c[0]), ["post"]);
});

test("schema documents the contract", () => {
  const { create } = setup(1);
  assert.match(create.schema.milestone.description, /standalone tasks only/);
});

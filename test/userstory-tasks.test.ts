import { test } from "node:test";
import assert from "node:assert/strict";
import { registerUserStoryTools } from "../dist/tools/userstories.js";

function setup() {
  const handlers = {};
  const server = { tool: (name, _d, _s, handler) => { handlers[name] = handler; } };
  const calls = [];
  const client = { get: async (path, params) => { calls.push([path, params]); return {}; } };
  registerUserStoryTools(server, client);
  return { handlers, calls };
}

test("userstories_get requests include_tasks=true", async () => {
  const { handlers, calls } = setup();
  await handlers["taiga_userstories_get"]({ id: 1136 });
  assert.deepEqual(calls, [["/userstories/1136", { include_tasks: true }]]);
});

test("userstories_get_by_ref requests include_tasks=true", async () => {
  const { handlers, calls } = setup();
  await handlers["taiga_userstories_get_by_ref"]({ ref: 94, project: 48 });
  assert.deepEqual(calls, [["/userstories/by_ref", { ref: 94, project: 48, include_tasks: true }]]);
});

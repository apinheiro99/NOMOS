import { test } from "node:test";
import assert from "node:assert/strict";
import { registerEpicTools } from "../dist/tools/epics.js";

function setup() {
  const handlers = {};
  const server = { tool: (name, _d, _s, handler) => { handlers[name] = handler; } };
  const calls = [];
  const client = { post: async (path, body) => { calls.push([path, body]); return {}; }, get: async () => ({}) };
  registerEpicTools(server, client);
  return { handlers, calls };
}

test("related_userstories_add sends epic and user_story in the body", async () => {
  const { handlers, calls } = setup();
  await handlers["taiga_epics_related_userstories_add"]({ epic_id: 326, user_story: 1151 });
  assert.deepEqual(calls, [["/epics/326/related_userstories", { epic: 326, user_story: 1151 }]]);
});

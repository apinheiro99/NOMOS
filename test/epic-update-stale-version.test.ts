import { test } from "node:test";
import assert from "node:assert/strict";
import { registerEpicTools } from "../dist/tools/epics.js";

// Issue #207 / Story #221 / Task #222 (RED). Live probe: Taiga accepts an Epic PATCH carrying a stale
// version (200, change applied), so the documented optimistic conflict check does not hold upstream.
// Contract under test: the MCP reads the current version first and rejects a different caller version
// before any mutation; a matching version is PATCHed.
function setup(currentVersion = 2) {
  const reg = {};
  const server = { tool: (name, _d, schema, handler) => { reg[name] = { schema, handler }; } };
  const calls = [];
  const client = {
    get: async (path) => { calls.push(["get", path]); return { id: 7, version: currentVersion }; },
    patch: async (path, body) => { calls.push(["patch", path, body]); return { id: 7, version: currentVersion + 1, ...body }; },
  };
  registerEpicTools(server, client);
  return { update: reg["taiga_epics_update"], calls };
}
const patches = (calls) => calls.filter((c) => c[0] === "patch");

test("current version: update succeeds and PATCHes", async () => {
  const { update, calls } = setup(2);
  const res = await update.handler({ id: 7, subject: "x", version: 2 }, {});
  assert.equal(res.isError, undefined);
  assert.equal(patches(calls).length, 1);
  assert.equal(patches(calls)[0][1], "/epics/7");
});

test("stale version: rejected with a conflict error before any PATCH", async () => {
  const { update, calls } = setup(2);
  const res = await update.handler({ id: 7, status: 5, version: 1 }, {});
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /version/i);
  assert.equal(patches(calls).length, 0, "no PATCH may be sent for a stale version");
});

test("version ahead of the stored one is also rejected", async () => {
  const { update, calls } = setup(2);
  const res = await update.handler({ id: 7, subject: "x", version: 9 }, {});
  assert.equal(res.isError, true);
  assert.equal(patches(calls).length, 0);
});

test("status and order updates with the current version still work", async () => {
  const { update, calls } = setup(4);
  const res = await update.handler({ id: 7, status: 5, epics_order: 3, version: 4 }, {});
  assert.equal(res.isError, undefined);
  assert.deepEqual(patches(calls)[0][2], { status: 5, epics_order: 3, version: 4 });
});

test("version stays required by the schema", () => {
  const { update } = setup();
  assert.ok("version" in update.schema);
  assert.equal(update.schema.version.isOptional(), false);
});

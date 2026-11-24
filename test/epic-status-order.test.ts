import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { registerEpicTools } from "../dist/tools/epics.js";

// Issue #68 / Story #118: epics create/update take optional status and epics_order. Mock data only.
// Live probe on project 48 (Task #120): Taiga stores both on POST and PATCH and reads them back.
// The MCP SDK runs the tool arguments through z.object(schema), which strips keys the schema does
// not declare, so the contract is checked through the schema first and the handler second.
// Identity (UUID custom attribute) traffic is covered in identity.test.ts; these tests assert the entity requests only.
const core = (c) => c.filter((x) => !/custom-attributes/.test(x[1]));
function setup(currentVersion = 4) {
  const reg = {};
  const server = { tool: (name, _d, schema, handler) => { reg[name] = { schema, handler }; } };
  const calls = [];
  const client = {
    get: async (path) => { calls.push(["get", path]); return { id: 9, version: currentVersion }; },
    post: async (path, body) => { calls.push(["post", path, body]); return { id: 1, version: 1, ...body }; },
    patch: async (path, body) => { calls.push(["patch", path, body]); return { id: 1, version: 2, ...body }; },
  };
  registerEpicTools(server, client);
  return { reg, calls };
}
const viaSdk = (tool, args) => tool.handler(z.object(tool.schema).parse(args), {});

test("#68: epics_create forwards status and epics_order after SDK argument parsing", async () => {
  const { reg, calls } = setup();
  await viaSdk(reg["taiga_epics_create"], { project: 48, subject: "E", status: 7, epics_order: 3 });
  assert.deepEqual(core(calls), [["post", "/epics", { project: 48, subject: "E", status: 7, epics_order: 3 }]]);
});

test("#68: epics_update forwards status and epics_order with version, id stays in the path", async () => {
  const { reg, calls } = setup();
  await viaSdk(reg["taiga_epics_update"], { id: 9, version: 4, status: 8, epics_order: 2 });
  assert.deepEqual(core(calls), [["get", "/epics/9"], ["patch", "/epics/9", { version: 4, status: 8, epics_order: 2 }]]);
});

test("existing behaviour holds: update without status/order sends only the given fields and version", async () => {
  const { reg, calls } = setup();
  await viaSdk(reg["taiga_epics_update"], { id: 9, version: 4, subject: "S" });
  assert.deepEqual(core(calls), [["get", "/epics/9"], ["patch", "/epics/9", { version: 4, subject: "S" }]]);
});

test("existing behaviour holds: create without status/order sends only the given fields", async () => {
  const { reg, calls } = setup();
  await viaSdk(reg["taiga_epics_create"], { project: 48, subject: "E" });
  assert.deepEqual(core(calls), [["post", "/epics", { project: 48, subject: "E" }]]);
});

test("update with a stale version is rejected before any PATCH (production version check is kept)", async () => {
  const { reg, calls } = setup(5);
  const res = await viaSdk(reg["taiga_epics_update"], { id: 9, version: 4, status: 8 });
  assert.equal(res.isError, true);
  assert.equal(calls.filter((c) => c[0] === "patch").length, 0);
});

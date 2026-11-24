import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { TaigaClient } from "../dist/client.js";
import { registerUserStoryTools } from "../dist/tools/userstories.js";

// Story #130 / Issue #87: this Taiga deployment answers 405 to POST /userstories/bulk_update_sprint_order
// (verified live in sandbox project 49). The accepted route is PATCH /userstories/{id} with
// { sprint_order, version }, which changes nothing else. Mock data only.
const realFetch = globalThis.fetch;
const env = { TAIGA_URL: "http://taiga.invalid", TAIGA_USERNAME: "u", TAIGA_PASSWORD: "p" };
const saved = {};
let requests;

beforeEach(() => {
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  requests = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/auth")) return new Response(JSON.stringify({ auth_token: "t", refresh: "r" }), { status: 200 });
    const method = init.method ?? "GET";
    const u = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method, path: u.pathname.replace(/^.*\/api\/v1/, ""), body });
    if (method === "POST" && u.pathname.endsWith("/bulk_update_sprint_order")) return new Response("{}", { status: 405 });
    const id = Number(u.pathname.split("/").pop());
    if (method === "GET") return new Response(JSON.stringify({ id, version: id + 100 }), { status: 200 });
    return new Response(JSON.stringify({ id, version: id + 101, ...body }), { status: 200 });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function setup() {
  const reg = {};
  const server = { tool: (name, _d, schema, handler) => { reg[name] = { schema, handler }; } };
  registerUserStoryTools(server, new TaigaClient());
  return reg;
}
// The MCP SDK validates arguments with z.object(schema), which drops undeclared keys.
const call = (t, args) => t.handler(z.object(t.schema).parse(args), {});

test("RED #87: taiga_userstories_update exposes sprint_order", () => {
  assert.ok(setup().taiga_userstories_update.schema.sprint_order, "sprint_order missing from schema");
});

test("RED #87: taiga_userstories_update sends sprint_order and version in one PATCH, nothing else", async () => {
  await call(setup().taiga_userstories_update, { id: 7, version: 3, sprint_order: 99 });
  assert.deepEqual(requests, [{ method: "PATCH", path: "/userstories/7", body: { sprint_order: 99, version: 3 } }]);
});

test("RED #87: bulk sprint-order tool does not rely on the 405 bulk endpoint", async () => {
  const r = await call(setup().taiga_userstories_bulk_update_sprint_order, { project_id: 49, bulk_stories: [[7, 30], [8, 20]] });
  assert.ok(!r.isError, JSON.stringify(r));
  assert.deepEqual(requests.filter((q) => q.path.endsWith("/bulk_update_sprint_order")), []);
});

test("RED #87: bulk sprint-order tool PATCHes each story with its fresh version and only sprint_order", async () => {
  await call(setup().taiga_userstories_bulk_update_sprint_order, { project_id: 49, bulk_stories: [[7, 30], [8, 20]] });
  const patches = requests.filter((q) => q.method === "PATCH");
  assert.deepEqual(patches, [
    { method: "PATCH", path: "/userstories/7", body: { sprint_order: 30, version: 107 } },
    { method: "PATCH", path: "/userstories/8", body: { sprint_order: 20, version: 108 } },
  ]);
});

test("guard: the backlog and kanban bulk order tools no longer exist", () => {
  const reg = setup();
  assert.equal(reg.taiga_userstories_bulk_update_backlog_order, undefined);
  assert.equal(reg.taiga_userstories_bulk_update_kanban_order, undefined);
});

test("guard: taiga_userstories_update without sprint_order keeps its body unchanged", async () => {
  await call(setup().taiga_userstories_update, { id: 7, version: 3, subject: "x" });
  assert.deepEqual(requests, [{ method: "PATCH", path: "/userstories/7", body: { subject: "x", version: 3 } }]);
});

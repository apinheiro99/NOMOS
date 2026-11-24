import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { TaigaClient } from "../dist/client.js";
import { registerTaskTools } from "../dist/tools/tasks.js";

// This MCP orders Tasks with ONE field, taskboard_order (the position in the taskboard column); us_order is not part of the
// MCP surface any more (PO decision 2026-11-20). PATCH /tasks/{id} accepts it alone, and POST /tasks/bulk_update_taskboard_order
// accepts { project_id, bulk_tasks: [{task_id, order}], ... } (the [[id, order]] pair shape is a 400). Mock data only.
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
    if (method === "POST" && u.pathname.includes("/bulk_update_")) {
      const ok = Array.isArray(body?.bulk_tasks) && body.bulk_tasks.every((t) => typeof t === "object" && !Array.isArray(t));
      return new Response("{}", { status: ok ? 200 : 400 });
    }
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
  registerTaskTools(server, new TaigaClient());
  return reg;
}
const run = (t, args) => t.handler(z.object(t.schema).parse(args), {});

test("taiga_tasks_update exposes taskboard_order and no us_order", () => {
  const t = setup().taiga_tasks_update;
  assert.ok("taskboard_order" in t.schema, "taskboard_order missing");
  assert.ok(!("us_order" in t.schema), "us_order must not exist");
});

test("taiga_tasks_update sends taskboard_order alone with the version and nothing else", async () => {
  await run(setup().taiga_tasks_update, { id: 7, version: 3, taskboard_order: 40 });
  assert.deepEqual(requests.filter((r) => r.method !== "GET"), [{ method: "PATCH", path: "/tasks/7", body: { taskboard_order: 40, version: 3 } }]);
});

test("taiga_tasks_bulk_update_taskboard_order POSTs {task_id, order} objects in the requested sequence; the us_order bulk tool does not exist", async () => {
  const reg = setup();
  assert.ok(!reg.taiga_tasks_bulk_update_us_order, "the us_order bulk tool must not be registered");
  await run(reg.taiga_tasks_bulk_update_taskboard_order, { project_id: 49, bulk_tasks: [[3, 10], [2, 20], [1, 30]] });
  const posts = requests.filter((r) => r.method === "POST");
  assert.equal(posts.length, 1);
  assert.equal(posts[0].path, "/tasks/bulk_update_taskboard_order");
  assert.deepEqual(posts[0].body.bulk_tasks, [{ task_id: 3, order: 10 }, { task_id: 2, order: 20 }, { task_id: 1, order: 30 }]);
  assert.equal(posts[0].body.project_id, 49);
});

test("a Task read never carries us_order, whatever Taiga returns", async () => {
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => (String(url).endsWith("/auth") || (init.method && init.method !== "GET") ? real(url, init) : new Response(JSON.stringify({ id: 7, us_order: 12, taskboard_order: 2 }), { status: 200 }));
  const reg = setup();
  const out = JSON.parse((await run(reg.taiga_tasks_get, { id: 7 })).content[0].text);
  assert.deepEqual(out, { id: 7, taskboard_order: 2 });
});

test("guard: existing task fields still pass through taiga_tasks_update unchanged", async () => {
  await run(setup().taiga_tasks_update, { id: 7, version: 3, subject: "s", status: 333 });
  assert.deepEqual(requests.filter((r) => r.method !== "GET")[0].body, { subject: "s", status: 333, version: 3 });
});

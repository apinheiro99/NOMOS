import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { TaigaClient } from "../dist/client.js";
import { registerMilestoneTools } from "../dist/tools/milestones.js";

// Story #138 / Issue #89: verified live in sandbox project 49, a milestone's visual/return order is its
// `order` field, ascending: GET /milestones?project=X returns Sprints sorted by `order` (ties fall back to
// newest start first), and order_by is ignored. PATCH /milestones/{id} {order} is accepted and persists,
// changing nothing else; milestones carry no version. POST /milestones/bulk_update_order answers 405 in this
// deployment. Mock data only.
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
    if (method === "POST" && u.pathname.endsWith("/bulk_update_order")) return new Response("{}", { status: 405 });
    const id = Number(u.pathname.split("/").pop());
    return new Response(JSON.stringify({ id, ...body }), { status: 200 });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function setup() {
  const reg = {};
  const server = { tool: (name, _d, schema, handler) => { reg[name] = { schema, handler }; } };
  registerMilestoneTools(server, new TaigaClient());
  return reg;
}
const run = (t, args) => t.handler(z.object(t.schema).parse(args), {});
const writes = () => requests.filter((r) => r.method !== "GET");

test("taiga_milestones_update exposes the order field", () => {
  assert.ok("order" in setup().taiga_milestones_update.schema, "order missing");
});

test("taiga_milestones_update sends order alone, without name, dates or closed", async () => {
  await run(setup().taiga_milestones_update, { id: 12, order: 3 });
  assert.deepEqual(writes(), [{ method: "PATCH", path: "/milestones/12", body: { order: 3 } }]);
});

test("order placement never goes through the 405 bulk endpoint", async () => {
  await run(setup().taiga_milestones_update, { id: 12, order: 3 });
  assert.ok(!requests.some((r) => r.path.endsWith("/bulk_update_order")));
});

test("guard: existing milestone fields still pass through unchanged", async () => {
  await run(setup().taiga_milestones_update, { id: 12, name: "n", estimated_start: "2026-10-01", estimated_finish: "2026-10-07", closed: false });
  assert.deepEqual(writes()[0].body, { name: "n", estimated_start: "2026-10-01", estimated_finish: "2026-10-07", closed: false });
});

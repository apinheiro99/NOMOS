import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { TaigaClient } from "../dist/client.js";

// Story #146 / Issue #91, contract verified live in sandbox project 49 (mock data only here):
// - Tasks: ONE order, taskboard_order (the taskboard column = same status + milestone), the only Task position this MCP has
//   (PO decision 2026-11-20; us_order is gone). kind "task" moves a Task inside its own column; it is written only by
//   POST /tasks/bulk_update_taskboard_order with bulk_tasks [{task_id, order}]; bulk writes are exact, so a move renumbers its
//   column 1..n. Reads: order_by=taskboard_order is NOT honoured (verified live), so reads sort client-side.
// - Stories in a Sprint: PATCH /userstories/{id} {sprint_order, version}. The deployment shifts on collision:
//   setting an occupied order puts the item BEFORE the occupant ("before X" = X.order, "after X" = X.order+1).
//   Reads need order_by=sprint_order.
// - Story in Epic: PATCH /epics/{e}/related_userstories/{us} {order}, same shift-on-collision.
// - Sprint order: no supported API (Issue #89 rejected): typed unsupported result, no writes.
const realFetch = globalThis.fetch;
const env = { TAIGA_URL: "http://taiga.invalid", TAIGA_USERNAME: "u", TAIGA_PASSWORD: "p" };
const saved = {};
let requests, world;

beforeEach(() => {
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  requests = [];
  world = {
    tasksInColumn: [{ id: 1, taskboard_order: 1, status: 332, milestone: 50 }, { id: 2, taskboard_order: 2, status: 332, milestone: 50 }, { id: 3, taskboard_order: 3, status: 332, milestone: 50 }],
    storiesInSprint: [{ id: 11, sprint_order: 10, version: 4 }, { id: 12, sprint_order: 20, version: 7 }, { id: 13, sprint_order: 30, version: 2 }],
    epicRelations: [{ user_story: 11, order: 1 }, { user_story: 12, order: 2 }, { user_story: 13, order: 3 }],
  };
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/auth")) return new Response(JSON.stringify({ auth_token: "t", refresh: "r" }), { status: 200 });
    const u = new URL(String(url));
    const path = u.pathname.replace(/^.*\/api\/v1/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method, path, query: Object.fromEntries(u.searchParams), body });
    const ok = (x) => new Response(JSON.stringify(x), { status: 200 });
    if (method === "GET") {
      if (path === "/tasks") return ok(world.tasksInColumn);
      if (path.startsWith("/tasks/")) { const id = Number(path.split("/")[2]); return ok({ id, user_story: 100, milestone: 50, status: 332, project: 49, ...(world.taskOverride?.[id] ?? {}) }); }
      if (path === "/userstories") return ok(world.storiesInSprint);
      if (path.startsWith("/userstories/")) return ok(world.storiesInSprint.find((s) => s.id === Number(path.split("/")[2])) ?? { id: 0, milestone: 50, project: 49 });
      if (path.endsWith("/related_userstories")) return ok(world.epicRelations);
    }
    return ok({ ...body });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

async function tool() {
  const mod = await import("../dist/tools/move.js").catch(() => ({}));
  assert.equal(typeof mod.registerMoveTools, "function", "registerMoveTools missing in dist/tools/move.js");
  const reg = {};
  mod.registerMoveTools({ tool: (name, _d, schema, handler) => { reg[name] = { schema, handler }; } }, new TaigaClient());
  assert.ok(reg.taiga_move, "taiga_move missing");
  return reg.taiga_move;
}
const run = async (args) => { const t = await tool(); return t.handler(z.object(t.schema).parse(args), {}); };
const writes = () => requests.filter((r) => r.method !== "GET");
const text = (r) => JSON.parse(r.content[0].text);

test("taiga_move exposes intent fields, not raw order numbers", async () => {
  const t = await tool();
  for (const k of ["kind", "id", "container_id", "direction", "before_id", "after_id"]) assert.ok(k in t.schema, `${k} missing`);
  assert.ok(!("order" in t.schema), "raw order must not be the primary interface");
});

test("task down: one taskboard_order bulk write scoped to the Task's status and Sprint, renumbering the column 1..n", async () => {
  await run({ kind: "task", id: 1, container_id: 50, direction: "down" });
  assert.deepEqual(writes().map((w) => w.path), ["/tasks/bulk_update_taskboard_order"]);
  assert.deepEqual(writes()[0].body.bulk_tasks, [{ task_id: 2, order: 1 }, { task_id: 1, order: 2 }, { task_id: 3, order: 3 }]);
  assert.equal(writes()[0].body.status_id, 332);
  assert.equal(writes()[0].body.milestone_id, 50);
  assert.equal(requests.find((r) => r.method === "GET" && r.path === "/tasks").query.order_by, "taskboard_order");
});

test("task: only taskboard_order exists; the us_order kinds are gone and a container that is not the Task's Sprint writes nothing", async () => {
  const t = await tool();
  for (const kind of ["task_in_story", "task_in_taskboard"]) assert.equal(z.object(t.schema).safeParse({ kind, id: 1, container_id: 50, direction: "up" }).success, false, kind);
  const r = await run({ kind: "task", id: 1, container_id: 999, direction: "down" });
  assert.equal(r.isError, true);
  assert.equal(text(r).code, "container_is_not_the_task_sprint");
  assert.equal(writes().length, 0);
});

test("story_in_sprint: before takes the occupant's order, after takes occupant order + 1, one PATCH with fresh version", async () => {
  await run({ kind: "story_in_sprint", id: 13, container_id: 50, before_id: 12 });
  assert.deepEqual(writes().map((w) => [w.method, w.path, w.body]), [["PATCH", "/userstories/13", { sprint_order: 20, version: 2 }]]);
  requests.length = 0;
  await run({ kind: "story_in_sprint", id: 11, container_id: 50, after_id: 12 });
  assert.deepEqual(writes().map((w) => [w.path, w.body]), [["/userstories/11", { sprint_order: 21, version: 4 }]]);
});

test("story_in_sprint up/down resolve the neighbour, never send raw positions from the caller", async () => {
  await run({ kind: "story_in_sprint", id: 12, container_id: 50, direction: "up" });
  assert.deepEqual(writes().map((w) => w.body), [{ sprint_order: 10, version: 7 }]);
  assert.equal(requests.find((r) => r.method === "GET" && r.path === "/userstories").query.order_by, "sprint_order");
});

test("story_in_epic: one PATCH of the relation with order only", async () => {
  await run({ kind: "story_in_epic", id: 13, container_id: 5, direction: "up" });
  assert.deepEqual(writes().map((w) => [w.method, w.path, w.body]), [["PATCH", "/epics/5/related_userstories/13", { order: 2 }]]);
});

test("boundary: up on the first and down on the last are no-ops with zero writes", async () => {
  const first = text(await run({ kind: "task", id: 1, container_id: 50, direction: "up" }));
  const last = text(await run({ kind: "story_in_epic", id: 13, container_id: 5, direction: "down" }));
  assert.equal(writes().length, 0, JSON.stringify(writes()));
  assert.equal(first.moved, false); assert.equal(last.moved, false);
  assert.ok(first.noop && last.noop, "noop reason missing");
});

test("sprint moves return a typed unsupported result and write nothing", async () => {
  const r = await run({ kind: "sprint", id: 50, container_id: 49, direction: "up" });
  assert.equal(writes().length, 0);
  assert.equal(r.isError, true);
  assert.equal(text(r).code, "sprint_order_unsupported");
});

test("exactly one of direction, before_id, after_id is required", async () => {
  const none = await run({ kind: "task", id: 2, container_id: 50 });
  const two = await run({ kind: "task", id: 2, container_id: 50, direction: "up", before_id: 1 });
  assert.equal(none.isError, true); assert.equal(two.isError, true);
  assert.equal(writes().length, 0);
});

test("every successful move re-reads after the last write and returns the verified order", async () => {
  const r = await run({ kind: "story_in_epic", id: 13, container_id: 5, direction: "up" });
  const lastWrite = requests.map((x) => x.method).lastIndexOf("PATCH");
  assert.ok(requests.slice(lastWrite + 1).some((x) => x.method === "GET"), "no re-read after the write");
  assert.ok(Array.isArray(text(r).order), "result lacks the re-read order");
});

// Story #146 "no success without visible order verification": a taskboard write that the re-read does not show fails closed.
test("task: the bulk write is accepted but the column re-read keeps the old order -> fails closed", async () => {
  const r = await run({ kind: "task", id: 3, container_id: 50, direction: "up" });
  const body = text(r);
  assert.equal(body.moved, true);
  assert.equal(body.verified, false);
  assert.equal(r.isError, true);
});

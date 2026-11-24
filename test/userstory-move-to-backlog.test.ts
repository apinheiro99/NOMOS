import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { TaigaClient } from "../dist/client.js";

// Task #238 / Story #237 / Issue #236 (mock data only here): Sprint -> Backlog is PATCH /userstories/{id}
// {milestone: null, version}, then a reread that must show milestone null. Tasks stay attached through the Story.
const realFetch = globalThis.fetch;
const env = { TAIGA_URL: "http://taiga.invalid", TAIGA_USERNAME: "u", TAIGA_PASSWORD: "p" };
const saved = {};
let requests, world;

beforeEach(() => {
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  requests = [];
  world = {
    story: { id: 7, ref: 853, project: 47, milestone: 173, status: 1, version: 4, backlog_order: 12 },
    tasks: [{ id: 71 }, { id: 72 }],
    backlog: [{ backlog_order: 3 }, { backlog_order: 20 }],
    patchStatus: 200,
    clearMilestone: true,
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
      if (path === "/tasks") return ok(world.tasks);
      if (path === "/userstories") return ok(world.backlog);
      if (path === "/userstories/7") {
        if (world.failStoryGetAfterPatch && requests.some((q) => q.method === "PATCH")) return new Response("{}", { status: 502 });
        return ok(world.story);
      }
    }
    if (method === "PATCH" && path === "/userstories/7") {
      if (world.commitThenFail) {
        world.story = { ...world.story, milestone: body.milestone, version: world.story.version + 1 };
        return new Response("{}", { status: world.commitThenFail });
      }
      if (world.patchStatus !== 200) return new Response(JSON.stringify({ _error_type: "taiga.base.exceptions.WrongArguments", version: "stale" }), { status: world.patchStatus });
      if ("milestone" in body && world.clearMilestone) world.story = { ...world.story, milestone: body.milestone, version: world.story.version + 1 };
      if ("backlog_order" in body) world.story = { ...world.story, backlog_order: body.backlog_order, version: world.story.version + 1 };
      return ok(world.story);
    }
    return ok({});
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

async function tool(name = "taiga_userstory_move_to_backlog") {
  const mod = await import("../dist/tools/userstories.js");
  const reg = {};
  mod.registerUserStoryTools({ tool: (n, d, schema, handler) => { reg[n] = { description: d, schema, handler }; } }, new TaigaClient());
  assert.ok(reg[name], `${name} missing`);
  return reg[name];
}
const run = async (args) => { const t = await tool(); return t.handler(z.object(t.schema).parse(args), {}); };
const writes = () => requests.filter((r) => r.method !== "GET");
const text = (r) => JSON.parse(r.content[0].text);

test("discovery: dedicated tool takes only the Story id and says what it does; update points to it", async () => {
  const t = await tool();
  assert.deepEqual(Object.keys(t.schema), ["id"]);
  assert.match(t.description, /Sprint/);
  assert.match(t.description, /Backlog/);
  assert.match((await tool("taiga_userstories_update")).description, /taiga_userstory_move_to_backlog/);
});

test("Sprint -> Backlog: one PATCH with an actual null milestone and the fresh version, verified by reread", async () => {
  const r = await run({ id: 7 });
  assert.equal(r.isError, undefined);
  assert.deepEqual(writes().map((w) => [w.method, w.path, w.body]), [["PATCH", "/userstories/7", { milestone: null, version: 4 }]]);
  assert.equal(writes()[0].body.milestone, null);
  assert.ok("milestone" in writes()[0].body, "null must be transmitted, not dropped");
  const out = text(r);
  assert.equal(out.moved, true);
  assert.equal(out.verified, true);
  assert.equal(out.before.milestone, 173);
  assert.equal(out.after.milestone, null);
  assert.equal(out.after.id, 7);
  assert.equal(out.after.ref, 853);
  assert.equal(out.after.status, 1);
});

test("child Tasks stay attached to the same Story and are reported before and after", async () => {
  const out = text(await run({ id: 7 }));
  assert.deepEqual(out.tasks_before, [71, 72]);
  assert.deepEqual(out.tasks_after, [71, 72]);
  assert.ok(requests.filter((q) => q.path === "/tasks").every((q) => q.method === "GET" && q.query.user_story === "7"));
});

test("an existing backlog_order is kept: no second write", async () => {
  const out = text(await run({ id: 7 }));
  assert.equal(out.backlog_order_assigned, false);
  assert.equal(out.after.backlog_order, undefined, "backlog_order is never returned");
  assert.equal(writes().length, 1);
});

test("a Story with no backlog_order gets the end of the Backlog, a second PATCH with the new version", async () => {
  world.story.backlog_order = null;
  const out = text(await run({ id: 7 }));
  assert.equal(out.backlog_order_assigned, true);
  assert.equal(out.after.backlog_order, undefined);
  assert.deepEqual(writes().map((w) => w.body), [{ milestone: null, version: 4 }, { backlog_order: 21, version: 5 }]);
  assert.equal(requests.find((q) => q.path === "/userstories" && q.method === "GET").query.milestone__isnull, "true");
});

test("already in Backlog: idempotent no-op with zero writes", async () => {
  world.story.milestone = null;
  const r = await run({ id: 7 });
  assert.equal(r.isError, undefined);
  assert.equal(text(r).moved, false);
  assert.equal(text(r).noop, "already_in_backlog");
  assert.equal(writes().length, 0);
});

test("stale version or API failure is an explicit failure, no retry, no false success", async () => {
  world.patchStatus = 400;
  const r = await run({ id: 7 });
  assert.equal(r.isError, true);
  const out = text(r);
  assert.equal(out.moved, false);
  assert.equal(out.code, "move_failed");
  assert.equal(writes().length, 1);
});

test("server commits then the response is 502: reread reconciles to a verified success, no second write", async () => {
  world.commitThenFail = 502;
  const r = await run({ id: 7 });
  assert.equal(r.isError, undefined);
  const out = text(r);
  assert.equal(out.moved, true);
  assert.equal(out.verified, true);
  assert.equal(out.reconciled, true);
  assert.equal(out.after.milestone, null);
  assert.deepEqual(out.tasks_after, [71, 72]);
  assert.equal(writes().length, 1, "must not retry the write");
});

test("502 and the Story still has its Sprint: explicit move_failed, no retry", async () => {
  world.patchStatus = 502;
  const r = await run({ id: 7 });
  assert.equal(r.isError, true);
  assert.equal(text(r).code, "move_failed");
  assert.equal(writes().length, 1);
});

test("502 and the reconciliation reread also fails: move_failed that says so", async () => {
  world.patchStatus = 502;
  world.failStoryGetAfterPatch = true;
  const r = await run({ id: 7 });
  assert.equal(r.isError, true);
  assert.equal(text(r).code, "move_failed");
  assert.match(text(r).message, /reconciliation reread failed/);
  assert.equal(writes().length, 1);
});

test("a normal success reports reconciled:false", async () => {
  assert.equal(text(await run({ id: 7 })).reconciled, false);
});

test("milestone still set after the PATCH is a hard not_verified failure", async () => {
  world.clearMilestone = false;
  const r = await run({ id: 7 });
  assert.equal(r.isError, true);
  assert.equal(text(r).code, "not_verified");
  assert.equal(text(r).moved, false);
});

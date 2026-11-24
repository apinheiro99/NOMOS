import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { TaigaClient } from "../dist/client.js";

// Mock data only: Sprint -> Backlog for an Issue is PATCH /issues/{id} {milestone: null, version}, then a reread showing milestone null.
const realFetch = globalThis.fetch;
const env = { TAIGA_URL: "http://taiga.invalid", TAIGA_USERNAME: "u", TAIGA_PASSWORD: "p" };
const saved = {};
let requests, world;

beforeEach(() => {
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  requests = [];
  world = {
    issue: { id: 9, ref: 111, subject: "Open issue", project: 47, milestone: 173, status: 2, version: 6, description: "keep" },
    patchStatus: 200,
    clearMilestone: true,
  };
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/auth")) return new Response(JSON.stringify({ auth_token: "t", refresh: "r" }), { status: 200 });
    const u = new URL(String(url));
    const path = u.pathname.replace(/^.*\/api\/v1/, "");
    const method = init.method ?? "GET";
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method, path, body });
    const ok = (x) => new Response(JSON.stringify(x), { status: 200 });
    if (method === "GET" && path === "/issues/9") {
      if (world.failGetAfterPatch && requests.some((q) => q.method === "PATCH")) return new Response("{}", { status: 502 });
      return ok(world.issue);
    }
    if (method === "PATCH" && path === "/issues/9") {
      if (world.commitThenFail) {
        world.issue = { ...world.issue, milestone: body.milestone, version: world.issue.version + 1 };
        return new Response("{}", { status: world.commitThenFail });
      }
      if (world.patchStatus !== 200) return new Response("{}", { status: world.patchStatus });
      if (world.clearMilestone) world.issue = { ...world.issue, milestone: body.milestone, version: world.issue.version + 1 };
      if (world.mutateStatus) world.issue = { ...world.issue, status: 99 };
      return ok(world.issue);
    }
    return ok({});
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

async function tool(name = "taiga_issue_move_to_backlog") {
  const mod = await import("../dist/tools/issues.js");
  const reg = {};
  mod.registerIssueTools({ tool: (n, d, schema, handler) => { reg[n] = { description: d, schema, handler }; } }, new TaigaClient());
  assert.ok(reg[name], `${name} missing`);
  return reg[name];
}
const run = async (args) => { const t = await tool(); return t.handler(z.object(t.schema).parse(args), {}); };
const writes = () => requests.filter((r) => r.method !== "GET");
const text = (r) => JSON.parse(r.content[0].text);

test("discovery: takes only the Issue id; issues_update points to it", async () => {
  const t = await tool();
  assert.deepEqual(Object.keys(t.schema), ["id"]);
  assert.match(t.description, /Sprint/);
  assert.match(t.description, /Backlog/);
  assert.match((await tool("taiga_issues_update")).description, /taiga_issue_move_to_backlog/);
});

test("Sprint -> Backlog: one PATCH with an actual null milestone and the fresh version, verified by reread", async () => {
  const r = await run({ id: 9 });
  assert.equal(r.isError, undefined);
  assert.deepEqual(writes().map((w) => [w.method, w.path, w.body]), [["PATCH", "/issues/9", { milestone: null, version: 6 }]]);
  assert.ok("milestone" in writes()[0].body, "null must be transmitted, not dropped");
  const out = text(r);
  assert.equal(out.moved, true);
  assert.equal(out.verified, true);
  assert.equal(out.reconciled, false);
  assert.equal(out.before.milestone, 173);
  assert.equal(out.after.milestone, null);
  assert.equal(out.after.ref, 111);
  assert.equal(out.after.status, 2);
  assert.equal(out.after.subject, "Open issue");
});

test("already without a Sprint: idempotent no-op with zero writes", async () => {
  world.issue.milestone = null;
  const r = await run({ id: 9 });
  assert.equal(r.isError, undefined);
  assert.equal(text(r).noop, "already_in_backlog");
  assert.equal(text(r).moved, false);
  assert.equal(writes().length, 0);
});

test("stale version or API failure is an explicit failure, no retry", async () => {
  world.patchStatus = 400;
  const r = await run({ id: 9 });
  assert.equal(r.isError, true);
  assert.equal(text(r).code, "move_failed");
  assert.equal(writes().length, 1);
});

test("server commits then responds 502: reread reconciles to verified success, no second write", async () => {
  world.commitThenFail = 502;
  const r = await run({ id: 9 });
  assert.equal(r.isError, undefined);
  const out = text(r);
  assert.equal(out.moved, true);
  assert.equal(out.verified, true);
  assert.equal(out.reconciled, true);
  assert.equal(writes().length, 1);
});

test("502 and reconciliation reread also fails: move_failed that says so", async () => {
  world.patchStatus = 502;
  world.failGetAfterPatch = true;
  const r = await run({ id: 9 });
  assert.equal(r.isError, true);
  assert.match(text(r).message, /reconciliation reread failed/);
  assert.equal(writes().length, 1);
});

test("milestone still set after the PATCH is a hard not_verified failure", async () => {
  world.clearMilestone = false;
  const r = await run({ id: 9 });
  assert.equal(r.isError, true);
  assert.equal(text(r).code, "not_verified");
  assert.equal(text(r).moved, false);
});

test("status changed by the write fails closed (verified:false, isError)", async () => {
  world.mutateStatus = true;
  const r = await run({ id: 9 });
  assert.equal(r.isError, true);
  assert.equal(text(r).verified, false);
});

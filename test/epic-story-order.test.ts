import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { TaigaClient } from "../dist/client.js";
import { registerEpicTools } from "../dist/tools/epics.js";

// Story #142 / Issue #90: verified live in sandbox project 49. An Epic-Story relation has no id of its own:
// it is {epic, user_story, order}, addressed as /epics/{epic}/related_userstories/{user_story}. PATCH on that
// path with {order} persists and changes nothing on the Story. POST .../bulk_update_order and
// POST /userstories/bulk_update_epic_order answer 405. GET .../related_userstories ignores `order` and keeps
// returning creation order. Mock data only.
const realFetch = globalThis.fetch;
const env = { TAIGA_URL: "http://taiga.invalid", TAIGA_USERNAME: "u", TAIGA_PASSWORD: "p" };
const saved = {};
let requests;

beforeEach(() => {
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = env[k]; }
  requests = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).endsWith("/auth")) return new Response(JSON.stringify({ auth_token: "t", refresh: "r" }), { status: 200 });
    const u = new URL(String(url));
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ method: init.method ?? "GET", path: u.pathname.replace(/^.*\/api\/v1/, ""), body });
    return new Response(JSON.stringify({ epic: 5, user_story: 9, ...body }), { status: 200 });
  };
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

function setup() {
  const reg = {};
  const server = { tool: (name, _d, schema, handler) => { reg[name] = { schema, handler }; } };
  registerEpicTools(server, new TaigaClient());
  return reg;
}
const run = (t, args) => t.handler(z.object(t.schema).parse(args), {});
const writes = () => requests.filter((r) => r.method !== "GET");

test("a tool sets the order of one Epic-Story relation", () => {
  const t = setup().taiga_epics_related_userstories_update_order;
  assert.ok(t, "taiga_epics_related_userstories_update_order missing");
  for (const k of ["epic_id", "userstory_id", "order"]) assert.ok(k in t.schema, `${k} missing`);
});

test("it PATCHes the relation path with order alone", async () => {
  await run(setup().taiga_epics_related_userstories_update_order, { epic_id: 5, userstory_id: 9, order: 2 });
  assert.deepEqual(writes(), [{ method: "PATCH", path: "/epics/5/related_userstories/9", body: { order: 2 } }]);
});

test("it never uses the 405 bulk endpoints", async () => {
  await run(setup().taiga_epics_related_userstories_update_order, { epic_id: 5, userstory_id: 9, order: 2 });
  assert.ok(writes().every((r) => !/bulk_update/.test(r.path)), JSON.stringify(writes()));
});

function listWith(rels) {
  globalThis.fetch = async (url) => {
    if (String(url).endsWith("/auth")) return new Response(JSON.stringify({ auth_token: "t", refresh: "r" }), { status: 200 });
    return new Response(JSON.stringify(rels), { status: 200 });
  };
  return run(setup().taiga_epics_related_userstories_list, { epic_id: 5 }).then((r) => JSON.parse(r.content[0].text).map((x) => x.user_story));
}

test("list returns relations ascending by stored order", async () => {
  const rels = [[1, 30], [2, 10], [3, 40], [4, 20]].map(([user_story, order]) => ({ epic: 5, user_story, order }));
  assert.deepEqual(await listWith(rels), [2, 4, 1, 3]);
});

test("list keeps API order for equal or missing order values", async () => {
  const rels = [{ user_story: 1, order: 5 }, { user_story: 2, order: 5 }, { user_story: 3 }, { user_story: 4, order: 1 }];
  const got = await listWith(rels);
  assert.deepEqual(got.filter((x) => x === 1 || x === 2), [1, 2]);
  assert.equal(got.length, 4);
});

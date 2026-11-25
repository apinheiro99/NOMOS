import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { migrate } from "../dist/policy/migrate.js";
import { createPool } from "../dist/policy/repository.js";
import { mirrorProjects, plan } from "../dist/policy/mirror.js";
import { createPolicyRuntime } from "../dist/policy/runtime.js";
import { activePolicy } from "../dist/policy/service.js";
import { connect, createTestDatabase } from "./support/pg.ts";

// F3.1: the mirror, on real PostgreSQL with a fake Taiga. It reads Taiga, never writes a card, and never replaces a policy.
const BASE = "http://taiga.invalid";
const TASK = ["To Do", "In Progress", "GPT Validation", "Human Decision", "Done", "Cancelled"];
const STORY = ["Ready", "In Progress", "GPT Validation", "Done", "Human Decision", "Cancelled"];
type World = { projects: { id: number; slug: string; name: string }[]; statuses: Record<number, string[]>; dupUuid: number[]; writes: string[] };
let world: World;
const fake = () => ({
  getAll: async (path: string) => { if (path === "/projects") return world.projects; throw new Error(`unexpected ${path}`); },
  get: async (path: string, params: { project: number }) => {
    const names = world.statuses[params.project] ?? [];
    if (path === "/task-statuses") return names.map((name, id) => ({ id: id + 1, name }));
    if (path === "/userstory-statuses") return STORY.map((name, id) => ({ id: id + 1, name }));
    if (path === "/epic-statuses") return [{ id: 1, name: "New" }, { id: 2, name: "Done" }];
    if (path === "/roles") return [{ id: 1, name: "Product Owner" }];
    if (/custom-attributes$/.test(path)) return world.dupUuid.includes(params.project) ? [{ id: 1, name: "UUID" }, { id: 2, name: "uuid" }] : [{ id: 1, name: "UUID" }];
    throw new Error(`unexpected ${path}`);
  },
  post: async (path: string) => { world.writes.push(path); },
  patch: async (path: string) => { world.writes.push(path); },
}) as never;

let db: Awaited<ReturnType<typeof createTestDatabase>>;
let pool: ReturnType<typeof createPool>;
before(async () => {
  db = await createTestDatabase();
  const c = await connect(db.url);
  await migrate(c, fileURLToPath(new URL("../db/migrations", import.meta.url)));
  await c.end();
  pool = createPool(db.url, 5);
});
after(async () => {
  await pool.end();
  await db.drop();
});
const reset = (w: Partial<World> = {}) => { world = { projects: [], statuses: {}, dupUuid: [], writes: [], ...w }; };
const rows = async () => (await pool.query("SELECT taiga_project_id::int AS id, slug, name, lifecycle, uuid_ready AS \"uuidReady\", active_activation_id IS NOT NULL AS policy FROM project_binding ORDER BY taiga_project_id")).rows;
const sync = (apply = true) => mirrorProjects(pool, fake(), BASE, { apply });
const actions = (r: { items: { action: string }[] }) => r.items.map((i) => i.action);

test("an empty Taiga mirrors nothing, and a dry run writes nothing at all", async () => {
  reset();
  assert.deepEqual((await sync(false)).items, []);
  reset({ projects: [{ id: 1, slug: "a", name: "A" }, { id: 2, slug: "b", name: "B" }], statuses: { 1: TASK, 2: ["New", "Closed"] } });
  const dry = await sync(false);
  assert.deepEqual([dry.applied, actions(dry)], [false, ["create_managed", "create_legacy"]]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM taiga_instance")).rows[0].n, 0);
  assert.deepEqual(await rows(), []);
});

test("a full Taiga: eligible projects get the legacy seed as an active policy, the others stay legacy", async () => {
  const done = await sync();
  assert.deepEqual([done.applied, actions(done)], [true, ["create_managed", "create_legacy"]]);
  assert.deepEqual(await rows(), [
    { id: 1, slug: "a", name: "A", lifecycle: "managed", uuidReady: true, policy: true },
    { id: 2, slug: "b", name: "B", lifecycle: "legacy", uuidReady: true, policy: false },
  ]);
  const binding = (await pool.query("SELECT id FROM project_binding WHERE taiga_project_id = 1")).rows[0].id;
  assert.equal((await activePolicy(pool, binding))?.revision, 1);
  assert.deepEqual(world.writes, [], "the mirror never writes to Taiga");
});

test("running it again changes nothing", async () => {
  assert.deepEqual(actions(await sync()), ["none", "none"]);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM policy_version")).rows[0].n, 1);
});

test("a rename keeps the same binding (by project id, never by slug) and leaves the policy alone", async () => {
  world.projects[0] = { id: 1, slug: "renamed", name: "A renamed" };
  assert.deepEqual(actions(await sync()), ["refresh", "none"]);
  assert.deepEqual((await rows())[0], { id: 1, slug: "renamed", name: "A renamed", lifecycle: "managed", uuidReady: true, policy: true });
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM policy_version")).rows[0].n, 1);
});

test("a status rename is drift: governed writes are refused until the vocabulary is back, then it recovers", async () => {
  const runtime = createPolicyRuntime(pool, BASE);
  world.statuses[1] = [...TASK.slice(0, 2), "Validation", ...TASK.slice(3)];
  assert.deepEqual(actions(await sync()), ["mark_drift", "none"]);
  await assert.rejects(runtime.forProject(1), /project 1 is drift/, "a drifting project is refused, never sent to the legacy rules");
  world.statuses[1] = TASK;
  assert.deepEqual(actions(await sync()), ["recover", "none"]);
  assert.equal((await runtime.forProject(1))?.revision, 1);
});

test("an ambiguous status name is drift, and a project that is not UUID-ready is not eligible (drift) until it is again", async () => {
  world.statuses[1] = [...TASK, "in  progress"];
  assert.deepEqual(actions(await sync()), ["mark_drift", "none"]);
  world.statuses[1] = TASK;
  await sync();
  world.dupUuid = [1];
  assert.deepEqual(actions(await sync()), ["mark_drift", "none"]);
  assert.deepEqual([(await rows())[0].lifecycle, (await rows())[0].uuidReady], ["drift", false]);
  world.dupUuid = [];
  assert.deepEqual(actions(await sync()), ["recover", "none"]);
});

test("a project that disappears is inaccessible, not removed, and comes back with its policy", async () => {
  const kept = world.projects.splice(0, 1);
  assert.deepEqual(actions(await sync()), ["mark_inaccessible", "none"]);
  assert.equal((await rows())[0].lifecycle, "inaccessible");
  world.projects.unshift(...kept);
  assert.deepEqual(actions(await sync()), ["recover", "none"]);
  assert.deepEqual([(await rows())[0].lifecycle, (await rows())[0].policy], ["managed", true]);
});

test("a legacy project stays legacy even if it later looks eligible (that is a decision, not a sync)", async () => {
  world.statuses[2] = TASK;
  assert.deepEqual(actions(await sync()), ["none", "refresh"]);
  assert.equal((await rows())[1].lifecycle, "legacy");
});

test("the lifecycle table: every case", () => {
  const e = (lifecycle: string, hasPolicy = true) => ({ id: "x", lifecycle, slug: "s", name: "n", fingerprint: "f", uuidReady: true, hasPolicy });
  const s = (eligible: boolean) => ({ id: 1, slug: "s", name: "n", eligible, fingerprint: "f", uuidReady: true });
  assert.equal(plan(undefined, s(true)).action, "create_managed");
  assert.equal(plan(undefined, s(false)).action, "create_legacy");
  assert.equal(plan(e("managed"), undefined).action, "mark_inaccessible");
  assert.equal(plan(e("managed"), s(false)).action, "mark_drift");
  assert.equal(plan(e("drift"), s(true)).action, "recover");
  assert.equal(plan(e("drift"), s(false)).action, "none");
  assert.equal(plan(e("pending", false), s(true)).action, "create_managed");
  assert.equal(plan(e("inaccessible"), s(false)).action, "mark_drift");
  assert.equal(plan(e("legacy", false), undefined).action, "none");
  // What the policy depends on changed: drift, never absorbed; and it recovers only when Taiga is back to the bound fingerprint.
  assert.equal(plan(e("managed"), { ...s(true), fingerprint: "other" }).action, "mark_drift");
  assert.equal(plan(e("drift"), { ...s(true), fingerprint: "other" }).action, "none");
  assert.equal(plan({ ...e("managed"), fingerprint: null }, s(true)).action, "refresh");
});

test("provisioning: intent -> created -> bound, a retry with the same key answers the same project, an unknown outcome is never re-run", async () => {
  const runtime = createPolicyRuntime(pool, BASE);
  const seen = { id: 9, slug: "n", name: "N", eligible: true, fingerprint: "f", uuidReady: true };
  let created = 0;
  const create = async () => { created += 1; return { id: 9, slug: "n", name: "N", seen }; };
  const a = { principal: "po", requestKey: "key-aaaaaaaa", requestHash: "h1" };
  assert.deepEqual(await runtime.provision(a, create), { id: 9, replay: false });
  assert.deepEqual((await runtime.forProject(9))?.revision, 1, "bound and managed with its first policy");
  assert.deepEqual(await runtime.provision(a, create), { id: 9, replay: true });
  assert.equal(created, 1);
  await assert.rejects(runtime.provision({ ...a, requestHash: "h2" }, create), /request_key_reused|different project request/);
  const boom = { principal: "po", requestKey: "key-bbbbbbbb", requestHash: "h3" };
  // Taiga rejected it (4xx): nothing was created, the failure is confirmed.
  await assert.rejects(runtime.provision(boom, async () => { throw Object.assign(new Error("rejected"), { status: 400 }); }), /rejected/);
  await assert.rejects(runtime.provision(boom, create), /Taiga rejected it/);
  // A timeout or a 5xx may hide a created project: the outcome is unknown and the key is never re-run.
  const lost = { principal: "po", requestKey: "key-cccccccc", requestHash: "h4" };
  await assert.rejects(runtime.provision(lost, async () => { throw new Error("fetch failed"); }), /fetch failed/);
  await assert.rejects(runtime.provision(lost, create), /outcome is unknown/);
  assert.equal(created, 1, "neither request was run again");
  assert.deepEqual((await pool.query("SELECT request_key, phase FROM provisioning_intent ORDER BY request_key")).rows, [{ request_key: "key-aaaaaaaa", phase: "bound" }, { request_key: "key-bbbbbbbb", phase: "failed" }, { request_key: "key-cccccccc", phase: "intent" }]);
});

test("a managed project that was inaccessible comes back only to the fingerprint it was bound to; roles and UUID definitions are part of it", async () => {
  const base = { id: 77, slug: "p", name: "P" };
  reset({ projects: [base], statuses: { 77: TASK } });
  await sync();
  assert.equal((await rows()).find((r: { id: number }) => r.id === 77).lifecycle, "managed");
  reset({ projects: [] });
  assert.deepEqual((await sync()).items.filter((i) => i.taigaProjectId === 77).map((i) => i.action), ["mark_inaccessible"]);
  // Back, but a role was added in the meantime: not the bound fingerprint, so it is drift, never a silent recovery.
  reset({ projects: [base], statuses: { 77: TASK } });
  const original = fake();
  const withRole = { ...original, get: async (path: string, params: { project: number }) => path === "/roles" ? [{ id: 1, name: "Product Owner" }, { id: 2, name: "Extra" }] : (original as never as { get: (p: string, q: { project: number }) => Promise<unknown> }).get(path, params) };
  assert.deepEqual((await mirrorProjects(pool, withRole as never, BASE, { apply: true })).items.filter((i) => i.taigaProjectId === 77).map((i) => i.action), ["mark_drift"]);
  assert.equal((await rows()).find((r: { id: number }) => r.id === 77).lifecycle, "drift");
});

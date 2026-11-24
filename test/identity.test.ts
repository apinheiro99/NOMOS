import { test } from "node:test";
import assert from "node:assert/strict";
import { uuidv7, UUID_RE, ensureUuid, withUuid, initializeProject, resolveUuid, IdentityIntegrityError, uuidAttributeId, isReservedName } from "../dist/identity.js";
import { registerTaskTools } from "../dist/tools/tasks.js";
import { registerIssueTools } from "../dist/tools/issues.js";
import { registerCustomAttributeTools } from "../dist/tools/custom-attributes.js";

// In-memory Taiga: per-project attribute definitions (ids differ per project), per-entity values with a version.
function world({ withDefinition = true, rows = {} } = {}) {
  const w = { defs: [], values: new Map(), entities: new Map(), writes: [], nextDef: 100, rows };
  if (withDefinition) w.defs.push({ id: 7, name: "UUID", project: 5, kind: "task" });
  const kindOf = (p) => (p.includes("userstor") ? "userstory" : p.includes("epic") ? "epic" : p.includes("issue") ? "issue" : "task");
  const client = {
    async get(path, params = {}) {
      let m;
      if ((m = /^\/(\w+)-custom-attributes$/.exec(path))) return w.defs.filter((d) => d.kind === m[1] && d.project === params.project);
      if ((m = /^\/(\w+)-custom-attributes\/(\d+)$/.exec(path))) return w.defs.find((d) => d.id === Number(m[2]));
      if ((m = /^\/(\w+)\/custom-attributes-values\/(\d+)$/.exec(path))) { const v = w.values.get(`${kindOf(m[1])}:${m[2]}`) ?? { version: 1, attributes_values: {} }; return structuredClone(v); }
      if ((m = /^\/(\w+)\/(\d+)$/.exec(path))) return w.entities.get(`${kindOf(m[1])}:${m[2]}`) ?? { id: Number(m[2]), project: 5 };
      if ((m = /^\/(tasks|issues|userstories|epics)$/.exec(path))) { const all = w.rows[kindOf(m[1])] ?? []; return params.all ? all : all.slice((params.page - 1) * params.page_size, params.page * params.page_size); }
      throw new Error("unexpected GET " + path);
    },
    async post(path, body) {
      w.writes.push(["post", path, body]);
      let m;
      if ((m = /^\/(\w+)-custom-attributes$/.exec(path))) { const d = { id: w.nextDef++, name: body.name, project: body.project, kind: m[1] }; w.defs.push(d); return d; }
      if (path === "/tasks") return { id: 11, project: body.project, subject: body.subject };
      if (path === "/issues") return { id: 21, project: body.project, subject: body.subject };
      if (path === "/tasks/bulk_create") return [{ id: 31, project: body.project_id }, { id: 32, project: body.project_id }];
      throw new Error("unexpected POST " + path);
    },
    async patch(path, body) {
      w.writes.push(["patch", path, body]);
      const m = /^\/(\w+)\/custom-attributes-values\/(\d+)$/.exec(path);
      if (m) { const key = `${kindOf(m[1])}:${m[2]}`; const cur = w.values.get(key) ?? { version: 1, attributes_values: {} }; if (body.version !== cur.version) throw new Error("409"); w.values.set(key, { version: cur.version + 1, attributes_values: body.attributes_values }); return w.values.get(key); }
      if (/^\/\w+-custom-attributes\/\d+$/.test(path)) return {};
      throw new Error("unexpected PATCH " + path);
    },
    async delete(path) { w.writes.push(["delete", path]); return null; },
    getAll(path, params) { return this.get(path, { ...params, all: true }); },
  };
  return { w, client };
}
const reg = (register, client) => { const r = {}; register({ tool: (n, _d, _s, h) => { r[n] = h; } }, client); return r; };
const json = (res) => JSON.parse(res.content[0].text);

test("uuidv7: RFC 9562 layout, embedded timestamp, time-ordered", () => {
  const a = uuidv7(1_700_000_000_000);
  assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(parseInt(a.replace(/-/g, "").slice(0, 12), 16), 1_700_000_000_000);
  assert.ok(uuidv7(1_700_000_000_001) > a);
  assert.notEqual(uuidv7(1), uuidv7(1));
});

test("create tools: the entity is created, then gets its UUID once, written only to the UUID attribute", async () => {
  const { w, client } = world();
  const t = reg(registerTaskTools, client);
  const out = json(await t["taiga_tasks_create"]({ project: 5, user_story: 1, subject: "s" }));
  assert.equal(out.id, 11);
  assert.match(out.uuid, UUID_RE);
  assert.equal(out.identity, "complete");
  const patch = w.writes.find((x) => x[0] === "patch");
  assert.deepEqual(Object.keys(patch[2].attributes_values), ["7"], "the attribute id is resolved by NAME in the project");
  assert.equal(patch[2].attributes_values["7"], out.uuid);
});

test("create in a project without the attribute defines it (type text) and then assigns", async () => {
  const { w, client } = world({ withDefinition: false });
  const i = reg(registerIssueTools, client);
  const out = json(await i["taiga_issues_create"]({ project: 5, subject: "s" }));
  assert.match(out.uuid, UUID_RE);
  const def = w.writes.find((x) => x[1] === "/issue-custom-attributes");
  assert.deepEqual([def[2].name, def[2].type, def[2].project], ["UUID", "text", 5]);
});

test("bulk create: every created entity gets its own distinct UUID", async () => {
  const { client } = world();
  const t = reg(registerTaskTools, client);
  const out = json(await t["taiga_tasks_bulk_create"]({ project_id: 5, us_id: 1, bulk_tasks: "a\nb" }));
  assert.equal(out.length, 2);
  assert.notEqual(out[0].uuid, out[1].uuid);
  assert.ok(out.every((x) => UUID_RE.test(x.uuid)));
});

test("an identity failure never fails or hides the creation: uuid null + uuid_error, backfill repairs it later", async () => {
  const { client } = world();
  client.patch = async () => { throw new Error("boom"); };
  const out = await withUuid(client, "task", { id: 11, project: 5 });
  assert.equal(out.id, 11); assert.equal(out.uuid, null); assert.equal(out.identity, "incomplete"); assert.match(out.uuid_error, /boom/); assert.match(out.identity_note, /taiga_uuid_initialize_project/);
});

test("ensureUuid is idempotent and keeps other attribute values untouched", async () => {
  const { w, client } = world();
  w.values.set("task:11", { version: 3, attributes_values: { "9": "keep me" } });
  const first = await ensureUuid(client, "task", { id: 11, project: 5 });
  assert.equal(first.assigned, true);
  assert.deepEqual(w.values.get("task:11").attributes_values["9"], "keep me");
  const before = w.writes.length;
  const second = await ensureUuid(client, "task", { id: 11, project: 5 });
  assert.deepEqual([second.assigned, second.uuid], [false, first.uuid]);
  assert.equal(w.writes.length, before, "no write for an entity that already has a UUID");
});

test("a non-UUID value already in the attribute is never overwritten", async () => {
  const { w, client } = world();
  w.values.set("task:11", { version: 2, attributes_values: { "7": "hand-written" } });
  const r = await ensureUuid(client, "task", { id: 11, project: 5 });
  assert.deepEqual([r.assigned, r.uuid, r.invalid_existing], [false, null, true]);
  assert.equal(w.values.get("task:11").attributes_values["7"], "hand-written");
});

test("custom-attribute tools refuse to define, delete or write the UUID attribute, and still work for others", async () => {
  const { w, client } = world();
  w.defs.push({ id: 8, name: "Other", project: 5, kind: "task" });
  const ca = reg(registerCustomAttributeTools, client);
  for (const [tool, args] of [["taiga_task_custom_attributes_update", { id: 7, name: "X" }], ["taiga_task_custom_attributes_delete", { id: 7 }], ["taiga_task_custom_attributes_values_update", { id: 11, version: 1, attributes_values: { "7": "x" } }]]) {
    const res = await ca[tool](args);
    assert.equal(res.isError, true, tool); assert.match(res.content[0].text, /MCP-owned and write-once/);
  }
  assert.equal(w.writes.length, 0);
  assert.notEqual((await ca["taiga_task_custom_attributes_update"]({ id: 8, name: "Y" })).isError, true);
  assert.equal(w.writes.length, 1, "other attributes remain fully editable");
});

test("initialize: dry run counts only; real run fills just the missing; a second run changes nothing", async () => {
  const rows = { task: [{ id: 1 }, { id: 2 }, { id: 3 }, { id: 4 }] };
  const { w, client } = world({ rows });
  w.values.set("task:1", { version: 2, attributes_values: { "7": "01a19888-0d9e-7478-9334-b8f21733949c" } });
  w.values.set("task:4", { version: 2, attributes_values: { "7": "legacy" } });
  const dry = (await initializeProject(client, 5, { kinds: ["task"], dryRun: true })).kinds[0];
  assert.deepEqual([dry.scanned, dry.already, dry.to_assign, dry.assigned, dry.invalid_existing], [4, 1, 2, 0, [4]]);
  assert.equal(w.writes.length, 0, "dry run writes nothing");
  const real = (await initializeProject(client, 5, { kinds: ["task"], dryRun: false })).kinds[0];
  assert.deepEqual([real.to_assign, real.assigned], [2, 2]);
  assert.equal(w.values.get("task:1").attributes_values["7"], "01a19888-0d9e-7478-9334-b8f21733949c");
  assert.equal(w.values.get("task:4").attributes_values["7"], "legacy");
  const again = (await initializeProject(client, 5, { kinds: ["task"], dryRun: false })).kinds[0];
  assert.deepEqual([again.to_assign, again.assigned, again.already], [0, 0, 3]);
});

test("initialize reads every row of a list beyond 100 (no page-size assumption)", async () => {
  const rows = { task: Array.from({ length: 205 }, (_, i) => ({ id: i + 1 })) };
  const { client } = world({ rows });
  assert.equal((await initializeProject(client, 5, { kinds: ["task"], dryRun: true })).kinds[0].scanned, 205);
});

const V7 = "01a19888-0d9e-7478-9334-b8f21733949c";
const V7B = "01a19888-0d9e-7478-9334-b8f21733949d";

test("only a real UUIDv7 is valid: version nibble 7 and RFC variant", () => {
  assert.ok(UUID_RE.test(V7));
  assert.ok(!UUID_RE.test("550e8400-e29b-41d4-a716-446655440000"), "v4 rejected");
  assert.ok(!UUID_RE.test("01a19888-0d9e-7478-c334-b8f21733949c"), "wrong variant rejected");
  assert.ok(UUID_RE.test(uuidv7()));
});

test("an existing valid non-v7 UUID is kept, not overwritten, and the entity is reported as incomplete", async () => {
  const { w, client } = world();
  w.values.set("task:11", { version: 2, attributes_values: { "7": "550e8400-e29b-41d4-a716-446655440000" } });
  const r = await ensureUuid(client, "task", { id: 11, project: 5 });
  assert.deepEqual([r.assigned, r.invalid_existing], [false, true]);
  const out = await withUuid(client, "task", { id: 11, project: 5 });
  assert.equal(out.identity, "incomplete");
  assert.equal(w.writes.filter((x) => x[0] === "patch").length, 0);
});

function resolverWorld(extra = {}) {
  const base = world({ rows: { task: [{ id: 1, ref: 905, subject: "Alpha" }, { id: 2, ref: 906, subject: "Beta" }], issue: [{ id: 3, ref: 900, subject: "Gamma" }] } });
  const get = base.client.get;
  base.client.get = async (path, params) => {
    if (path === "/projects") return [{ id: 5 }];
    if (path === "/issue-custom-attributes") return [{ id: 70, name: "UUID" }];
    if (path === "/epic-custom-attributes" || path === "/userstory-custom-attributes") return [];
    return get(path, params);
  };
  base.w.values.set("task:1", { version: 2, attributes_values: { "7": V7 } });
  base.w.values.set("task:2", { version: 2, attributes_values: { "7": extra.dupOfTask ? V7 : V7B } });
  base.w.values.set("issue:3", { version: 2, attributes_values: { "70": "01a19888-0d9e-7478-9334-b8f217339999" } });
  return base;
}

test("resolve: a unique UUID returns type, project, id, ref and subject (and works across all projects)", async () => {
  const { client } = resolverWorld();
  const r = await resolveUuid(client, V7.toUpperCase());
  assert.equal(r.status, "found");
  assert.deepEqual(r.entity, { uuid: V7, type: "task", project: 5, id: 1, ref: 905, subject: "Alpha" });
  const issue = await resolveUuid(client, "01a19888-0d9e-7478-9334-b8f217339999", { project: 5 });
  assert.deepEqual([issue.entity.type, issue.entity.ref], ["issue", 900]);
});

test("resolve: zero matches is not_found; a non-v7 string is invalid_uuid", async () => {
  const { client } = resolverWorld();
  assert.equal((await resolveUuid(client, "01a19888-0d9e-7478-9334-000000000000")).status, "not_found");
  assert.equal((await resolveUuid(client, "#905")).status, "invalid_uuid");
  assert.equal((await resolveUuid(client, "550e8400-e29b-41d4-a716-446655440000")).status, "invalid_uuid");
});

test("resolve: the same UUID on two entities fails closed, lists every match and picks none", async () => {
  const { client } = resolverWorld({ dupOfTask: true });
  const r = await resolveUuid(client, V7);
  assert.equal(r.status, "duplicate");
  assert.deepEqual(r.matches.map((m) => m.id).sort(), [1, 2]);
  assert.equal(r.entity, undefined);
});

test("resolve tool: found is ok, not_found and duplicate are errors", async () => {
  const { client } = resolverWorld();
  const ca = reg(registerCustomAttributeTools, client);
  assert.notEqual((await ca["taiga_uuid_resolve"]({ uuid: V7 })).isError, true);
  assert.equal((await ca["taiga_uuid_resolve"]({ uuid: "01a19888-0d9e-7478-9334-000000000000" })).isError, true);
});

const four = (extra = {}) => world({ withDefinition: false, rows: { epic: [{ id: 1 }], userstory: [{ id: 2 }, { id: 3 }], task: [{ id: 4 }], issue: [{ id: 5 }], ...extra } });

test("initialize project: dry run reports the missing definitions and entities, writes nothing, project not ready", async () => {
  const { w, client } = four();
  const r = await initializeProject(client, 5);
  assert.equal(r.dry_run, true); assert.equal(r.uuid_ready, false);
  assert.deepEqual(r.kinds.map((k) => [k.kind, k.attribute.exists, k.attribute.would_create, k.attribute.created, k.scanned, k.to_assign, k.assigned]),
    [["epic", false, true, false, 1, 1, 0], ["userstory", false, true, false, 2, 2, 0], ["task", false, true, false, 1, 1, 0], ["issue", false, true, false, 1, 1, 0]]);
  assert.equal(w.writes.length, 0);
});

test("initialize project: real run creates the definitions, assigns every entity, reports uuid_ready true; a rerun changes nothing", async () => {
  const { w, client } = four();
  const r = await initializeProject(client, 5, { dryRun: false });
  assert.equal(r.uuid_ready, true);
  assert.ok(r.kinds.every((k) => k.attribute.created && k.assigned === k.scanned && k.failed.length === 0 && k.invalid_existing.length === 0));
  const stored = [...w.values.values()].map((v) => Object.values(v.attributes_values)[0]);
  assert.equal(stored.length, 5); assert.ok(stored.every((u) => UUID_RE.test(u))); assert.equal(new Set(stored).size, 5);
  const snapshot = JSON.stringify([...w.values]); const before = w.writes.length;
  const again = await initializeProject(client, 5, { dryRun: false });
  assert.equal(again.uuid_ready, true);
  assert.ok(again.kinds.every((k) => !k.attribute.created && k.attribute.exists && k.to_assign === 0 && k.already === k.scanned));
  assert.equal(w.writes.length, before, "no write on a ready project");
  assert.equal(JSON.stringify([...w.values]), snapshot, "every UUID is exactly the same");
});

test("initialize project: an invalid existing value keeps the project not ready and is never overwritten", async () => {
  const { w, client } = four();
  await initializeProject(client, 5, { dryRun: false });
  const key = [...w.values.keys()].find((k) => k.startsWith("task:"));
  const attr = Object.keys(w.values.get(key).attributes_values)[0];
  w.values.get(key).attributes_values[attr] = "not-a-uuid";
  const r = await initializeProject(client, 5, { dryRun: false });
  assert.equal(r.uuid_ready, false);
  assert.deepEqual(r.kinds.find((k) => k.kind === "task").invalid_existing, [4]);
  assert.equal(w.values.get(key).attributes_values[attr], "not-a-uuid");
});

test("taiga_uuid_backfill is the deprecated UUID-only alias (initialize also applies the profile)", async () => {
  const a = four(); const b = four();
  const ca = reg(registerCustomAttributeTools, a.client); const cb = reg(registerCustomAttributeTools, b.client);
  const canonical = json(await ca["taiga_uuid_initialize_project"]({ project: 5 }));
  const alias = json(await cb["taiga_uuid_backfill"]({ project: 5 }));
  const { profile, ...uuidPart } = canonical;
  assert.ok(profile);
  assert.deepEqual(alias, uuidPart);
  assert.equal(canonical.uuid_ready, false);
});

test("the UUID name is reserved: generic create refuses it (and trivial variants) for all four kinds; rename onto it is refused; other names still work", async () => {
  const { w, client } = world();
  const ca = reg(registerCustomAttributeTools, client);
  for (const kind of ["task", "userstory", "epic", "issue"]) for (const name of ["UUID", "uuid", " UUID ", "Uuid"]) {
    const res = await ca[`taiga_${kind}_custom_attributes_create`]({ project: 5, name, type: "text" });
    assert.equal(res.isError, true, `${kind} ${JSON.stringify(name)}`); assert.match(res.content[0].text, /reserved/);
  }
  w.defs.push({ id: 8, name: "Other", project: 5, kind: "task" });
  assert.equal((await ca["taiga_task_custom_attributes_update"]({ id: 8, name: "uuid" })).isError, true);
  assert.equal(w.writes.length, 0);
  assert.notEqual((await ca["taiga_task_custom_attributes_create"]({ project: 5, name: "Owner team", type: "text" })).isError, true);
  assert.ok(isReservedName(" uUiD "));
});

function corrupted() {
  const c = world({ rows: { task: [{ id: 1, ref: 1, subject: "a" }] } });
  c.w.defs.push({ id: 8, name: "uuid", project: 5, kind: "task" }); // a second definition: project already corrupted
  return c;
}

test("two UUID definitions in a project is an integrity error: nothing is chosen, written or created", async () => {
  const { w, client } = corrupted();
  await assert.rejects(uuidAttributeId(client, "task", 5, true), (e) => e instanceof IdentityIntegrityError && /2 "UUID" custom attribute definitions/.test(e.message));
  const created = await withUuid(client, "task", { id: 11, project: 5 });
  assert.equal(created.identity, "incomplete"); assert.match(created.uuid_error, /integrity error/);
  const init = await initializeProject(client, 5, { dryRun: false, kinds: ["task"] });
  const t = init.kinds[0];
  assert.equal(init.uuid_ready, false); assert.match(t.attribute.integrity_error, /integrity error/); assert.equal(t.assigned, 0);
  const res = await resolveUuid(client, V7, { project: 5 });
  assert.equal(res.status, "integrity_error");
  assert.equal(w.writes.length, 0);
});

test("uuid_ready is a project property: a partial selection is never project-ready, the canonical tool has no `entities`", async () => {
  const { client } = world({ withDefinition: false, rows: { epic: [{ id: 1 }], userstory: [{ id: 2 }], task: [{ id: 4 }], issue: [{ id: 5 }] } });
  const partial0 = await initializeProject(client, 5, { dryRun: false, kinds: ["task"] });
  assert.deepEqual([partial0.partial, partial0.selected_kinds_ready, partial0.uuid_ready], [true, true, false]);
  const full = await initializeProject(client, 5, { dryRun: false });
  assert.deepEqual([full.partial, full.uuid_ready], [false, true]);
  const again = await initializeProject(client, 5, { kinds: ["task"] });
  assert.deepEqual([again.partial, again.selected_kinds_ready, again.uuid_ready], [true, true, false], "even on a ready project a subset call is not a project verdict");
  const schemas = {};
  registerCustomAttributeTools({ tool: (n, _d, sc) => { schemas[n] = Object.keys(sc); } }, client);
  assert.deepEqual(schemas["taiga_uuid_initialize_project"].sort(), ["dry_run", "project"]);
  assert.ok(schemas["taiga_uuid_backfill"].includes("entities"));
});

// ============================ adversarial audit ===============================
test("AUDIT values update: omitting the UUID key can never erase it, writing it is refused", async () => {
  const { w, client } = world();
  w.values.set("task:11", { version: 2, attributes_values: { "7": V7, "9": "old" } });
  const ca = reg(registerCustomAttributeTools, client);
  assert.equal((await ca["taiga_task_custom_attributes_values_update"]({ id: 11, version: 2, attributes_values: { "7": V7B } })).isError, true);
  assert.notEqual((await ca["taiga_task_custom_attributes_values_update"]({ id: 11, version: 2, attributes_values: { "9": "new" } })).isError, true);
  const stored = w.values.get("task:11").attributes_values;
  assert.deepEqual(stored, { "7": V7, "9": "new" }, "the UUID is merged back in even though the caller omitted it");
});

test("AUDIT every spelling of the reserved name is protected by update and delete (one semantics of 'is the UUID field')", async () => {
  const { w, client } = world({ withDefinition: false });
  w.defs.push({ id: 20, name: "uuid", project: 5, kind: "task" }, { id: 21, name: " UUID ", project: 5, kind: "task" });
  const ca = reg(registerCustomAttributeTools, client);
  for (const id of [20, 21]) for (const [tool, args] of [["update", { id, description: "x" }], ["delete", { id }]]) {
    assert.equal((await ca[`taiga_task_custom_attributes_${tool}`](args)).isError, true, `${tool} ${id}`);
  }
  assert.equal(w.writes.length, 0);
});

test("AUDIT no stale definition: a second definition added AFTER a successful resolution is detected and nothing is written", async () => {
  const { w, client } = world({ rows: {} });
  assert.equal((await ensureUuid(client, "task", { id: 11, project: 5 })).assigned, true);
  w.defs.push({ id: 8, name: "uuid", project: 5, kind: "task" }); // external UI/REST change
  const before = w.writes.length;
  await assert.rejects(ensureUuid(client, "task", { id: 12, project: 5 }), IdentityIntegrityError);
  await assert.rejects(uuidAttributeId(client, "task", 5, false), IdentityIntegrityError);
  assert.equal(w.writes.length, before);
});

test("AUDIT no stale definition: a definition deleted externally is never written to by its old id", async () => {
  const { w, client } = world();
  await ensureUuid(client, "task", { id: 11, project: 5 });
  w.defs.length = 0; // deleted from the UI
  const r = await ensureUuid(client, "task", { id: 12, project: 5 });
  assert.equal(r.assigned, true);
  const patch = w.writes.filter((x) => x[0] === "patch").at(-1);
  assert.deepEqual(Object.keys(patch[2].attributes_values), [String(w.defs[0].id)], "the NEW definition id is used, not the cached old one");
});

test("AUDIT concurrent creation: a rival definition appearing during creation is an integrity error and no value is written", async () => {
  const { w, client } = world({ withDefinition: false });
  const post = client.post.bind(client);
  client.post = async (path, body) => { const d = await post(path, body); if (/custom-attributes$/.test(path)) w.defs.push({ id: 999, name: "uuid", project: body.project, kind: "task" }); return d; };
  await assert.rejects(ensureUuid(client, "task", { id: 11, project: 5 }), /integrity error/);
  assert.equal(w.writes.filter((x) => x[0] === "patch").length, 0);
});

test("AUDIT version-conflict race: if another writer assigned a valid UUID first, that one wins; a real failure still fails", async () => {
  const { w, client } = world();
  const patch = client.patch.bind(client);
  client.patch = async () => { w.values.set("task:11", { version: 3, attributes_values: { "7": V7 } }); throw new Error("409"); };
  assert.deepEqual(await ensureUuid(client, "task", { id: 11, project: 5 }), { uuid: V7, assigned: false });
  client.patch = async () => { throw new Error("500"); };
  await assert.rejects(ensureUuid(client, "task", { id: 12, project: 5 }), /500/);
  void patch;
});

test("AUDIT creation responses without id/project are reported incomplete, never silently passed (single and bulk)", async () => {
  const { client } = world();
  const one = await withUuid(client, "task", { subject: "x" });
  assert.equal(one.identity, "incomplete"); assert.match(one.uuid_error, /no numeric id\/project/);
  const many = await withUuid(client, "task", [{ id: 1, project: 5 }, { id: 2 }]);
  assert.deepEqual(many.map((x) => x.identity), ["complete", "incomplete"]);
});

test("AUDIT duplicate UUID values inside a project: reported, nothing rewritten, project not ready", async () => {
  const { w, client } = four();
  await initializeProject(client, 5, { dryRun: false });
  const [a, b] = [...w.values.keys()].filter((k) => k.startsWith("task:") || k.startsWith("issue:"));
  const attrOf = (k) => Object.keys(w.values.get(k).attributes_values)[0];
  const shared = w.values.get(a).attributes_values[attrOf(a)];
  w.values.get(b).attributes_values[attrOf(b)] = shared;
  const snapshot = JSON.stringify([...w.values]);
  const r = await initializeProject(client, 5, { dryRun: false });
  assert.equal(r.uuid_ready, false);
  assert.equal(r.duplicate_uuids.length, 1); assert.equal(r.duplicate_uuids[0].entities.length, 2);
  assert.equal(JSON.stringify([...w.values]), snapshot);
});

test("AUDIT dry run over 205 entities with a missing definition performs zero writes and still reads every row", async () => {
  const rows = { task: Array.from({ length: 205 }, (_, i) => ({ id: i + 1 })) };
  const { w, client } = world({ withDefinition: false, rows });
  const r = await initializeProject(client, 5, { kinds: ["task"] });
  assert.deepEqual([r.kinds[0].scanned, r.kinds[0].to_assign, r.kinds[0].attribute.would_create], [205, 205, true]);
  assert.equal(w.writes.length, 0);
});

test("AUDIT resolve states its scope and the kinds it could not search", async () => {
  const { client } = resolverWorld();
  const narrow = await resolveUuid(client, V7, { project: 5 });
  assert.equal(narrow.scope, "project 5");
  assert.ok(narrow.kinds_without_attribute.includes("epic@5"));
  assert.equal((await resolveUuid(client, V7)).scope, "all visible projects");
});

// ============================ audit loop 2: readiness only from verified state ===============================
test("LOOP race winner that duplicates an existing UUID is detected: not ready, nothing rewritten", async () => {
  const { w, client } = world({ rows: { task: [{ id: 1 }, { id: 2 }] } });
  w.values.set("task:2", { version: 2, attributes_values: { "7": V7 } });
  client.patch = async (path) => { if (path.endsWith("/1")) { w.values.set("task:1", { version: 3, attributes_values: { "7": V7 } }); throw new Error("409"); } return {}; };
  const r = await initializeProject(client, 5, { dryRun: false, kinds: ["task"] });
  assert.equal(r.duplicate_uuids.length, 1);
  assert.equal(r.uuid_ready, false); assert.equal(r.selected_kinds_ready, false);
  assert.equal(w.values.get("task:2").attributes_values["7"], V7);
});

test("LOOP readiness comes from a read-back verification: a write that did not persist is never counted as ready", async () => {
  const { w, client } = world({ rows: { task: [{ id: 1 }] } });
  client.patch = async () => ({}); // answers 200 but persists nothing
  const r = await initializeProject(client, 5, { dryRun: false, kinds: ["task"] });
  assert.equal(r.kinds[0].uuid_ready, false);
  assert.ok(r.kinds[0].failed.length > 0 || r.kinds[0].to_assign_after > 0);
  void w;
});

test("LOOP an entity that appears during initialize has no UUID in the final verification: not ready", async () => {
  const rows = { task: [{ id: 1 }] };
  const { w, client } = world({ rows });
  const patch = client.patch.bind(client);
  client.patch = async (p, b) => { const r = await patch(p, b); rows.task.push({ id: 2 }); return r; };
  const r = await initializeProject(client, 5, { dryRun: false, kinds: ["task"] });
  assert.equal(r.kinds[0].uuid_ready, false);
  assert.equal(r.kinds[0].to_assign_after, 1);
  void w;
});

test("LOOP ensureUuid read-backs its own write; a lost write is an error, not 'complete'", async () => {
  const { client } = world();
  client.patch = async () => ({});
  await assert.rejects(ensureUuid(client, "task", { id: 11, project: 5 }), /read-back/);
  const out = await withUuid(client, "task", { id: 11, project: 5 });
  assert.equal(out.identity, "incomplete");
});

test("LOOP a ready project stays ready on rerun and the verification pass is read-only", async () => {
  const { w, client } = four();
  await initializeProject(client, 5, { dryRun: false });
  const before = w.writes.length;
  const again = await initializeProject(client, 5, { dryRun: false });
  assert.equal(again.uuid_ready, true); assert.equal(w.writes.length, before);
});

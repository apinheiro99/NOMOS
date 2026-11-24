import { test } from "node:test";
import assert from "node:assert/strict";
import { applyProfile, PROJECT_PROFILE } from "../dist/project-profile.js";

// Fake Taiga: per-resource rows (Taiga defaults), optional cards. Records every write.
function fake({ cards = false } = {}) {
  const rows = {
    "task-statuses": [["New", 1, false], ["In progress", 2, false], ["Ready for test", 3, false], ["Closed", 4, true], ["Needs Info", 5, false]],
    severities: [["Wishlist", 1, false], ["Minor", 2, false], ["Normal", 3, false], ["Important", 4, false], ["Critical", 5, false]],
  };
  const writes = [];
  let id = 100;
  const client = {
    get: async (path, params) => {
      if (["/userstories", "/tasks", "/issues", "/epics"].includes(path)) return cards && path === (params?.severity ? "/issues" : "/tasks") ? [{ id: 1 }] : [];
      const key = path.slice(1);
      return (rows[key] ?? []).map(([name, order, is_closed], i) => ({ id: i + 1, name, order, is_closed, color: "#000000" }));
    },
    post: async (p, b) => { writes.push(["post", p, b]); return { id: ++id }; },
    patch: async (p, b) => { writes.push(["patch", p, b]); return {}; },
    delete: async (p) => { writes.push(["delete", p]); return {}; },
  };
  return { client, writes };
}

test("dry run reports and writes nothing", async () => {
  const { client, writes } = fake();
  const r = await applyProfile(client, 9);
  assert.equal(writes.length, 0);
  assert.equal(r.dry_run, true);
  assert.ok(r.resources.find((x) => x.resource === "task-statuses").ops.length > 0);
});

test("empty project: defaults renamed in place, missing created, extras deleted", async () => {
  const { client, writes } = fake();
  await applyProfile(client, 9, { dryRun: false });
  const renamed = writes.filter(([m, p, b]) => m === "patch" && p.startsWith("/task-statuses/") && b.name).map(([, , b]) => b.name);
  assert.deepEqual(renamed.filter((n) => n !== "In Progress"), ["To Do", "Request", "GPT Validation", "Human Decision"]); // "In progress" -> "In Progress" is a case fix
  const created = writes.filter(([m, p]) => m === "post" && p === "/task-statuses").map(([, , b]) => b.name);
  assert.deepEqual(created, ["Done", "Cancelled"]);
  assert.ok(writes.some(([m, p]) => m === "delete" && p === "/severities/1"));
});

test("project with cards on a non-profile value: fails with the blocker (value + card count + fix) and writes nothing", async () => {
  const { client, writes } = fake({ cards: true });
  const r = await applyProfile(client, 9, { dryRun: false });
  assert.equal(r.ok, false);
  assert.equal(writes.length, 0);
  assert.equal(r.empty_project, false);
  const b = r.blockers.find((x) => x.resource === "severities");
  assert.equal(b.value, "Wishlist");
  assert.deepEqual(b.cards, { issues: 1 });
  assert.match(b.how_to_fix, /Move every card/);
});

test("profile carries the workflow vocabulary", () => {
  assert.deepEqual(PROJECT_PROFILE["task-statuses"].map((s) => s.name), ["To Do", "In Progress", "Request", "GPT Validation", "Human Decision", "Done", "Cancelled"]);
});

test("remap: cards move to the profile value first, then the old value is deleted", async () => {
  const log = [];
  const store = { "epic-statuses": [{ id: 1, name: "New", order: 1, is_closed: false, color: "#000000" }] };
  let next = 50;
  const client = {
    get: async (path, params) => {
      if (path.startsWith("/projects/")) return { id: 9, version: 1 };
      if (path === "/epics") return params?.status === 1 || !params?.status ? [{ id: 7, version: 3 }] : [];
      if (["/userstories", "/tasks", "/issues"].includes(path)) return [];
      return (store[path.slice(1)] ?? []).map((e) => ({ ...e }));
    },
    post: async (p, b) => { log.push(["post", p, b.name]); (store[p.slice(1)] ??= []).push({ id: next++, name: b.name, order: b.order, is_closed: b.is_closed, color: b.color }); return {}; },
    patch: async (p, b) => { log.push(["patch", p, b.status ?? b.name]); return {}; },
    delete: async (p) => { log.push(["delete", p]); return {}; },
  };
  const blocked = await applyProfile(client, 9, { dryRun: false });
  assert.equal(blocked.ok, false);
  assert.equal(log.length, 0);
  const r = await applyProfile(client, 9, { dryRun: false, remap: { "epic-statuses": { New: "Proposed" } } });
  assert.equal(r.ok, true, JSON.stringify(r));
  const iMove = log.findIndex(([m, p]) => m === "patch" && p === "/epics/7");
  const iDel = log.findIndex(([m, p]) => m === "delete" && p === "/epic-statuses/1");
  assert.ok(iMove >= 0 && iDel > iMove, JSON.stringify(log));
});

// A project whose statuses are already canonical, so only the project-level default statuses can differ.
function canonical(defaults = {}) {
  const store = {};
  const ids = {};
  let id = 1;
  for (const [resource, items] of Object.entries(PROJECT_PROFILE)) {
    store[resource] = items.map((d, i) => {
      ids[`${resource}:${d.name}`] = id;
      return { id: id++, name: d.name, color: d.color, order: i + (resource === "priorities" ? 0 : 1), is_closed: !!d.is_closed, ...(d.is_archived !== undefined ? { is_archived: d.is_archived } : {}) };
    });
  }
  const project = { id: 9, version: 4, default_us_status: ids["userstory-statuses:Ready"], default_task_status: ids["task-statuses:To Do"], default_issue_status: ids["issue-statuses:New"], default_epic_status: ids["epic-statuses:Proposed"], ...defaults };
  const writes = [];
  const client = {
    get: async (path) => {
      if (path === "/projects/9") return { ...project };
      if (["/userstories", "/tasks", "/issues", "/epics"].includes(path)) return [];
      return (store[path.slice(1)] ?? []).map((e) => ({ ...e }));
    },
    post: async (p, b) => { writes.push(["post", p, b]); return {}; },
    patch: async (p, b) => { writes.push(["patch", p, b]); if (p === "/projects/9") Object.assign(project, b); return {}; },
    delete: async (p) => { writes.push(["delete", p]); return {}; },
  };
  return { client, writes, ids, project };
}

test("project defaults: a wrong default_us_status is reported by the dry run with zero writes", async () => {
  const { client, writes, ids } = canonical();
  const { client: bad, writes: badWrites } = canonical({ default_us_status: ids["userstory-statuses:GPT Validation"] });
  const clean = await applyProfile(client, 9);
  assert.deepEqual(clean.defaults, []);
  const r = await applyProfile(bad, 9);
  assert.equal(r.ok, true);
  assert.deepEqual(r.defaults.map((d) => [d.field, d.want, d.current]), [["default_us_status", "Ready", "GPT Validation"]]);
  assert.equal(badWrites.length, 0);
  assert.equal(writes.length, 0);
});

test("project defaults: apply repairs all four canonical defaults by name, moves no card, and a rerun is idempotent", async () => {
  const { client, writes, ids, project } = canonical({ default_us_status: 0, default_task_status: null, default_issue_status: 999, default_epic_status: undefined });
  const r = await applyProfile(client, 9, { dryRun: false });
  assert.equal(r.ok, true, JSON.stringify(r));
  const patches = writes.filter(([m, p]) => m === "patch" && p === "/projects/9");
  assert.equal(patches.length, 1);
  assert.deepEqual(patches[0][2], { version: 4, default_us_status: ids["userstory-statuses:Ready"], default_task_status: ids["task-statuses:To Do"], default_issue_status: ids["issue-statuses:New"], default_epic_status: ids["epic-statuses:Proposed"] });
  assert.equal(project.default_us_status, ids["userstory-statuses:Ready"]);
  assert.ok(!writes.some(([, p]) => /^\/(userstories|tasks|issues|epics)/.test(p)), "no card is written");
  writes.length = 0;
  const again = await applyProfile(client, 9, { dryRun: false });
  assert.equal(again.ok, true);
  assert.deepEqual(again.defaults, []);
  assert.equal(writes.length, 0);
});

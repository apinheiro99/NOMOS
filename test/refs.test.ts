import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeText, RefError, projectResolver, projectTypeResolver, renderGovernedArtifact } from "../dist/workflow/refs.js";

const U = (n) => `0190aaaa-0000-7000-8000-${String(n).padStart(12, "0")}`;
const UPPER = U(874).toUpperCase();
// Resolver stub: every ref exists with UUID U(ref), except 404 (missing) and 500 (no UUID).
const uuidOf = async (kind, ref) => {
  if (ref === 404) throw new RefError([`${kind} #404 does not exist in project 49`]);
  if (ref === 500) throw new RefError([`${kind} #500 has no valid UUIDv7 yet`]);
  return U(ref);
};
const fails = (text, re) => assert.rejects(canonicalizeText(text, uuidOf), (e) => e instanceof RefError && re.test(e.problems.join("\n")));

test("simple Task / Issue / Story / User Story / Epic references become canonical", async () => {
  assert.equal(await canonicalizeText("see Task #874", uuidOf), `see Task ${U(874)} (#874)`);
  assert.equal(await canonicalizeText("Issue #873.", uuidOf), `Issue ${U(873)} (#873).`);
  assert.equal(await canonicalizeText("Story #876,", uuidOf), `Story ${U(876)} (#876),`);
  assert.equal(await canonicalizeText("User Story #876", uuidOf), `Story ${U(876)} (#876)`);
  assert.equal(await canonicalizeText("Epic #123", uuidOf), `Epic ${U(123)} (#123)`);
});

test("several references in one artifact, repeated refs, and surrounding text untouched", async () => {
  const out = await canonicalizeText("Fixes Issue #873 via Task #874 (child of Story #876); retry Task #874 later. Epic #123: 5 items, 100% #done", uuidOf);
  assert.equal(out, `Fixes Issue ${U(873)} (#873) via Task ${U(874)} (#874) (child of Story ${U(876)} (#876)); retry Task ${U(874)} (#874) later. Epic ${U(123)} (#123): 5 items, 100% #done`);
});

test("already canonical and consistent: unchanged, exactly once", async () => {
  const t = `Task ${U(874)} (#874) and Issue ${U(873)} (#873)`;
  assert.equal(await canonicalizeText(t, uuidOf), t);
});

test("idempotent: canonicalizing twice equals once", async () => {
  const once = await canonicalizeText("Task #874, Issue #873, Epic #123 and Story #876", uuidOf);
  assert.equal(await canonicalizeText(once, uuidOf), once);
});

test("`Task <uuid> (Task #874)` is one construct: normalized, never double-expanded", async () => {
  const out = await canonicalizeText(`Task ${U(874)} (Task #874)`, uuidOf);
  assert.equal(out, `Task ${U(874)} (#874)`);
  assert.equal((out.match(/874/g) ?? []).length, 2); // one in the uuid, one in (#874)
  assert.equal(await canonicalizeText(out, uuidOf), out);
});

test("uppercase UUID that matches is kept as written", async () => {
  const t = `Task ${UPPER} (#874)`;
  assert.equal(await canonicalizeText(t, uuidOf), t);
});

test("canonical construct whose UUID disagrees with #ref fails closed", async () => {
  await fails(`Task ${U(111)} (#874)`, /has UUID .* not /);
});

test("invalid UUID fails closed (not v7, wrong shape)", async () => {
  await fails("Task 0190aaaa-0000-4000-8000-000000000874 (#874)", /not a valid UUIDv7/);
  await fails("Task 0190aaaa-0000-7000-8000-00000000087 (#874)", /not a valid UUIDv7/);
});

test("type incompatible with the entity fails closed", async () => {
  const typed = async (kind, ref) => { if (kind !== "task") throw new RefError([`${kind} #874 does not exist in project 49`]); return U(ref); };
  await assert.rejects(canonicalizeText("Story #874", typed), /does not exist/);
  await assert.rejects(canonicalizeText(`Issue ${U(874)} (#874)`, typed), /does not exist/);
  await fails(`Task ${U(874)} (Issue #874)`, /disagree/);
});

test("nonexistent entity and entity without UUID fail closed, listing every problem", async () => {
  await fails("Task #404", /does not exist/);
  await fails("Task #500", /no valid UUIDv7/);
  await assert.rejects(canonicalizeText("Task #404 and Issue #500", uuidOf), (e) => e.problems.length === 2);
});

test("untyped #123 and ordinary text with numbers or # are never touched", async () => {
  for (const t of ["#123", "see #123 and #874", "Task number 874", "Task #", "Task#874", "Task #874abc", "issue 873", "C# 7, #hashtag, 3 tasks, v1.2.3, 2026-11-01", "mytask #874", "Subtask #874", "R-905-1 Blueprint: c12"]) {
    assert.equal(await canonicalizeText(t, uuidOf), t, t);
  }
});

// ---- project-bound resolver against a fake Taiga ----
function fake({ ents = { "tasks:874": 1874 }, defs = [{ id: 7, name: "UUID" }], values = {} } = {}) {
  const calls = [];
  return {
    calls,
    async get(path, params = {}) {
      calls.push([path, params]);
      let m;
      if ((m = /^\/(\w+)\/by_ref$/.exec(path))) { const id = ents[`${m[1]}:${params.ref}`]; if (id === undefined) throw new Error(`Taiga API error 404 GET ${path}`); return { id, ref: params.ref, project: params.project }; }
      if (/-custom-attributes$/.test(path)) return defs;
      if ((m = /^\/(\w+)\/custom-attributes-values\/(\d+)$/.exec(path))) return { version: 1, attributes_values: values[m[2]] ?? {} };
      throw new Error("unexpected GET " + path);
    },
  };
}

test("projectResolver reads the UUID of the entity inside the given project only", async () => {
  const c = fake({ values: { 1874: { 7: U(874) } } });
  assert.equal(await projectResolver(c, 49)("task", 874), U(874));
  assert.ok(c.calls.every(([, p]) => p.project === undefined || p.project === 49));
  assert.ok(c.calls.some(([p, q]) => p === "/tasks/by_ref" && q.project === 49 && q.ref === 874));
});

test("projectResolver fails closed: missing entity, missing definition, empty/invalid value, duplicate definitions", async () => {
  await assert.rejects(projectResolver(fake(), 49)("task", 1), /does not exist/);
  await assert.rejects(projectResolver(fake({ defs: [], values: {} }), 49)("task", 874), /no "UUID" attribute/);
  await assert.rejects(projectResolver(fake(), 49)("task", 874), /no valid UUIDv7/);
  await assert.rejects(projectResolver(fake({ values: { 1874: { 7: "not-a-uuid" } } }), 49)("task", 874), /no valid UUIDv7/);
  await assert.rejects(projectResolver(fake({ defs: [{ id: 7, name: "UUID" }, { id: 8, name: " uuid " }] }), 49)("task", 874), /integrity error/);
});

test("renderGovernedArtifact is the render path: refs canonicalized, no lookup when there are none, unknown project with refs fails closed", async () => {
  const tpl = { name: "workflow-request", display: "Workflow Request", version: "1.0.0", type: "workflow_request", fields: [{ key: "question", label: "Question", kind: "text", header: false, applies: ["task"] }], file: "x.md" };
  const base = { template: tpl, entity: "task", author: "claude", transition: null };
  const c = fake({ values: { 1874: { 7: U(874) } } });
  const ok = await renderGovernedArtifact(c, 49, { ...base, artifact: { question: "Is Task #874 done?" } });
  assert.equal(ok.ok, true);
  assert.ok(ok.text.includes(`Is Task ${U(874)} (#874) done?`));
  const none = fake();
  const plain = await renderGovernedArtifact(none, 49, { ...base, artifact: { question: "plain #5 text" } });
  assert.equal(plain.ok, true);
  assert.ok(plain.text.includes("plain #5 text"), "a number that is no entity stays plain text");
  assert.ok(none.calls.every(([p]) => p.endsWith("/by_ref")), "only existence lookups, nothing else");
  const clean = fake();
  assert.equal((await renderGovernedArtifact(clean, 49, { ...base, artifact: { question: "no numbers here" } })).ok, true);
  assert.equal(clean.calls.length, 0);
  const noProject = await renderGovernedArtifact(none, undefined, { ...base, artifact: { question: "Task #874" } });
  assert.equal(noProject.ok, false);
  const missing = await renderGovernedArtifact(fake(), 49, { ...base, artifact: { question: "Task #999" } });
  assert.equal(missing.ok, false);
});

test("case-insensitive and natural variants normalize to the canonical singular word", async () => {
  const c = (t) => canonicalizeText(t, uuidOf);
  for (const w of ["Task", "task", "TASK", "Tasks"]) assert.equal(await c(`${w} #874`), `Task ${U(874)} (#874)`, w);
  for (const w of ["Issue", "issue", "Issues"]) assert.equal(await c(`${w} #873`), `Issue ${U(873)} (#873)`, w);
  for (const w of ["Story", "story", "Stories", "User Story", "user story", "User Stories", "USER STORY"]) assert.equal(await c(`${w} #876`), `Story ${U(876)} (#876)`, w);
  for (const w of ["Epic", "epic", "Epics", "EPIC"]) assert.equal(await c(`${w} #123`), `Epic ${U(123)} (#123)`, w);
  assert.equal(await c(`task ${U(874)} (task #874)`), `Task ${U(874)} (#874)`);
  const once = await c("tasks #874 and user story #876");
  assert.equal(await c(once), once);
});

test("inline code and fenced code are never interpreted", async () => {
  const keep = [
    "use `Task #874` literally", "``Task #874``", "a `x` b `Issue #1` c",
    "```\nTask #874\nIssue #873\n```", "~~~\nTask #874\n~~~", "```ts\nconst a = 'Epic #5';\n```\n", "```\nunclosed Task #874",
    `\`Task ${U(111)} (#874)\``,   // even a wrong canonical form inside code is not validated
  ];
  for (const t of keep) assert.equal(await canonicalizeText(t, uuidOf), t, t);
  assert.equal(await canonicalizeText("```\nTask #874\n```\nbut Task #874 and `Task #1` and Issue #873", uuidOf),
    `\`\`\`\nTask #874\n\`\`\`\nbut Task ${U(874)} (#874) and \`Task #1\` and Issue ${U(873)} (#873)`);
});

test("per-call dedup: each distinct reference is resolved once and reused", async () => {
  const calls = [];
  const counting = async (kind, ref) => { calls.push(`${kind}:${ref}`); return U(ref); };
  const out = await canonicalizeText("Task #874, task #874, Tasks #874 and Task " + U(874) + " (#874); Issue #873; Story #876; Issue #873", counting);
  assert.deepEqual(calls, ["task:874", "issue:873", "userstory:876"]);
  assert.equal((out.match(new RegExp(`Task ${U(874)} \\(#874\\)`, "g")) ?? []).length, 4);
  // nothing persists between calls
  await canonicalizeText("Task #874", counting);
  assert.equal(calls.filter((c) => c === "task:874").length, 2);
});

test("a failing reference is also resolved once, and every problem is still listed", async () => {
  let n = 0;
  const bad = async () => { n++; throw new RefError(["Task #404 does not exist in project 49"]); };
  await assert.rejects(canonicalizeText("Task #404 / task #404", bad), (e) => e.problems.length === 1);
  assert.equal(n, 1);
});

test("Markdown indented code (4 spaces or tab) is never interpreted or validated", async () => {
  const keep = ["    Task #874", "\tIssue #873", "text\n\n    Task #874\n    Epic #5", `    Task ${U(111)} (#874)`, `ok\n\tTask ${U(111)} (#874)\nend`];
  for (const t of keep) assert.equal(await canonicalizeText(t, uuidOf), t, JSON.stringify(t));
  assert.equal(await canonicalizeText("Task #874\n    Task #874\n  Task #874", uuidOf), `Task ${U(874)} (#874)\n    Task #874\n  Task ${U(874)} (#874)`);
});

// ---- untyped #N: typed by lookup when it is a real entity, plain text otherwise ----
const owner = { 876: "userstory", 874: "task", 873: "issue", 123: "epic", 500: "task" };
const typeOf = async (ref) => owner[ref] ?? null;
const cu = (t) => canonicalizeText(t, uuidOf, typeOf);

test("untyped #N that is an entity is typed and canonicalized (the GPT commit-message style)", async () => {
  assert.equal(await cu("headers for the two #876 SQL modules"), `headers for the two Story ${U(876)} (#876) SQL modules`);
  assert.equal(await cu("fix #874, #873 and #123."), `fix Task ${U(874)} (#874), Issue ${U(873)} (#873) and Epic ${U(123)} (#123).`);
  const once = await cu("see #876 and Task #874");
  assert.equal(await cu(once), once);
});

test("untyped #N that is NOT an entity, or not a plain number, is left alone", async () => {
  for (const t of ["PR #12", "#9999", "color #123456", "page#876", "a/b#876", "x&#876;", "C# 7 #hashtag", "#876abc", "# 876", "(see #)"]) {
    assert.equal(await cu(t), t, t);
  }
});

test("untyped #N never touches code, canonical constructs or typed refs, and is resolved once per call", async () => {
  assert.equal(await cu("`#876`\n    #874\n```\n#873\n```"), "`#876`\n    #874\n```\n#873\n```");
  const t = `Task ${U(874)} (#874) and Task ${U(874)} (Task #874)`;
  assert.equal(await cu(t), `Task ${U(874)} (#874) and Task ${U(874)} (#874)`);
  const asked = [];
  const counting = async (ref) => { asked.push(ref); return owner[ref] ?? null; };
  await canonicalizeText("#876 #876 #876 and #9999 #9999", uuidOf, counting);
  assert.deepEqual(asked, [876, 9999]);
});

test("untyped #N whose entity has no UUID fails closed; without a type resolver it is never interpreted", async () => {
  await assert.rejects(cu("see #500"), (e) => e instanceof RefError && /no valid UUIDv7/.test(e.problems[0]));
  assert.equal(await canonicalizeText("see #876", uuidOf), "see #876");
});

test("projectTypeResolver: one kind owns the number; only 404 means 'not an entity'; several owners or other errors fail closed", async () => {
  const c = fake({ ents: { "userstories:876": 1876 } });
  assert.equal(await projectTypeResolver(c, 49)(876), "userstory");
  assert.equal(await projectTypeResolver(fake(), 49)(876), null);
  await assert.rejects(projectTypeResolver(fake({ ents: { "tasks:5": 1, "issues:5": 2 } }), 49)(5), /more than one entity kind/);
  const broken = { async get() { throw new Error("Taiga API error 500 GET /tasks/by_ref"); } };
  await assert.rejects(projectTypeResolver(broken, 49)(5), /500/);
});

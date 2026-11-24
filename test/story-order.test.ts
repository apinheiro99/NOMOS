import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { TaigaClient } from "../dist/client.js";
import { moveClosedStoryToTail } from "../dist/workflow/story-order.js";
import { REVIEW_SUBJECT, keepCanonicalOrder } from "../dist/workflow/engineering-review.js";

// Canonical Sprint order: unfinished Stories -> FINAL review gate -> Done history. A completed Story sinks to the end of the history.
// In-memory Taiga with real versions and ordering. Mock data only.
const realFetch = globalThis.fetch;
const env = { TAIGA_URL: "http://taiga.invalid", TAIGA_USERNAME: "u", TAIGA_PASSWORD: "p" };
const saved: Record<string, string | undefined> = {};
type Row = { id: number; subject: string; sprint_order: number; version: number; milestone: number | null; status: number };
const ACTIVE = 11, DONE = 13, CANCELLED = 15;
let stories: Row[], patches: { id: number; body: Record<string, unknown> }[], failPatch: boolean;

beforeEach(() => {
  for (const k of Object.keys(env)) { saved[k] = process.env[k]; process.env[k] = (env as Record<string, string>)[k]; }
  patches = []; failPatch = false;
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status });
  globalThis.fetch = (async (url: string, init: { method?: string; body?: string } = {}) => {
    const u = new URL(String(url));
    const path = u.pathname.replace(/^.*\/api\/v1/, "");
    const method = init.method ?? "GET";
    if (path === "/auth") return json({ auth_token: "t", refresh: "r" });
    let m: RegExpExecArray | null;
    if (path === "/userstory-statuses") return json([{ id: ACTIVE, name: "In Progress" }, { id: DONE, name: "Done" }, { id: CANCELLED, name: "Cancelled" }]);
    if (/^\/milestones\/\d+$/.test(path)) return json({ id: 300, project: 49 });
    if (path === "/userstories") return json(stories.filter((s) => s.milestone === Number(u.searchParams.get("milestone"))).sort((a, b) => a.sprint_order - b.sprint_order));
    if ((m = /^\/userstories\/(\d+)$/.exec(path))) {
      const row = stories.find((s) => s.id === Number(m![1]))!;
      if (method === "PATCH") {
        if (failPatch) return json({ error: "boom" }, 500);
        const body = JSON.parse(init.body!);
        assert.equal(body.version, row.version, "PATCH carries the fresh version");
        patches.push({ id: row.id, body });
        Object.assign(row, { sprint_order: body.sprint_order, version: row.version + 1 });
      }
      return json(row);
    }
    return json({}, 404);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = realFetch;
  for (const k of Object.keys(env)) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
});

const row = (id: number, subject: string, sprint_order: number, status = ACTIVE, milestone: number | null = 300): Row => ({ id, subject, sprint_order, version: 1, milestone, status });
const order = () => stories.filter((s) => s.milestone === 300).sort((a, b) => a.sprint_order - b.sprint_order).map((s) => s.subject);
const close = (subject: string, status = DONE) => { stories.find((s) => s.subject === subject)!.status = status; return moveClosedStoryToTail(new TaigaClient(), stories.find((s) => s.subject === subject)!.id); };
const F = REVIEW_SUBJECT;

test("[active A, FINAL, done X, done Y]: closing A sinks it to the end of the history", async () => {
  stories = [row(1, "A", 1), row(2, F, 2), row(3, "X", 3, DONE), row(4, "Y", 4, DONE)];
  assert.deepEqual(await close("A"), { moved: true });
  assert.deepEqual(order(), [F, "X", "Y", "A"]);
});

test("[active A, active B, FINAL, done X]: closing A then B keeps completion order and FINAL above the history", async () => {
  stories = [row(1, "A", 1), row(2, "B", 2), row(3, F, 3), row(4, "X", 4, DONE)];
  await close("A");
  assert.deepEqual(order(), ["B", F, "X", "A"]);
  await close("B");
  assert.deepEqual(order(), [F, "X", "A", "B"]);
  assert.equal(new Set(stories.map((s) => s.sprint_order)).size, stories.length, "no order ties");
});

test("a new active Story created while history exists stays above FINAL; history never rises above FINAL", async () => {
  stories = [row(1, F, 1), row(2, "X", 2, DONE), row(3, "new", 3)];
  assert.deepEqual(await keepCanonicalOrder(new TaigaClient(), 300), { present: true, moved: true });
  assert.deepEqual(order(), ["new", F, "X"]);
});

test("explicit reorder inside the active partition is respected; the FINAL/history boundary holds and nothing is rewritten", async () => {
  stories = [row(1, "B", 1), row(2, "A", 2), row(3, F, 3), row(4, "X", 4, DONE)];
  assert.deepEqual(await keepCanonicalOrder(new TaigaClient(), 300), { present: true, moved: false });
  assert.equal(patches.length, 0);
});

test("without a FINAL Story the completed Story goes to the end of the Done history, active Stories stay above it", async () => {
  stories = [row(1, "A", 1), row(2, "active", 2), row(3, "X", 3, DONE)];
  await close("A");
  assert.deepEqual(order(), ["active", "X", "A"]);
});

test("closing FINAL itself sinks it to the end of the Done history; it is no longer a gate", async () => {
  stories = [row(1, F, 1), row(2, "X", 2, DONE), row(3, "Y", 3, DONE)];
  assert.deepEqual(await close(F), { moved: true });
  assert.deepEqual(order(), ["X", "Y", F]);
});

test("a Done FINAL is ordinary history: a later Story completion lands after it, an active Story stays above", async () => {
  stories = [row(1, "A", 1), row(2, "X", 2, DONE), row(3, F, 3, DONE)];
  await close("A");
  assert.deepEqual(order(), ["X", F, "A"]);
});

test("already canonical: no write", async () => {
  stories = [row(1, "active", 1), row(2, F, 2), row(3, "A", 3, DONE)];
  assert.deepEqual(await close("A"), { moved: false, reason: "already_in_place" });
  assert.equal(patches.length, 0);
});

test("a Story with no Sprint is a no-op", async () => {
  stories = [row(1, "A", 1, DONE, null)];
  assert.deepEqual(await close("A"), { moved: false, reason: "no_sprint" });
  assert.equal(patches.length, 0);
});

test("a failing PATCH rejects so the caller can report it", async () => {
  stories = [row(1, "A", 1), row(2, "active", 2)];
  failPatch = true;
  await assert.rejects(close("A"));
});

test("a cancelled Story sinks after existing Done and Cancelled history; active Stories and FINAL stay above", async () => {
  stories = [row(1, "A", 1), row(2, F, 2), row(3, "X", 3, DONE), row(4, "Y", 4, CANCELLED)];
  assert.deepEqual(await close("A", CANCELLED), { moved: true });
  assert.deepEqual(order(), [F, "X", "Y", "A"]);
});

test("a cancelled FINAL is ordinary closed history, not a gate: active Stories are not held behind it", async () => {
  stories = [row(1, "X", 1, DONE), row(2, F, 2, CANCELLED), row(3, "active", 3)];
  assert.deepEqual(await keepCanonicalOrder(new TaigaClient(), 300), { present: true, moved: true });
  assert.deepEqual(order(), ["active", "X", F]);
});

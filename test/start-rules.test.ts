import { test } from "node:test";
import assert from "node:assert/strict";
import { storyStartRefusal, taskStartRefusal, refusalMessage } from "../dist/workflow/start-rules.js";

// Task 379: start rules on fresh Taiga reads. They only refuse; they never reorder and keep no state.
const S = { ready: 10, prog: 11, val: 12, done: 13, human: 14, canc: 15 };
const T = { todo: 1, prog: 2, val: 3, human: 4, done: 5, canc: 6, req: 7 };
const STORY_ST = [[S.ready, "Ready"], [S.prog, "In Progress"], [S.val, "GPT Validation"], [S.done, "Done"], [S.human, "Human Decision"], [S.canc, "Cancelled"]].map(([id, name]) => ({ id, name }));
const TASK_ST = [[T.todo, "To Do"], [T.prog, "In Progress"], [T.val, "GPT Validation"], [T.human, "Human Decision"], [T.done, "Done"], [T.canc, "Cancelled"], [T.req, "Request"]].map(([id, name]) => ({ id, name }));
type Row = Record<string, unknown>;
// A fake Taiga that reads `world` on every call, so a test can change the board between two decisions.
const taiga = (world: { stories: Row[]; tasks: Row[] }) => ({
  get: async (path: string) => {
    if (path === "/userstory-statuses") return STORY_ST;
    if (path === "/task-statuses") return TASK_ST;
    const m = /^\/userstories\/(\d+)$/.exec(path);
    return world.stories.find((s) => s.id === Number(m![1]));
  },
  getAll: async (path: string, p: Row) => (path === "/userstories" ? world.stories.filter((s) => s.milestone === p.milestone) : world.tasks.filter((t) => (p.milestone !== undefined ? t.milestone === p.milestone : t.user_story === p.user_story))),
}) as never;
const story = (id: number, order: number, status: number, o: Row = {}) => ({ id, ref: 300 + id, sprint_order: order, status, milestone: 1, subject: `S${id}`, is_blocked: false, ...o });
const task = (id: number, order: number, status: number, o: Row = {}) => ({ id, ref: 900 + id, taskboard_order: order, status, user_story: 1, milestone: 1, is_blocked: false, ...o });

test("Story order: the first unfinished Story starts; a lower one is refused naming the Story above it, and an explicit reorder lets it start", async () => {
  const world = { stories: [story(1, 1, S.ready), story(2, 2, S.ready)], tasks: [] as Row[] };
  assert.equal(await storyStartRefusal(taiga(world), 49, world.stories[0]), null);
  const refused = (await storyStartRefusal(taiga(world), 49, world.stories[1]))!;
  assert.deepEqual([refused.kind, refused.ref, refused.status], ["story_order", 301, "Ready"]);
  assert.match(refused.remediation, /reorder the Sprint in Taiga/);
  assert.match(refusalMessage(refused, "Story #302"), /cannot enter In Progress.*#301/);
  [world.stories[0].sprint_order, world.stories[1].sprint_order] = [2, 1]; // the explicit reorder, done in Taiga
  assert.equal(await storyStartRefusal(taiga(world), 49, world.stories[1]), null, "fresh read honors the new order");
  assert.notEqual(await storyStartRefusal(taiga(world), 49, world.stories[0]), null, "and now the other one waits");
});

test("Story order: Done and Cancelled Stories above are out of the way; a blocked or Human Decision Story above halts the rest (nothing is skipped)", async () => {
  const world = { stories: [story(1, 1, S.done), story(2, 2, S.canc), story(3, 3, S.ready)], tasks: [] as Row[] };
  assert.equal(await storyStartRefusal(taiga(world), 49, world.stories[2]), null);
  world.stories.push(story(4, 4, S.ready));
  world.stories[2].is_blocked = true; // a blocked Ready Story above
  assert.equal((await storyStartRefusal(taiga(world), 49, world.stories[3]))!.ref, 303, "blocked is not skipped");
  world.stories[2].is_blocked = false; world.stories[2].status = S.human;
  assert.equal((await storyStartRefusal(taiga(world), 49, world.stories[3]))!.status, "Human Decision");
});

test("Story order: the FINAL review Story is not a predecessor of the Stories listed below it, but it waits for everything above itself", async () => {
  const final = story(9, 1, S.ready, { subject: "FINAL Sprint Engineering Review" });
  const world = { stories: [final, story(2, 2, S.ready)], tasks: [] as Row[] };
  assert.equal(await storyStartRefusal(taiga(world), 49, world.stories[1]), null, "FINAL above does not block a normal Story");
  assert.equal((await storyStartRefusal(taiga(world), 49, final)), null, "nothing above FINAL");
  final.sprint_order = 3; // canonical: FINAL last
  assert.equal((await storyStartRefusal(taiga(world), 49, final))!.ref, 302, "FINAL waits for the unfinished Story above it");
});

test("Task order: a lower Task is refused until the Tasks above it are Done or Cancelled; a Task is never skipped", async () => {
  const world = { stories: [story(1, 1, S.prog)], tasks: [task(10, 1, T.todo), task(11, 2, T.todo)] };
  assert.equal(await taskStartRefusal(taiga(world), 49, world.tasks[0]), null);
  const refused = (await taskStartRefusal(taiga(world), 49, world.tasks[1]))!;
  assert.deepEqual([refused.kind, refused.ref], ["task_order", 910]);
  world.tasks[0].status = T.val; // handed to validation: still unfinished
  assert.equal((await taskStartRefusal(taiga(world), 49, world.tasks[1], true))!.status, "GPT Validation", "another column: the single-active-Task rule holds it back");
  world.tasks[0].status = T.done;
  assert.equal(await taskStartRefusal(taiga(world), 49, world.tasks[1]), null);
  world.tasks[0].status = T.todo; world.tasks[0].is_blocked = true;
  assert.equal((await taskStartRefusal(taiga(world), 49, world.tasks[1]))!.ref, 910, "a blocked Task above halts the ones below it");
  world.tasks[0].is_blocked = false; world.tasks[0].status = T.canc;
  assert.equal(await taskStartRefusal(taiga(world), 49, world.tasks[1]), null, "Cancelled is out of the way");
});

test("Single active Task: a second In Progress Task in the same Sprint is refused with the active Task; other Sprints do not count, and a resume ignores GPT Validation, Request and Human Decision", async () => {
  const world = { stories: [story(1, 1, S.prog), story(2, 2, S.prog, { milestone: 1 })], tasks: [task(10, 1, T.prog), task(20, 1, T.todo, { user_story: 2 })] };
  const refused = (await taskStartRefusal(taiga(world), 49, world.tasks[1]))!;
  assert.deepEqual([refused.kind, refused.ref, refused.status], ["active_task", 910, "In Progress"]);
  assert.match(refused.remediation, /wait until Task #910 is Done or Cancelled/);
  for (const status of [T.val, T.req, T.human]) { world.tasks[0].status = status; assert.notEqual((await taskStartRefusal(taiga(world), 49, world.tasks[1]))?.kind, "active_task", `status ${status} does not refuse a resume`); }
  world.tasks[0].status = T.prog; world.tasks[0].milestone = 2; // another Sprint
  assert.notEqual((await taskStartRefusal(taiga(world), 49, world.tasks[1]))?.kind, "active_task");
});

test("A fresh start (To Do -> In Progress) is refused while another Task of the Sprint is In Progress, Request, GPT Validation or Human Decision, and allowed once it is Done or Cancelled", async () => {
  const world = { stories: [story(1, 1, S.prog)], tasks: [task(10, 1, T.prog), task(11, 2, T.todo)] };
  for (const [status, name] of [[T.prog, "In Progress"], [T.req, "Request"], [T.val, "GPT Validation"], [T.human, "Human Decision"]] as const) {
    world.tasks[0].status = status;
    const refused = (await taskStartRefusal(taiga(world), 49, world.tasks[1], true))!;
    assert.deepEqual([refused.kind, refused.ref, refused.status], ["active_task", 910, name]);
  }
  world.tasks[0].milestone = 2; // another Sprint does not count
  world.tasks[0].status = T.req;
  assert.notEqual((await taskStartRefusal(taiga(world), 49, world.tasks[1], true))?.kind, "active_task");
  world.tasks[0].milestone = 1;
  for (const status of [T.done, T.canc]) { world.tasks[0].status = status; assert.equal(await taskStartRefusal(taiga(world), 49, world.tasks[1], true), null); }
});

test("Request -> In Progress on the same Task is not a second active Task; it is refused only if another Task is In Progress or the order genuinely blocks it", async () => {
  const world = { stories: [story(1, 1, S.prog)], tasks: [task(10, 1, T.req), task(11, 2, T.todo)] };
  assert.equal(await taskStartRefusal(taiga(world), 49, world.tasks[0]), null, "the same Task resumes");
  world.tasks[1].status = T.prog;
  assert.equal((await taskStartRefusal(taiga(world), 49, world.tasks[0]))!.kind, "active_task");
});

test("a Task whose parent Story has an unfinished Story above it is refused with that Story", async () => {
  const world = { stories: [story(1, 1, S.ready), story(2, 2, S.prog)], tasks: [task(20, 1, T.todo, { user_story: 2 })] };
  const refused = (await taskStartRefusal(taiga(world), 49, world.tasks[0]))!;
  assert.deepEqual([refused.kind, refused.ref], ["story_order", 301]);
});

test("no state is kept: the same call gives a new answer as soon as Taiga changes", async () => {
  const world = { stories: [story(1, 1, S.prog)], tasks: [task(10, 1, T.todo), task(11, 2, T.todo)] };
  assert.notEqual(await taskStartRefusal(taiga(world), 49, world.tasks[1]), null);
  world.tasks[0].status = T.done;
  assert.equal(await taskStartRefusal(taiga(world), 49, world.tasks[1]), null);
});

test("Task order is the taskboard_order of the Task's own column: another column, another Story and a missing Sprint do not count", async () => {
  const world = { stories: [story(1, 1, S.prog), story(2, 2, S.prog)], tasks: [task(10, 1, T.todo, { user_story: 2 }), task(11, 2, T.todo)] };
  assert.equal(await taskStartRefusal(taiga(world), 49, world.tasks[1]), null, "an open Task of another Story in the same column is not above it");
  world.tasks[0].user_story = 1;
  assert.equal((await taskStartRefusal(taiga(world), 49, world.tasks[1]))!.ref, 910, "the same Story, same column, lower taskboard_order");
  world.tasks[1].taskboard_order = 0;
  assert.equal(await taskStartRefusal(taiga(world), 49, world.tasks[1]), null, "a lower taskboard_order starts first");
  world.tasks[1].taskboard_order = 2; world.tasks[1].milestone = null;
  assert.equal(await taskStartRefusal(taiga(world), 49, world.tasks[1]), null, "no Sprint, no taskboard column, nothing visible to order");
});

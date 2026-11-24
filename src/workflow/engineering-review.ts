import { TaigaClient } from "../client.js";
import { SECTIONS } from "../description-sections.js";
import { vocabulary } from "./policy.js";
import { mutate } from "./mutation.js";

// Canonical "FINAL Sprint Engineering Review" quality gate (Issue #250): ONE template, ONE ensure function, ONE canonical-order rule (unfinished -> FINAL -> Done history).
// Everything goes through the Taiga client (never through the governed tools), so the hook cannot recurse into itself.
// Taiga is the only state: the Story is found by its canonical subject, the order is the Sprint's sprint_order, nothing is cached.

export const REVIEW_SUBJECT = "FINAL Sprint Engineering Review";
const REVIEW_TAG = "engineering-review";
export const REVIEW_TASKS = ["Execute integrated final engineering review"] as const;
const REVIEW_TASK_TAGS = [REVIEW_TAG, "final", "validation"];


// A governed description must carry exactly the SECTIONS, in order, with the content given per section; the review is a quality gate, never a source of product requirements.
const describe = (content: Record<string, string>) => SECTIONS.map((s) => `**${s}**\n${content[s] ?? "Per the Sprint Engineering Review contract (Issue #250)."}\n`).join("\n");
const storyDescription = () => describe({
  Purpose: "Final engineering quality gate of this Sprint: one integrated, adversarial review of the Sprint and of the technical state it touches, before the Sprint can close.",
  Context: "Created automatically with every governed Sprint (Issue #250) and kept relative-last: after every unfinished Story, before the Done history. It carries exactly one integrated review Task instead of several fragmented review Tasks, to avoid review-of-review loops on small Sprints.",
  "What to do": "Execute the single integrated review Task, covering every review axis (architecture, ownership and DRY; SOLID, KISS, YAGNI; hardcodes and configuration; source of truth and state duplication; error handling and idempotency; tests, build, typecheck and lint; Sprint Issue hygiene; final readiness). Blockers introduced or exposed by the Sprint become corrective work in the Sprint; pre-existing or non-blocking findings become backlog Issues; revalidation after a fix covers only the delta and the affected gates.",
  Deliverables: "A documented integrated review with findings and evidence, Issues for non-blocking debt, tracked corrections for blockers, and an explicit readiness decision for the Sprint.",
  "Acceptance / Evidence": "The integrated Task is Done with every review axis covered, tests, build, typecheck and lint verified, no known blocker without a destination, and a clear readiness decision; only then can this Story be Done and the Sprint closed.",
  "Do not": "Do not create product requirements or gap work from this review; findings become Issues. Do not split the review into several Tasks, do not skip this Story, and do not close the Sprint with a known blocker.",
  Dependencies: "Every other Story of the Sprint must be Done before this gate is validated; corrective work found by the review is completed first.",
  Documentation: "Findings and evidence are recorded in Taiga on the integrated review Task; the contract lives in the Taiga MCP README (Sprint Engineering Review) and in src/workflow/engineering-review.ts.",
  "Execution Notes": "GPT executes and validates the review; Claude enters only for code and test corrections. This Story is the only operational Engineering Review gate of the Sprint.",
});
const taskDescription = () => describe({
  Purpose: "Run the integrated final engineering review of this Sprint in one Task.",
  "What to do": "Review the Sprint and the relevant technical state of the project as a whole, adversarially and beyond the immediate diff: architecture, ownership and DRY; SOLID, KISS, YAGNI and pattern use; hardcoded values and configuration; source-of-truth and state duplication; error handling and idempotency; tests, regressions, build, typecheck and lint; Sprint Issue hygiene; final readiness. Classify findings: blockers introduced or exposed by the Sprint become corrective work in the Sprint; pre-existing or non-blocking findings become backlog Issues. After a correction, revalidate only the delta, the affected gates and the necessary final gates.",
  Deliverables: "Documented integrated review; findings with evidence; Issues for non-blocking debt; tracked blocking corrections; explicit final readiness decision for the Sprint.",
  "Acceptance / Evidence": "Every review axis is covered explicitly; tests, build, typecheck and lint are verified; no known regression or blocker without a destination; focused revalidation of every correction; clear readiness decision.",
  "Do not": "Do not recreate the eight former review Tasks. Do not review only the Sprint diff superficially. Do not rerun everything indiscriminately after each small correction. Do not close the Sprint with a known blocker; do not create product requirements from this review.",
  "Execution Notes": "GPT executes and validates. Claude enters only for code and test corrections. This is the only operational Engineering Review gate of the Sprint.",
});
interface StoryRow { id: number; subject?: string; sprint_order?: number; version?: number; status?: number; generated_from_issue?: number | null; ref?: number; status_extra_info?: { is_closed?: boolean } }

const byOrder = (rows: StoryRow[]) => [...rows].sort((a, b) => (a.sprint_order ?? 0) - (b.sprint_order ?? 0) || a.id - b.id);
const sprintStories = async (client: TaigaClient, sprint: number) => (await client.get("/userstories", { milestone: sprint, order_by: "sprint_order" })) as StoryRow[];

// THE canonical Sprint order, shared by the FINAL gate and the post-close sink: unfinished Stories -> FINAL -> closed history (a closed FINAL is plain history).
// Closed history is the semantic status names Done and Cancelled of the project vocabulary (never userstory.is_closed, never a status id). The relative order inside each
// partition is kept; `sink` is a just-completed Story that goes to the very end of the history. Only rows that break a strictly increasing
// sprint_order are written (fresh version each), the result is re-read and must equal the target. Without a FINAL Story and without a `sink`
// nothing is arranged (existing Sprints are not retrofitted by a plain Story change).
export async function arrangeSprint(client: TaigaClient, sprint: number, sink?: number): Promise<{ present: boolean; moved: boolean }> {
  const rows = byOrder(await sprintStories(client, sprint));
  const final = rows.find((r) => r.subject === REVIEW_SUBJECT);
  if (!final && sink === undefined) return { present: false, moved: false };
  const { project } = (await client.get(`/milestones/${sprint}`)) as { project?: number };
  const done = new Set([...vocabulary("userstory", await client.get("/userstory-statuses", { project })).nameById].filter(([, name]) => name === "done" || name === "cancelled").map(([id]) => id));
  const isDone = (r: StoryRow) => r.status !== undefined && done.has(r.status);
  // FINAL is a gate only while unfinished; once it is Done or Cancelled it is ordinary Done history (and sinks to the tail when it is the just-completed Story).
  const gate = final && !isDone(final) ? final : undefined;
  const rest = rows.filter((r) => r !== gate);
  const target = [...rest.filter((r) => r.id !== sink && !isDone(r)), ...(gate ? [gate] : []), ...rest.filter((r) => r.id !== sink && isDone(r)), ...rest.filter((r) => r.id === sink)];
  if (target.map((r) => r.id).join() === rows.map((r) => r.id).join()) return { present: !!final, moved: false };

  let previous = 0, writes = 0;
  for (const row of target) {
    if ((row.sprint_order ?? 0) > previous) { previous = row.sprint_order ?? 0; continue; }
    previous += 1;
    const expected = previous;
    const moved = await mutate(client, {
      read: () => client.get(`/userstories/${row.id}`) as Promise<StoryRow>,
      write: (current, w) => w.patch("userstory", row.id, { sprint_order: expected }, current.version),
      verify: (after) => (after.sprint_order === expected ? null : `Story ${row.id} sprint_order read back is not ${expected}`),
    });
    if (moved.written && moved.integrity) throw new Error(moved.integrity);
    writes++;
  }
  const after = byOrder(await sprintStories(client, sprint)).map((r) => r.id).join();
  if (after !== target.map((r) => r.id).join()) throw new Error(`Sprint ${sprint} order after the reorder is not unfinished -> FINAL -> Done history`);
  return { present: !!final, moved: writes > 0 };
}

// FINAL is relative-last: after every unfinished Story, before the Done history. Reasserted after every Story change in the Sprint.
export const keepCanonicalOrder = (client: TaigaClient, sprint: number) => arrangeSprint(client, sprint);

// Idempotent: creates the Story and any missing standard Task, never a duplicate; a duplicated review Story is reported, not deleted.
export async function ensureEngineeringReview(client: TaigaClient, sprint: number) {
  const { project } = (await client.get(`/milestones/${sprint}`)) as { project: number };
  const rows = await sprintStories(client, sprint);
  const found = rows.filter((r) => r.subject === REVIEW_SUBJECT);
  if (found.length > 1) throw new Error(`Sprint ${sprint} has ${found.length} "${REVIEW_SUBJECT}" Stories; exactly one is required`);
  let story = found[0];
  if (!story) {
    const made = await mutate(client, {
      read: async () => (await sprintStories(client, sprint)).filter((r) => r.subject === REVIEW_SUBJECT),
      validators: [(now) => (now.length ? "the FINAL review Story already exists" : null)],
      write: (_now, w) => w.create("userstory", { project, subject: REVIEW_SUBJECT, milestone: sprint, tags: [REVIEW_TAG], description: storyDescription() }) as Promise<StoryRow>,
      verify: (after) => (after.length === 1 ? null : `Sprint ${sprint} has ${after.length} "${REVIEW_SUBJECT}" Stories after the creation; exactly one is required`),
    });
    if (!made.written) throw new Error(made.problem);
    if (made.integrity) throw new Error(made.integrity);
    story = made.result;
  }
  const storyId = story.id;
  let created = 0;
  for (const subject of REVIEW_TASKS) {
    const task = await mutate(client, {
      read: async () => ((await client.get("/tasks", { user_story: storyId })) as { subject?: string }[]).map((t) => t.subject),
      validators: [(have) => (have.includes(subject) ? "already exists" : null)],
      write: (_have, w) => w.create("task", { project, user_story: storyId, milestone: sprint, subject, tags: REVIEW_TASK_TAGS, description: taskDescription() }),
      verify: (after) => (after.includes(subject) ? null : `the review Task "${subject}" is not in the Story after the creation`),
    });
    if (task.written && task.integrity) throw new Error(task.integrity);
    if (task.written) created++;
  }
  const order = await keepCanonicalOrder(client, sprint);
  return { story_id: story.id, story_created: found.length === 0, tasks_created: created, tasks_total: REVIEW_TASKS.length, reordered: order.moved };
}

// Final-review helper (Tasks #256/#257): Issue -> Sprint hygiene of a Sprint, fail closed. Only Stories generated from an Issue are audited;
// a Story without a source Issue is legitimate and gets no fabricated linkage. `findings` are the mechanical mismatches; `audit` exposes the plain
// facts of every Story/Issue pair (nullable when Taiga does not return them) so the final GPT review judges resolution/evidence freshness itself.
type Closed = { status_extra_info?: { is_closed?: boolean } };
type Dated = { modified_date?: string | null; finish_date?: string | null; finished_date?: string | null };
export async function sprintIssueFindings(client: TaigaClient, sprint: number) {
  const findings: { story_ref?: number; issue: number; finding: "issue_not_in_sprint" | "issue_closed_story_open" | "story_closed_issue_open" }[] = [];
  const audit: Record<string, unknown>[] = [];
  for (const story of await sprintStories(client, sprint)) {
    if (!story.generated_from_issue) continue;
    const st = story as StoryRow & Closed & Dated;
    const issue = (await client.get(`/issues/${story.generated_from_issue}`)) as { id?: number; ref?: number; milestone?: number | null } & Closed & Dated;
    const storyClosed = st.status_extra_info?.is_closed === true, issueClosed = issue.status_extra_info?.is_closed === true;
    audit.push({
      story_ref: story.ref ?? null, story_id: story.id, story_closed: storyClosed, story_modified: st.modified_date ?? null, story_finished: st.finish_date ?? null,
      issue: story.generated_from_issue, issue_ref: issue.ref ?? null, issue_milestone: issue.milestone ?? null, issue_closed: issueClosed, issue_modified: issue.modified_date ?? null, issue_finished: issue.finished_date ?? null,
    });
    const finding = issue.milestone !== sprint ? "issue_not_in_sprint" : issueClosed && !storyClosed ? "issue_closed_story_open" : storyClosed && !issueClosed ? "story_closed_issue_open" : null;
    if (finding) findings.push({ story_ref: story.ref, issue: story.generated_from_issue, finding });
  }
  return { ok: findings.length === 0, findings, audit };
}

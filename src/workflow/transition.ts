import type { TaigaClient } from "../client.js";
import { callerRole, type WorkflowIdentity } from "./actor.js";
import { validateArtifact } from "./artifacts.js";
import { createHash } from "node:crypto";
import { uuidv7 } from "../identity.js";
import { loadSigner, mergeContextProblems, signMergeAuthorization, type MergeContext, type Signer, type WorkItemIdentity } from "./merge-auth.js";
import { projectResolver, renderGovernedArtifact } from "./refs.js";
import { analyse, orderedComments, UnsupportedArtifactError, type HistoryItem } from "./state.js";
import { latest, loadTemplates, nameFor, TemplateError } from "./templates.js";
import { actionsFor, closureFor, integrityMessage, norm, resolveTransition, vocabulary, type EntityKind } from "./policy.js";
import { allowedActions, evaluate, recipientOf } from "../policy/evaluator.js";
import type { ManagedPolicy, PolicyRuntime } from "../policy/runtime.js";
import { rejection } from "./reject.js";
import { bindingRejection } from "./account-binding.js";
import { assigneeProblem, resolveAssignee } from "./assignment.js";
import { mutate } from "./mutation.js";
import { storyHasChildTask } from "./validators.js";
import { refusalMessage, storyStartRefusal, taskStartRefusal, type Refusal } from "./start-rules.js";
import { BASE, STATUS_BASE, text, violation, type ToolResult } from "./result.js";
import { authorizationTravels, noticeForTransition } from "./notify.js";
import { announce } from "./continuation.js";
import { moveClosedStoryToTail } from "./story-order.js";
import { childTaskStates, promoteStoryWhenChildrenTerminal } from "./story-readiness.js";

// Statuses are addressed by NAME (ids differ per project and are never written in rules or logic); a number is still accepted for the
// generic tools' compatibility. A missing or ambiguous name fails closed and mutates nothing.
export async function resolveStatusRef(client: TaigaClient, entity: EntityKind, project: number | undefined, status: number | string): Promise<{ id: number } | { error: string }> {
  if (typeof status === "number") return { id: status };
  if (project === undefined) return { error: `cannot resolve status "${status}": the ${entity} has no project` };
  const statuses = (await client.get(`/${STATUS_BASE[entity]}`, { project })) as { id?: number; name?: string }[];
  const wanted = norm(status);
  const hits = (Array.isArray(statuses) ? statuses : []).filter((s) => typeof s?.id === "number" && typeof s?.name === "string" && norm(s.name) === wanted);
  if (hits.length === 1) return { id: hits[0].id! };
  const names = (Array.isArray(statuses) ? statuses : []).map((s) => s.name).filter(Boolean).join(", ");
  return { error: hits.length === 0 ? `no ${entity} status named "${status}" in project ${project}. Available: ${names}` : `status name "${status}" is ambiguous in project ${project} (${hits.length} statuses carry it); fix the project's statuses` };
}

// Status metadata that contradicts the derived closure semantics (e.g. "Done" configured is_closed=false) is a workflow integrity error:
// fail closed BEFORE any mutation, never compensate silently. Undefined metadata (not exposed) cannot contradict.
export function closureMetadataProblem(entity: EntityKind, toName: string, meta: { is_closed?: unknown } | undefined): string | null {
  const want = closureFor(entity, toName);
  if (want === undefined || typeof meta?.is_closed !== "boolean" || meta.is_closed === want) return null;
  return `workflow integrity: this project's ${entity} status "${toName}" is configured is_closed=${meta.is_closed}, but its workflow semantics require is_closed=${want}; fix the status definition (the MCP does not compensate)`;
}

// After a mutation, reread and prove the status; for a Task also the derived closure. A User Story proves ONLY its status: this Taiga derives
// userstory.is_closed/finish_date from the child Tasks and ignores any write to them, so they never decide the Story workflow (Issue #243).
export async function closureIntegrityFailure(client: TaigaClient, entity: EntityKind, id: number, wantStatus: number, toName: string): Promise<string | null> {
  const want = entity === "task" ? closureFor("task", toName) : undefined;
  const reread = (await client.get(`/${BASE[entity]}/${id}`)) as { status?: number; is_closed?: unknown };
  const problems: string[] = [];
  if (reread?.status !== wantStatus) problems.push(`status is ${String(reread?.status)}, expected ${wantStatus}`);
  if (want !== undefined && typeof reread?.is_closed === "boolean" && reread.is_closed !== want) problems.push(`is_closed is ${reread.is_closed}, expected ${want} for "${toName}"`);
  return problems.length ? `integrity failure after the ${entity} transition: ${problems.join("; ")}` : null;
}

// Child-Task gate for Story -> GPT Validation. Semantic Task status (by NAME) must be terminal (Done or Cancelled) for EVERY child; is_closed alone
// never counts. A Story with no child Task is refused (nothing was executed to hand off). The terminal rule is owned by story-readiness.ts.
async function childTaskProblems(client: TaigaClient, storyId: number, project: number | undefined): Promise<string[]> {
  if (project === undefined) return ["cannot verify the child Tasks: the Story has no project"];
  const children = await childTaskStates(client, storyId, project);
  if (children.length === 0) return ["the Story has no child Task: nothing was executed, so it cannot enter GPT Validation"];
  const blockers = children.filter((c) => !c.terminal).map((c) => `Task #${c.ref} is "${c.display}"`);
  return blockers.length ? [`every child Task must be Done or Cancelled before the Story enters GPT Validation; blocking: ${blockers.join(", ")}`] : [];
}

export interface TransitionArgs { entity: EntityKind; id: number; status: number; author?: string; comment?: string; artifact?: Record<string, unknown>; mergeContext?: unknown; model?: unknown; effort?: unknown }
interface Item { project?: number; status?: number; ref?: number; user_story?: number | null; milestone?: number | null; subject?: string; sprint_order?: number; taskboard_order?: number }

// Everything the signed claims need from Taiga, resolved BEFORE the Done is written: the approved item's UUID and its authoritative merge
// destination (a Task merges into its own Story, a Story into its own Sprint). Any gap fails closed with a message and zero writes.
async function mergeIdentity(client: TaigaClient, kind: "task" | "userstory", item: Item, ctx: MergeContext): Promise<{ problems: string[]; identity?: WorkItemIdentity; target?: string }> {
  try {
    const project = item.project!;
    const resolve = projectResolver(client, project);
    const identity = { kind, uuid: await resolve(kind, item.ref!), ref: item.ref! };
    if (kind === "task") {
      if (item.user_story == null) return { problems: ["the Task has no parent Story: there is no merge destination to authorize"] };
      const story = (await client.get(`/userstories/${item.user_story}`)) as { ref?: number; project?: number };
      if (typeof story.ref !== "number" || story.project !== project) return { problems: ["the parent Story is missing or belongs to another project"] };
      if (!ctx.target_branch.startsWith(`feature/story-${story.ref}-`)) return { problems: [`merge_context.target_branch must start with feature/story-${story.ref}- (the Task's own Story)`] };
      return { problems: [], identity, target: `Story ${await resolve("userstory", story.ref)} (#${story.ref})` };
    }
    if (item.milestone == null) return { problems: ["the Story has no Sprint: there is no merge destination to authorize"] };
    const sprint = (await client.get(`/milestones/${item.milestone}`)) as { id?: number; project?: number };
    if (sprint.id !== item.milestone || sprint.project !== project) return { problems: ["the Story's Sprint is missing or belongs to another project"] };
    if (!ctx.target_branch.startsWith(`feature/sprint-${sprint.id}-`)) return { problems: [`merge_context.target_branch must start with feature/sprint-${sprint.id}- (the Story's own Sprint)`] };
    return { problems: [], identity, target: `Sprint #${sprint.id}` };
  } catch (e) { return { problems: [(e as Error).message] }; }
}

// Strict profile transition: actor/state matrix + typed artifact. Returns null when the generic (legacy) path applies.
// Every rejection happens before any Taiga mutation; the artifact is posted first, proven in history, then the status moves.
export async function strictTransition(client: TaigaClient, identity: WorkflowIdentity, a: TransitionArgs, item: Item, sign: typeof signMergeAuthorization = signMergeAuthorization, runtime?: PolicyRuntime): Promise<ToolResult | null> {
  return decideAndWrite(client, identity, a, item, sign, runtime);
}

async function decideAndWrite(client: TaigaClient, identity: WorkflowIdentity, a: TransitionArgs, item: Item, sign: typeof signMergeAuthorization, runtime?: PolicyRuntime): Promise<ToolResult | null> {
  const statuses = item.project === undefined ? undefined : await client.get(`/${STATUS_BASE[a.entity]}`, { project: item.project });
  const vocab = vocabulary(a.entity, statuses);
  const hasComment = typeof a.comment === "string" && a.comment.trim() !== "";
  const broken = integrityMessage(a.entity, vocab);
  if (broken) return rejection({ code: "WORKFLOW_TRANSITION_REJECTED", message: broken, violations: [broken] });
  if (!vocab.strict) {
    return a.artifact !== undefined ? violation([`this project does not expose the workflow status vocabulary (missing: ${vocab.missing.join(", ")}); \`artifact\` applies only to projects that do`]) : null;
  }
  // Strict workflow: every mutation needs an AUTHENTICATED actor. A typed `author` is a signature, never authority.
  const from = vocab.nameById.get(item.status ?? -1);
  const to = vocab.nameById.get(a.status);
  const base = { actor: identity.actor?.role ?? null, currentStatus: vocab.displayById.get(item.status ?? -1), attempted: vocab.displayById.get(a.status) };
  if (!identity.actor) {
    return rejection({ ...base, code: "WORKFLOW_IDENTITY_REQUIRED", message: "authenticated actor identity is required for strict workflow mutations", violations: ["authenticated actor identity is required for strict workflow mutations"] });
  }
  const bound = await bindingRejection(client, identity.actor, base);
  if (bound) return bound;
  if (!from || !to) return rejection({ ...base, code: "WORKFLOW_TRANSITION_REJECTED", message: `status ${!from ? item.status : a.status} is not a status of this project's ${a.entity} workflow` });
  const author = identity.actor.display;
  const role = callerRole(identity, author);
  // A project the policy engine manages is decided by its active policy; any other project keeps the legacy rules. If the engine cannot say
  // which one applies, the answer is a refusal, never the legacy path.
  let managed: ManagedPolicy | null = null;
  if (runtime && item.project !== undefined) {
    try { managed = await runtime.forProject(item.project); } catch (e) {
      return rejection({ ...base, code: "WORKFLOW_POLICY_UNAVAILABLE", message: `the policy of this project cannot be resolved, so the transition is refused: ${(e as Error).message}` });
    }
  }
  const allowed = () => (managed ? allowedActions(managed.policy, a.entity, role, from, vocab.idByName.keys()) : actionsFor(a.entity, role, from, vocab.idByName.keys())).allowed.map((r) => ({ target_status: r.target, artifact: r.artifact, mode: r.mode }));
  let res = managed ? evaluate(managed.policy, a.entity, role, from, to) : resolveTransition(a.entity, role, from, to);
  if (res.kind === "denied") return rejection({ ...base, code: "WORKFLOW_TRANSITION_REJECTED", message: res.reason, allowed: allowed() });
  if (res.kind === "legacy") return a.artifact !== undefined ? rejection({ ...base, code: "WORKFLOW_TRANSITION_REJECTED", message: `"${from}" -> "${to}" takes a commented transition, not an \`artifact\``, allowed: allowed() }) : null;

  let set;
  try { set = loadTemplates(); } catch (e) {
    if (e instanceof TemplateError) return rejection({ ...base, code: "WORKFLOW_TEMPLATE_UNAVAILABLE", message: e.message });
    throw e;
  }
  let template = latest(set, nameFor(res.artifact, res.mode));
  let ctxBase = { ...base, template, allowed: allowed() };
  if (!a.artifact || typeof a.artifact !== "object" || Array.isArray(a.artifact)) {
    return rejection({ ...ctxBase, code: "WORKFLOW_ARTIFACT_MISSING", message: `a typed artifact (${res.artifact}${res.mode ? `, mode ${res.mode}` : ""}) is required for "${from}" -> "${to}"`, ...(hasComment ? { invalid: ["comment"], violations: ["a governed ownership transition takes a typed `artifact`, not a free-text `comment`"] } : {}) });
  }
  const history = (await client.get(`/history/${a.entity}/${a.id}`)) as HistoryItem[];
  let an: ReturnType<typeof analyse>;
  try { an = analyse(history, set); } catch (e) {
    if (e instanceof UnsupportedArtifactError) return rejection({ ...ctxBase, code: "WORKFLOW_TEMPLATE_UNAVAILABLE", message: e.message, violations: [e.message] });
    throw e;
  }
  // Exception for the Human Decision re-entry: a Task that went To Do -> Human Decision -> GPT Validation has no Blueprint yet, so GPT Validation
  // -> In Progress carries the INITIAL Implementation Blueprint (round 1) instead of a Correction Blueprint against a nonexistent one.
  // Only when the Task really passed through a Human Decision and has no Blueprint; every other case keeps the correction contract.
  if (a.entity === "task" && res.kind === "typed" && res.artifact === "implementation_blueprint" && res.mode === "correction" && !res.override && !an.blueprint && an.decisionRequest) {
    res = { ...res, mode: "initial" };
    template = latest(set, nameFor(res.artifact, res.mode));
    ctxBase = { ...base, template, allowed: allowed() };
  }
  const art = a.artifact;
  const v = validateArtifact({ template, entity: a.entity, artifact: art, actorIsPo: role === "po" });
  const problems: string[] = [...v.messages];
  const invalid: string[] = [...v.invalid];
  const bad = (msg: string, field: string) => { problems.push(msg); invalid.push(field); };
  if (hasComment) bad("a governed ownership transition takes a typed `artifact`, not a free-text `comment`", "comment");

  const pos = (id: string | undefined) => an.all.findIndex((p) => p.id === id);
  const sameId = (given: unknown, current: string | undefined, legacyOk: boolean) => {
    const g = String(given);
    if (current !== undefined) return g === current;
    return legacyOk && an.ids.has(g);
  };
  if (res.artifact === "implementation_blueprint" && res.mode === "correction") {
    if (art.validation_round !== an.validationRound + 1) bad(`validation_round must be ${an.validationRound + 1} (previous round + 1)`, "validation_round");
    if (!sameId(art.supersedes_blueprint_comment_id, an.blueprint?.id, true)) bad(an.blueprint ? `supersedes_blueprint_comment_id must be the current Blueprint comment id ${an.blueprint.id}` : "supersedes_blueprint_comment_id must name an existing Blueprint comment of this Task", "supersedes_blueprint_comment_id");
  }
  if (a.entity === "task" && (res.artifact === "execution_handoff" || res.artifact === "validation_approval") && art.blueprint_comment_id !== undefined) {
    if (!sameId(art.blueprint_comment_id, an.blueprint?.id, true)) bad(an.blueprint ? `blueprint_comment_id must be the current Blueprint comment id ${an.blueprint.id}` : "blueprint_comment_id must name an existing Blueprint comment of this Task", "blueprint_comment_id");
  }
  if (res.artifact === "validation_approval" && art.handoff_comment_id !== undefined) {
    if (!sameId(art.handoff_comment_id, an.handoff?.id, true)) bad(an.handoff ? `handoff_comment_id must be the latest Execution Handoff comment id ${an.handoff.id}` : "handoff_comment_id must name an existing hand-off comment", "handoff_comment_id");
    else if (an.handoff && an.blueprint && pos(an.handoff.id) < pos(an.blueprint.id)) bad("the latest Execution Handoff predates the current Blueprint: the correction has not been handed off yet", "handoff_comment_id");
  }
  if (a.entity === "userstory") {
    const latestHandoff = an.storyHandoff;
    if (res.artifact === "story_validation_handoff") problems.push(...(await childTaskProblems(client, a.id, item.project)));
    if (res.artifact === "story_validation_approval" || res.artifact === "story_correction") {
      if (!latestHandoff) bad("no Story Validation Handoff exists: the Story was never handed off for validation", "handoff_comment_id");
      else if (String(art.handoff_comment_id) !== latestHandoff.id) bad(`handoff_comment_id must be the latest Story Validation Handoff comment id ${latestHandoff.id}`, "handoff_comment_id");
      else if (an.storyCorrection && pos(an.storyCorrection.id) > pos(latestHandoff.id)) bad("the latest Story Validation Handoff predates the latest Story Correction: the Story has to be handed off again", "handoff_comment_id");
    }
  }
  // Merge authorization is requested with the approval that closes a Task or Story. Everything it needs is checked BEFORE any mutation.
  let signer: Signer | undefined;
  let merge: Awaited<ReturnType<typeof mergeIdentity>> | undefined;
  if (a.mergeContext !== undefined) {
    const closing = (res.artifact === "validation_approval" || res.artifact === "story_validation_approval") && to === "done";
    if (!closing || (a.entity !== "task" && a.entity !== "userstory")) bad("merge_context applies only to the approval that moves a Task or Story to Done", "merge_context");
    else {
      for (const p of mergeContextProblems(a.mergeContext, a.entity, item.ref ?? -1)) bad(p, "merge_context");
      try { signer = loadSigner(); } catch (e) { bad(`cannot issue a merge authorization: ${(e as Error).message}`, "merge_context"); }
      if (!invalid.includes("merge_context")) {
        merge = await mergeIdentity(client, a.entity, item, a.mergeContext as MergeContext);
        for (const p of merge.problems) bad(p, "merge_context");
      }
    }
  }
  if (a.entity === "task") {
    const meta = (await client.get(`/${STATUS_BASE.task}/${a.status}`)) as { is_closed?: boolean };
    const bad2 = closureMetadataProblem("task", to, meta);
    if (bad2) return rejection({ ...ctxBase, code: "WORKFLOW_INTEGRITY_FAILURE", message: bad2, violations: [bad2] });
  }
  let requestId: string | undefined;
  const evidenceWarnings: string[] = []; // Request/Response history is EVIDENCE: a missing or mismatching citation is reported here, it never blocks
  let preLines: string[] | undefined;
  let postLines: string[] | undefined;
  if (res.artifact === "workflow_request") {
    // Entering Request: a valid blocking request addressed to GPT, tied to the Blueprint in force.
    if (art.to_actor !== "gpt") bad("a Request-status transition must be addressed to gpt (anything for the PO is a Human Decision Request)", "to_actor");
    if (art.blocking !== true) bad("blocking must be true: while the Task is in Request, Claude has no authority to keep implementing", "blocking");
    const n = Math.max(0, ...an.requests.map((q) => Number(/-(\d+)$/.exec(q.requestId ?? "")?.[1] ?? 0))) + 1;
    requestId = `R-${item.ref ?? a.id}-${n}`;
    preLines = [`Request: ${requestId}`];
    postLines = an.blueprint ? [`Blueprint: ${an.blueprint.id}`] : [];
  }
  if (res.artifact === "request_resume") {
    // Leaving Request is authorized by the CURRENT STATUS (Request) and the actor matrix alone. The artifact cites the request and its answer as
    // evidence; the history never vetoes the move (a manual PO move, an unanswered request, a reused request or a changed Blueprint do not block).
    // Anything that does not line up with the history is reported as a warning, never as a gate.
    const req = an.requests.at(-1);
    const resolving = req ? [...an.all].reverse().find((p) => p.kind === "workflow_response" && p.requestId === req.requestId && p.resolved) : undefined;
    if (!req) evidenceWarnings.push("no Workflow Request found in this Task's history to cite");
    else {
      if (String(art.request_id) !== req.requestId) evidenceWarnings.push(`the cited request_id is not the latest request in the history (${req.requestId})`);
      if (!resolving) evidenceWarnings.push(`no resolving Workflow Request Response (resolved = yes) for ${req.requestId} is in the history`);
      else if (String(art.response_comment_id) !== resolving.id) evidenceWarnings.push(`the cited response_comment_id is not the resolving response in the history (${resolving.id})`);
    }
  }
  if (problems.length) {
    const code = res.artifact === "request_resume" ? "WORKFLOW_RESUME_REJECTED" : res.artifact === "workflow_request" ? "WORKFLOW_REQUEST_REJECTED" : "WORKFLOW_ARTIFACT_INVALID";
    return rejection({ ...ctxBase, code, message: problems[0], violations: problems, missing: v.missing, invalid });
  }

  // Assigned follows the authoritative owner of the target status. Resolved BEFORE any write so an unresolvable owner leaves no partial mutation.
  const assignee = await resolveAssignee(client, item.project as number, a.entity, to);
  if (assignee.problem) return rejection({ ...ctxBase, code: "WORKFLOW_ASSIGNEE_UNRESOLVED", message: assignee.problem, violations: [assignee.problem] });

  const round = res.mode === "correction" ? (art.validation_round as number) + 1 : 1;
  const governed = await renderGovernedArtifact(client, item.project, { template, entity: a.entity, artifact: art, author: identity.actor.role, transition: { from: base.currentStatus ?? from, to: base.attempted ?? to }, meta: { model: a.model, effort: a.effort }, round, preLines, postLines });
  if (!governed.ok) return rejection({ ...ctxBase, code: "WORKFLOW_ARTIFACT_INVALID", message: governed.problems[0], violations: governed.problems });
  const rendered = governed.text;
  const signed = rendered.trimEnd();
  const recs = orderedComments(history);
  if (recs.at(-1)?.comment === signed) return rejection({ ...ctxBase, code: "WORKFLOW_TRANSITION_REJECTED", message: "the rendered artifact must be NEW, not the latest existing comment (a retry of an artifact that already persisted)" });

  const patch: Record<string, unknown> = { status: a.status, ...(assignee.id !== undefined ? { assigned_to: assignee.id } : {}) };
  // Status is the only lifecycle authority. userstory.is_closed/finish_date are upstream metadata derived from the child Tasks: never written or proven.
  if (res.artifact === "blocker_report") { patch.is_blocked = true; patch.blocked_note = art.blocked_note; }
  if (res.artifact === "human_decision_request" && art.blocked === true) { patch.is_blocked = true; patch.blocked_note = art.blocked_note; }

  // An agent starting a card must respect the visible order and the single active Task of the Sprint (read fresh, refusal only, never a reorder).
  let refusal: Refusal | undefined;
  const startValidators = to === "in progress" && (role === "gpt" || role === "claude") && (a.entity === "task" || a.entity === "userstory") && item.project !== undefined
    ? [async () => {
        const row = { id: a.id, ref: item.ref, user_story: item.user_story, milestone: item.milestone, subject: item.subject, sprint_order: item.sprint_order, taskboard_order: item.taskboard_order, status: item.status };
        refusal = (await (a.entity === "task" ? taskStartRefusal(client, item.project as number, row, from === "to do") : storyStartRefusal(client, item.project as number, row))) ?? undefined;
        return refusal ? refusalMessage(refusal, `${a.entity === "task" ? "Task" : "Story"} #${item.ref ?? a.id}`) : null;
      }]
    : [];

  // A managed project records every write it is about to make, so a crash between the comment and the status leaves evidence.
  let journalId: string | undefined;
  if (managed && runtime) {
    try { journalId = await runtime.begin(managed, "workflow_transition", `${a.entity}:${a.id}`); } catch (e) {
      return rejection({ ...ctxBase, code: "WORKFLOW_POLICY_UNAVAILABLE", message: `the mutation journal is not available, so nothing was written: ${(e as Error).message}` });
    }
  }
  // The authorization owed by this Done is stored BEFORE the write, so a crash afterwards can still issue it (once, from the stored context).
  const owed = managed && runtime && merge?.identity && merge.target && item.project !== undefined && (a.entity === "task" || a.entity === "userstory")
    ? { managed, runtime, entity: a.entity, project: item.project, workItem: merge.identity, target: merge.target, authorizationId: uuidv7() } : undefined;
  const authorizationId = owed?.authorizationId;
  if (owed) {
    try {
      await owed.runtime.openMergeObligation(owed.managed, { authorizationId: owed.authorizationId, entity: owed.entity, taigaId: a.id, doneStatus: a.status, taigaProject: owed.project, context: a.mergeContext as MergeContext, workItem: owed.workItem, targetWorkItem: owed.target, journalId: journalId!, actor: role as "gpt" | "claude" | "po", recipient: recipientOf(owed.managed.policy, owed.entity, "done"), approvalHash: createHash("sha256").update(signed).digest("hex") });
    } catch (e) {
      if (journalId && runtime) await runtime.finish(journalId, "failed", { problem: "merge obligation not stored" }).catch(() => undefined);
      return rejection({ ...ctxBase, code: "WORKFLOW_POLICY_UNAVAILABLE", message: `the merge obligation could not be stored, so nothing was written: ${(e as Error).message}` });
    }
  }
  // The artifact comment and the status write go through the one governed write boundary: fresh read, separate validators, write, verification.
  const out = await mutate(client, {
    read: () => client.get(`/${BASE[a.entity]}/${a.id}`),
    validators: [...(a.entity === "userstory" && from === "ready" && to === "in progress" ? [storyHasChildTask(client, a.id)] : []), ...startValidators],
    write: async (_card, w) => {
      await w.comment(a.entity, a.id, rendered);
      const after = orderedComments((await client.get(`/history/${a.entity}/${a.id}`)) as HistoryItem[]);
      const found = [...after].reverse().find((r) => r.comment === signed);
      return found ? { persisted: found, updated: await w.patch(a.entity, a.id, patch) } : { persisted: undefined, updated: undefined };
    },
    verify: async (after, r) => {
      if (!r.persisted) return null;
      if (a.entity === "userstory" || a.entity === "task") {
        const failure = await closureIntegrityFailure(client, a.entity, a.id, a.status, to);
        if (failure) return `${failure}. The artifact is persisted (comment ${r.persisted.id}) and the status write was attempted: this is NOT a successful transition.`;
      }
      const notProjected = assigneeProblem(after as { assigned_to?: number | null }, assignee.id);
      return notProjected ? `${notProjected}. The artifact and the status are persisted (comment ${r.persisted.id}); only the Assigned projection is wrong, status stays authoritative.` : null;
    },
  });
  if (journalId && runtime) {
    const phase = !out.written ? "failed" : out.integrity ? "applied" : "completed";
    await runtime.finish(journalId, phase, { revision: managed?.revision, ...(out.written ? { comment_id: out.result.persisted?.id, integrity: out.integrity ?? null } : { problem: out.problem }) }).catch((e: Error) => process.stderr.write(`policy journal: ${journalId} not closed: ${e.message}\n`));
  }
  if (!out.written && authorizationId && runtime) await runtime.settleMergeObligation(authorizationId, { abandoned: true }).catch(() => undefined);
  if (!out.written) return refusal
    ? rejection({ ...ctxBase, code: "WORKFLOW_START_REFUSED", message: out.problem, violations: [out.problem], blocker: refusal, nextStep: refusal.remediation })
    : rejection({ ...ctxBase, code: "WORKFLOW_PRECONDITION_FAILED", message: out.problem, violations: [out.problem] });
  const { persisted, updated } = out.result;
  if (!persisted) return text({ code: "comment_not_persisted", message: "The artifact is not in the history; the status was NOT changed." }, true);
  if (out.integrity) return text({ code: "WORKFLOW_INTEGRITY_FAILURE", message: out.integrity }, true);
  const target = (await client.get(`/${STATUS_BASE[a.entity]}/${a.status}`)) as { is_closed?: boolean };
  // Sign only now: the Done is persisted and re-read. A signing failure never undoes or invites a retry of the transition.
  let mergeAuth: Record<string, unknown> | undefined;
  if (signer && merge?.identity && merge.target && item.project !== undefined) {
    try {
      const envelope = sign(signer, a.mergeContext as MergeContext, item.project, merge.identity, merge.target, authorizationId);
      if (authorizationId && runtime) await runtime.settleMergeObligation(authorizationId, { signed: envelope, approvalCommentId: persisted.id });
      mergeAuth = { merge_authorization: envelope };
    } catch (e) {
      mergeAuth = { merge_authorization_error: { message: (e as Error).message, note: "The Done transition IS persisted and authoritative; do not retry it. Only the authorization was not issued." } };
    }
  }
  // A closed Story sinks to the tail of its Sprint queue. The closure is already authoritative, so a failure here is reported next to the
  // transition result (never as a failed transition, which a caller could retry) and never suppresses the notification below.
  let queueReorder: unknown;
  if (a.entity === "userstory" && from === "gpt validation" && to === "done") {
    queueReorder = await moveClosedStoryToTail(client, a.id).catch((e: Error) => ({ ok: false, code: "STORY_QUEUE_REORDER_FAILED", message: e.message, note: "The Story Done transition IS persisted; do not retry it. Fix the Sprint order with taiga_move." }));
  }
  // A Task that reaches Done/Cancelled may complete its Story's children: the MCP then promotes the Story to GPT Validation with a mechanical
  // readiness comment (never to Done). The Task transition is already authoritative, so a failure is reported next to it, never as a failed transition.
  let storyPromotion: unknown;
  if (a.entity === "task" && (to === "done" || to === "cancelled")) {
    storyPromotion = await promoteStoryWhenChildrenTerminal(client, identity.actor.role, { ref: item.ref, user_story: item.user_story, project: item.project }, { model: a.model, effort: a.effort })
      .catch((e: Error) => ({ ok: false, code: "STORY_READINESS_PROMOTION_FAILED", message: e.message, note: "The Task transition IS persisted; do not retry it. Promote the Story with an explicit Story Validation Handoff." }));
  }
  // Last step, after the status change is proven: a pointer for the other agent. A failure here never undoes the transition.
  // A signed authorization also rides on the completion notice (stdin, opt-in); the same envelope is always in the result for recovery.
  const notice = a.entity === "task" || a.entity === "userstory" ? noticeForTransition(role, from, to, item.ref, vocab.displayById.get(a.status) ?? to, requestId, a.entity, item.project, managed ? recipientOf(managed.policy, a.entity, to) : undefined) : null;
  const authorization = mergeAuth?.merge_authorization;
  const { notification, continuation } = await announce(notice, persisted.id, process.env, authorization);
  // Exit code 0 proves only that the pointer command ran: the notifier may never have read stdin, so a signed authorization is never reported
  // as delivered. Receipt would need an acknowledgement contract from the Bridge (separate item); the envelope stays in this result.
  const handoff = authorization === undefined ? undefined : { merge_authorization_handoff: !authorizationTravels(notice, authorization) ? "not_attempted" : notification === "sent" ? "attempted_unconfirmed" : "failed" };
  return text({
    transitioned: true, entity: a.entity, id: a.id, status: a.status, from, to, closed: a.entity === "userstory" ? closureFor("userstory", to) === true : target?.is_closed === true,
    actor_role: role, identity: identity.mode, override: res.override,
    artifact: { type: res.artifact, schema: `${template.name}/${template.version}`, comment_id: persisted.id },
    comment_persisted: true, ...(requestId ? { request_id: requestId } : {}), ...(evidenceWarnings.length ? { evidence_warnings: evidenceWarnings } : {}), notification, ...(continuation ? { continuation } : {}), ...(queueReorder ? { queue_reorder: queueReorder } : {}), ...(storyPromotion ? { story_promotion: storyPromotion } : {}), ...(mergeAuth ?? {}), ...(handoff ?? {}), updated,
  });
}

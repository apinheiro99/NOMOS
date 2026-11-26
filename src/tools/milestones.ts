import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TaigaClient } from "../client.js";
import type { WorkflowIdentity } from "../workflow/actor.js";
import { authorizationTravels, type Notice } from "../workflow/notify.js";
import { announce } from "../workflow/continuation.js";
import { loadGitgateKey, loadSigner, mergeContextProblems, publicKeyB64, receiptProblems, signMergeAuthorization, verifyMergeAuthorization, type CompletionReceipt, type MergeContext, type Signer } from "../workflow/merge-auth.js";
import { sprintScopeProblem } from "../workflow/story-readiness.js";
import { createMergeReady, confirmMergeReady, mergeConfirmationProblem, readMergeReady } from "../workflow/merge-ready.js";
import type { PolicyRuntime } from "../policy/runtime.js";
import { recipientOf } from "../policy/evaluator.js";

type Milestone = { id: number; project?: number; closed?: boolean };
const refuse = (message: string) => ({ content: [{ type: "text" as const, text: JSON.stringify({ code: "REFUSED", message }) }], isError: true });

export function registerMilestoneTools(server: McpServer, client: TaigaClient, identity: WorkflowIdentity = { mode: "syntactic", actor: null }, runtime?: PolicyRuntime) {
  server.tool(
    "taiga_milestones_list",
    "List milestones/sprints. Filter by project.",
    {
      project: z.number().optional().describe("Project ID"),
      closed: z.boolean().optional().describe("Filter by closed status"),
    },
    async (params) => {
      const data = await client.get(
        "/milestones",
        params as Record<string, unknown>,
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_milestones_create",
    "Create a new milestone/sprint.",
    {
      project: z.number().describe("Project ID"),
      name: z.string().describe("Sprint name"),
      estimated_start: z.string().describe("Start date (YYYY-MM-DD)"),
      estimated_finish: z.string().describe("End date (YYYY-MM-DD)"),
      disponibility: z.number().optional().describe("Available story points"),
      slug: z.string().optional(),
      order: z.number().optional(),
      watchers: z.array(z.number()).optional(),
    },
    async (params) => {
      const data = await client.post("/milestones", params);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_milestones_get",
    "Get a milestone/sprint by ID.",
    { id: z.number().describe("Milestone ID") },
    async ({ id }) => {
      const data = await client.get(`/milestones/${id}`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_milestones_update",
    "Update a milestone/sprint (partial).",
    {
      id: z.number().describe("Milestone ID"),
      name: z.string().optional(),
      estimated_start: z.string().optional(),
      estimated_finish: z.string().optional(),
      disponibility: z.number().optional(),
      closed: z.boolean().optional(),
      order: z.number().optional().describe("Sprint position; the milestone list returns ascending order"),
    },
    async ({ id, ...body }) => {
      // Closing a Sprint needs a confirmed merge, so it has exactly one door: taiga_milestones_close (after prepare and confirm).
      if (body.closed === true) return refuse("closing a Sprint goes through taiga_milestones_close (it requires a confirmed merge); nothing was changed");
      const data = await client.patch(`/milestones/${id}`, body);
      return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    },
  );

  // Sprint close is three governed phases and the Sprint stays open until the merge is confirmed:
  // prepare (signed sprint-done authorization + durable merge-ready record + merge pointer) -> confirm (GitGate's merge result) -> close.
  server.tool(
    "taiga_milestones_prepare_close",
    "Prepare a Sprint close (GPT or PO only). The Sprint STAYS OPEN: it signs the sprint-done merge authorization, stores it as the durable merge-ready record and emits the SPRINT_CLOSED merge pointer (status 'Merge ready; Sprint still open'). Nothing is final until taiga_milestones_confirm_merge and taiga_milestones_close. merge_context carries the git coordinates only.",
    {
      id: z.number().describe("Milestone ID"),
      merge_context: z.record(z.string(), z.unknown()).describe("{repository, source_branch (feature/sprint-<id>-...), target_branch, source_sha, target_sha}"),
    },
    async ({ id, merge_context }) => {
      const role = identity.actor?.role;
      if (role !== "gpt" && role !== "po") return refuse("only the GPT or the PO can prepare a Sprint close; nothing was changed");
      const problems = mergeContextProblems(merge_context, "sprint", id);
      let signer: Signer | undefined;
      try { signer = loadSigner(); } catch (e) { problems.push(`cannot issue a merge authorization: ${(e as Error).message}`); }
      const sprint = (await client.get(`/milestones/${id}`)) as Milestone;
      if (sprint.project === undefined) problems.push(`milestone ${id} has no project`);
      if (sprint.closed !== false) problems.push(`milestone ${id} is not an open Sprint`);
      const incomplete = sprint.project === undefined || sprint.closed !== false ? null : await sprintScopeProblem(client, sprint.project, id);
      if (incomplete) problems.push(incomplete);
      const existing = sprint.project === undefined ? null : await readMergeReady(client, sprint.project, id);
      if (existing) problems.push(`Sprint ${id} is already prepared (authorization ${existing.record.envelope.claims.authorization_id}); a second authorization is never issued`);
      if (problems.length || !signer || sprint.project === undefined) return refuse(`${problems.join("; ")}; nothing was changed`);
      const authorization = signMergeAuthorization(signer, merge_context as unknown as MergeContext, sprint.project, { kind: "sprint", ref: id }, `Project #${sprint.project}`);
      const managed = runtime ? await runtime.forProject(sprint.project) : null;
      const recipient = managed ? recipientOf(managed.policy, "task", "done") : "claude";
      await createMergeReady(client, sprint.project, id, { envelope: authorization, recipient });
      const notice: Notice | null = role === "gpt" && recipient ? { type: "SPRINT_CLOSED", to: recipient, sprintId: id, projectId: sprint.project, from: "gpt", status: "Merge ready; Sprint still open" } : null; // the PO is not a Bridge party
      const { notification, continuation } = await announce(notice, authorization.claims.authorization_id, process.env, authorization);
      const handoff = !authorizationTravels(notice, authorization) ? "not_attempted" : notification === "sent" ? "attempted_unconfirmed" : "failed";
      return { content: [{ type: "text" as const, text: JSON.stringify({ merge_ready: true, closed: false, notification, ...(continuation ? { continuation } : {}), merge_authorization: authorization, merge_authorization_handoff: handoff }) }] };
    },
  );

  server.tool(
    "taiga_milestones_confirm_merge",
    "Record the GitGate Sprint completion receipt (GPT, Claude or PO). The receipt is produced and Ed25519-signed by GitGate with its own key and verified here with the configured GitGate public key; it must be bound to the Sprint's signed merge-ready authorization. Nothing the caller asserts outside the signed receipt is trusted. A receipt with a branch not yet removed is stored but the Sprint is not terminal-ready; the same merge may be re-confirmed with a newer receipt to add the cleanup (never to withdraw it); an exact repeat is idempotent. A notification is never a confirmation.",
    {
      id: z.number().describe("Milestone ID"),
      receipt: z.record(z.string(), z.unknown()).describe("GitGate completion receipt: {version:1, issuer:'gitgate', key_id, authorization_id, repository, source_branch, source_sha, target_branch, target_before_sha, final_integration_sha, outcome:'merged', local_branch_removed, remote_branch_removed, signature}"),
    },
    async ({ id, receipt }) => {
      if (!identity.actor) return refuse("an authenticated actor is required; nothing was changed");
      let gitgateKey: string, taigaKey: string;
      try { gitgateKey = loadGitgateKey(); taigaKey = publicKeyB64(loadSigner()); } catch (e) { return refuse(`cannot verify the receipt: ${(e as Error).message}; nothing was changed`); }
      const sprint = (await client.get(`/milestones/${id}`)) as Milestone;
      if (sprint.project === undefined) return refuse(`milestone ${id} has no project; nothing was changed`);
      if (sprint.closed !== false) return refuse(`milestone ${id} is not an open Sprint; nothing was changed`);
      const stored = await readMergeReady(client, sprint.project, id);
      if (!stored) return refuse(`Sprint ${id} has no prepared merge authorization; nothing was changed`);
      if (!verifyMergeAuthorization(stored.record.envelope, taigaKey)) return refuse(`the stored merge authorization of Sprint ${id} does not verify; nothing was changed`);
      const claims = stored.record.envelope.claims;
      const problems = receiptProblems(receipt, claims, gitgateKey);
      const given = receipt as unknown as CompletionReceipt;
      const done = stored.record.receipt;
      if (!problems.length && done) {
        if (receiptProblems(done, claims, gitgateKey).length) problems.push(`the stored receipt of Sprint ${id} does not verify (edited or unsigned)`);
        else if (done.final_integration_sha !== given.final_integration_sha) problems.push(`Sprint ${id} is already confirmed with a different final_integration_sha`);
        else if ((done.local_branch_removed && !given.local_branch_removed) || (done.remote_branch_removed && !given.remote_branch_removed)) problems.push(`Sprint ${id} already has signed branch-removal evidence that cannot be withdrawn`);
      }
      if (problems.length) return refuse(`${problems.join("; ")}; nothing was changed`);
      // The same merge may be re-confirmed to add cleanup evidence; an exact repeat writes nothing.
      const same = done !== undefined && done.local_branch_removed === given.local_branch_removed && done.remote_branch_removed === given.remote_branch_removed;
      if (!same) await confirmMergeReady(client, sprint.project, id, stored, given);
      return { content: [{ type: "text" as const, text: JSON.stringify({ merge_confirmed: true, idempotent: same, authorization_id: claims.authorization_id, final_integration_sha: given.final_integration_sha, local_branch_removed: given.local_branch_removed, remote_branch_removed: given.remote_branch_removed, closed: false, terminal_ready: given.local_branch_removed && given.remote_branch_removed }) }] };
    },
  );

  server.tool(
    "taiga_milestones_close",
    "Close a Sprint (GPT or PO only), the terminal step: refused unless the merge was confirmed for the Sprint's prepared authorization (taiga_milestones_prepare_close, taiga_milestones_confirm_merge). Persists closed=true and re-reads it; idempotent: an already-closed Sprint succeeds only if its stored signed authorization and GitGate receipt still verify, and an unprovable re-read is reported as reconcilable (PERSISTED_OR_UNKNOWN), never as a definitive failure.",
    { id: z.number().describe("Milestone ID") },
    async ({ id }) => {
      const role = identity.actor?.role;
      if (role !== "gpt" && role !== "po") return refuse("only the GPT or the PO can close a Sprint; nothing was changed");
      const sprint = (await client.get(`/milestones/${id}`)) as Milestone;
      if (sprint.project === undefined) return refuse(`milestone ${id} has no project; nothing was changed`);
      const confirmed = (stored: NonNullable<Awaited<ReturnType<typeof readMergeReady>>>) => ({ authorization_id: stored.record.envelope.claims.authorization_id, final_integration_sha: stored.record.receipt!.final_integration_sha, outcome: "merged", local_branch_removed: true, remote_branch_removed: true });
      if (sprint.closed === true) {
        // Idempotent convergence (Issue #343): an already-closed Sprint is a success ONLY when the stored signed authorization and GitGate receipt still verify; no second PATCH.
        const unproven = await mergeConfirmationProblem(client, sprint.project, id);
        if (unproven) return refuse(`milestone ${id} is already closed but its merge provenance is not proven (${unproven}); nothing was changed`);
        return { content: [{ type: "text" as const, text: JSON.stringify({ ...sprint, idempotent: true, merge_confirmed: confirmed((await readMergeReady(client, sprint.project, id))!) }) }] };
      }
      if (sprint.closed !== false) return refuse(`milestone ${id} is not an open Sprint; nothing was changed`);
      const incomplete = await sprintScopeProblem(client, sprint.project, id);
      if (incomplete) return refuse(`${incomplete}; nothing was changed`);
      const unconfirmed = await mergeConfirmationProblem(client, sprint.project, id);
      if (unconfirmed) return refuse(`${unconfirmed}; prepare it and confirm the GitGate merge first; nothing was changed`);
      const stored = (await readMergeReady(client, sprint.project, id))!;
      const data = await client.patch(`/milestones/${id}`, { closed: true });
      const after = await client.get(`/milestones/${id}`).catch(() => null) as Milestone | null;
      // The PATCH was acknowledged but the re-read cannot prove it: the close may be durable, so this is NOT a definitive failure. Retrying converges (above).
      if (after?.closed !== true) return { content: [{ type: "text" as const, text: JSON.stringify({ code: "PERSISTED_OR_UNKNOWN", reconcilable: true, message: `the close of milestone ${id} was written but a re-read does not show it closed; it may already be persisted: call taiga_milestones_close again to reconcile (it will not write twice)` }) }], isError: true };
      return { content: [{ type: "text" as const, text: JSON.stringify({ ...(data as object), merge_confirmed: confirmed(stored) }) }] };
    },
  );

  server.tool(
    "taiga_milestones_delete",
    "Delete a milestone/sprint.",
    { id: z.number().describe("Milestone ID") },
    async ({ id }) => {
      await client.delete(`/milestones/${id}`);
      return {
        content: [{ type: "text" as const, text: "Milestone deleted." }],
      };
    },
  );

  server.tool(
    "taiga_milestones_stats",
    "Get milestone/sprint stats (burndown, etc.).",
    { id: z.number().describe("Milestone ID") },
    async ({ id }) => {
      const data = await client.get(`/milestones/${id}/stats`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_milestones_watch",
    "Watch a milestone.",
    { id: z.number().describe("Milestone ID") },
    async ({ id }) => {
      await client.post(`/milestones/${id}/watch`);
      return {
        content: [{ type: "text" as const, text: "Now watching milestone." }],
      };
    },
  );

  server.tool(
    "taiga_milestones_unwatch",
    "Stop watching a milestone.",
    { id: z.number().describe("Milestone ID") },
    async ({ id }) => {
      await client.post(`/milestones/${id}/unwatch`);
      return {
        content: [
          { type: "text" as const, text: "Stopped watching milestone." },
        ],
      };
    },
  );

  server.tool(
    "taiga_milestones_watchers",
    "List watchers of a milestone.",
    { id: z.number().describe("Milestone ID") },
    async ({ id }) => {
      const data = await client.get(`/milestones/${id}/watchers`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );
}

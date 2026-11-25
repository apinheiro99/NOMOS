import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TaigaClient } from "../client.js";
import type { WorkflowIdentity } from "./actor.js";
import { ackContinuation, ackProblem, foldContinuations, pendingContinuations } from "./continuation.js";
import { recordHandledEvidence } from "./continuation-evidence.js";
import type { PolicyRuntime } from "../policy/runtime.js";
import { reconcileContinuations } from "./continuation-recovery.js";
import { text, violation } from "./result.js";

const NOT_AUTHORITY = "A continuation is a durable pointer to work, never execution authority: re-read Taiga (taiga_task_workflow_state) before acting. Delivery ack and handled ack are different; only handled closes it.";

export function registerContinuationTools(server: McpServer, client: TaigaClient, identity: WorkflowIdentity, runtime?: PolicyRuntime): void {
  server.tool(
    "taiga_continuations_pending",
    `List the durable workflow continuations still open (pending or delivered, not handled) for the caller. GPT and Claude see only their own; the PO may pass \`actor\`. Optional \`project\` scopes it. Before listing it rebuilds any missing continuation from the authoritative Taiga state of open Sprints (same ids as normal emission, never touching existing or handled ones), so a failed ledger write is not a lost obligation. ${NOT_AUTHORITY}`,
    { project: z.number().optional().describe("Taiga project id"), actor: z.enum(["gpt", "claude"]).optional().describe("PO only: whose continuations to list") },
    async ({ project, actor }: { project?: number; actor?: "gpt" | "claude" }) => {
      const role = identity.actor?.role;
      if (!role) return violation(["authenticated actor identity is required"]);
      const who = role === "po" ? actor : role;
      if (!who) return violation(["the PO must pass `actor` (gpt or claude)"]);
      if (actor && role !== "po" && actor !== role) return violation(["only the PO can list another actor's continuations"]);
      let recovery: { recovered: number } | { error: string };
      try {
        const projects = project !== undefined ? [project] : ((await client.get("/projects")) as { id: number }[]).map((p) => p.id);
        recovery = { recovered: 0 };
        for (const p of projects) recovery.recovered += (await reconcileContinuations(client, p, (await runtime?.forProject(p))?.policy)).recovered;
      } catch (e) { recovery = { error: (e as Error).message }; } // a Taiga read problem never hides what the ledger already holds
      const items = pendingContinuations(who, project);
      return text({ actor: who, count: items.length, continuations: items, recovery, note: NOT_AUTHORITY });
    },
  );

  server.tool(
    "taiga_continuation_ack",
    `Acknowledge a continuation by id. ack=delivered records only that the consumer saw it (it stays open); ack=handled records that the consumer re-read Taiga and completed or deliberately resolved the authorized next step (it closes). Only the addressee (or the PO) can acknowledge; handled also writes one auditable, non-authoritative "Continuation Handled" marker on the card so a rebuilt ledger never resurrects it; both acks are idempotent. ${NOT_AUTHORITY}`,
    { id: z.string().describe("Continuation id from taiga_continuations_pending"), ack: z.enum(["delivered", "handled"]) },
    async ({ id, ack }: { id: string; ack: "delivered" | "handled" }) => {
      const actor = identity.actor;
      if (!actor) return violation(["authenticated actor identity is required"]);
      const c = foldContinuations().get(id);
      const problem = c ? ackProblem(c, actor.role) : `no continuation ${id}`;
      if (problem) return violation([problem]);
      // Handled is terminal and must survive the loss of the ledger: Taiga gets the auditable marker FIRST; if that fails nothing is acknowledged.
      if (ack === "handled") {
        try { await recordHandledEvidence(client, c!, actor.role); } catch (e) { return violation([`the handled evidence could not be written to Taiga (${(e as Error).message}); nothing was acknowledged, retry the ack`]); }
      }
      const r = ackContinuation(id, ack, actor.display, actor.role);
      return r.ok ? text({ id, state: r.state, already: r.already }) : violation([r.reason]);
    },
  );
}

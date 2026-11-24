import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { TaigaClient } from "../client.js";
import { backfillSprintAssignees } from "./assignment.js";
import { text } from "./result.js";

export function registerAssignmentTools(server: McpServer, client: TaigaClient): void {
  server.tool(
    "taiga_assignees_backfill",
    "Repair Assigned on the open Tasks and Stories of ONE Sprint. The target owner is derived only from each card's current status through the canonical resolver (never from watchers, creator or the current assignee); only assigned_to is written, so status, order, history and watchers are untouched. Done/Cancelled and ownerless statuses are skipped. Idempotent. dry_run (default true) reports what would change without writing. Needs the Assigned projection configured (TAIGA_MCP_EXPECTED_ACCOUNT_<ROLE>).",
    { milestone: z.number().describe("Sprint/Milestone ID"), dry_run: z.boolean().optional().describe("Default true: report only") },
    async ({ milestone, dry_run }) => text(await backfillSprintAssignees(client, milestone, dry_run ?? true)),
  );
}

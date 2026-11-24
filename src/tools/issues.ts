import { z } from "zod";
import { withUuid } from "../identity.js";
import { createdWithOwner } from "../workflow/assignment.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TaigaClient } from "../client.js";

export function registerIssueTools(server: McpServer, client: TaigaClient) {
  server.tool(
    "taiga_issues_list",
    "List issues with optional filters.",
    {
      project: z.number().optional().describe("Project ID"),
      status: z.number().optional(),
      severity: z.number().optional(),
      priority: z.number().optional(),
      owner: z.number().optional(),
      assigned_to: z.number().optional(),
      tags: z.string().optional().describe("Comma-separated tags"),
      type: z.number().optional().describe("Issue type ID"),
      role: z.number().optional(),
      watchers: z.number().optional(),
      status__is_closed: z.boolean().optional(),
      exclude_status: z.number().optional(),
      exclude_severity: z.number().optional(),
      exclude_priority: z.number().optional(),
      exclude_tags: z.string().optional(),
      exclude_assigned_to: z.number().optional(),
      exclude_role: z.number().optional(),
      exclude_owner: z.number().optional(),
      exclude_type: z.number().optional(),
      order_by: z
        .string()
        .optional()
        .describe("Order field (e.g. 'severity', 'priority', 'status')"),
    },
    async (params) => {
      const data = await client.get(
        "/issues",
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
    "taiga_issues_create",
    "Create a new issue.",
    {
      project: z.number().describe("Project ID"),
      subject: z.string().describe("Issue subject"),
      description: z.string().optional(),
      assigned_to: z.number().optional(),
      blocked_note: z.string().optional(),
      is_blocked: z.boolean().optional(),
      is_closed: z.boolean().optional(),
      milestone: z.number().optional(),
      priority: z.number().optional(),
      severity: z.number().optional(),
      status: z.number().optional(),
      type: z.number().optional(),
      tags: z.array(z.string()).optional(),
      watchers: z.array(z.number()).optional(),
    },
    async (params) => {
      const data = await withUuid(client, "issue", await client.post("/issues", params));
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_issues_get",
    "Get an issue by ID.",
    { id: z.number().describe("Issue ID") },
    async ({ id }) => {
      const data = await client.get(`/issues/${id}`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_issues_get_by_ref",
    "Get an issue by ref and project.",
    {
      ref: z.number().describe("Issue ref number"),
      project: z.number().describe("Project ID"),
    },
    async (params) => {
      const data = await client.get(
        "/issues/by_ref",
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
    "taiga_issues_update",
    "Update an issue (partial). milestone only assigns a Sprint (a number); to return an Issue to the Backlog use taiga_issue_move_to_backlog.",
    {
      id: z.number().describe("Issue ID"),
      subject: z.string().optional(),
      description: z.string().optional(),
      assigned_to: z.number().optional(),
      status: z.number().optional(),
      priority: z.number().optional(),
      severity: z.number().optional(),
      type: z.number().optional(),
      milestone: z.number().optional(),
      tags: z.array(z.string()).optional(),
      is_blocked: z.boolean().optional(),
      blocked_note: z.string().optional(),
      is_closed: z.boolean().optional(),
      version: z.number().describe("Current version for conflict check"),
    },
    async ({ id, ...body }) => {
      const data = await client.patch(`/issues/${id}`, body);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  // Sprint -> Backlog for Issues: taiga_issues_update only accepts a numeric milestone, so it cannot clear one.
  server.tool(
    "taiga_issue_move_to_backlog",
    "Return an existing Issue from its Sprint to the Backlog in one call (Sprint assignment is the milestone; an Issue with no milestone is not in a Sprint). Reads the Issue, clears the milestone with its current version, rereads and fails closed unless milestone is null and id/ref/status/subject are unchanged. Everything else on the Issue is untouched. An Issue already without a Sprint is a no-op with zero writes. A stale version or API error is never retried: after a failed PATCH the Issue is reread once, and if the milestone is already null (the write committed but the response failed) the call continues as a verified success with reconciled:true; otherwise it is an explicit failure.",
    { id: z.number().describe("Issue ID (not the ref)") },
    async ({ id }) => {
      const reply = (body: Record<string, unknown>, isError = false) => ({
        ...(isError ? { isError: true as const } : {}),
        content: [{ type: "text" as const, text: JSON.stringify(body) }],
      });
      const fail = (code: string, e: unknown) =>
        reply({ moved: false, code, message: e instanceof Error ? e.message : "unknown error" }, true);
      type Issue = { id: number; ref: number; subject: string; milestone: number | null; status: number; version: number };
      const summary = (i: Issue) => ({ id: i.id, ref: i.ref, subject: i.subject, status: i.status, milestone: i.milestone });

      let before: Issue;
      try {
        before = (await client.get(`/issues/${id}`)) as Issue;
      } catch (e) {
        return fail("read_failed", e);
      }
      if (before.milestone == null) {
        return reply({ moved: false, noop: "already_in_backlog", issue: summary(before) });
      }

      let after: Issue | undefined;
      let reconciled = false;
      try {
        await client.patch(`/issues/${id}`, { milestone: null, version: before.version });
      } catch (e) {
        // A transport/API error after the write is ambiguous (e.g. 502 after Taiga committed). Reread once, never rewrite.
        try {
          after = (await client.get(`/issues/${id}`)) as Issue;
        } catch (re) {
          return fail("move_failed", new Error(`${e instanceof Error ? e.message : "unknown error"}; reconciliation reread failed: ${re instanceof Error ? re.message : "unknown error"}`));
        }
        if (after.milestone != null) return fail("move_failed", e);
        reconciled = true;
      }
      try {
        if (!after) after = (await client.get(`/issues/${id}`)) as Issue;
      } catch (e) {
        return fail("move_failed", e);
      }
      if (after.milestone != null) {
        return reply({ moved: false, code: "not_verified", message: "Issue still has a milestone after the update.", before: summary(before), after: summary(after) }, true);
      }
      const intact = after.status === before.status && after.id === before.id && after.ref === before.ref && after.subject === before.subject;
      return reply({ moved: true, verified: intact, reconciled, before: summary(before), after: summary(after) }, !intact);
    },
  );

  server.tool(
    "taiga_issues_delete",
    "Delete an issue.",
    { id: z.number().describe("Issue ID") },
    async ({ id }) => {
      await client.delete(`/issues/${id}`);
      return { content: [{ type: "text" as const, text: "Issue deleted." }] };
    },
  );

  server.tool(
    "taiga_issues_promote_to_userstory",
    "Promote an issue to a user story in a project (Taiga promote action). Returns the generated story, which keeps generated_from_issue/origin_issue pointing at the issue.",
    {
      id: z.number().describe("Issue ID"),
      project_id: z.number().describe("Project ID that receives the generated user story"),
    },
    async ({ id, project_id }) => {
      // Verified live (project 48): Taiga answers 200 with the list of generated story REFS, not story objects.
      const story = await createdWithOwner(client, "userstory", { project: project_id }, async () => {
        const refs = (await client.post(`/issues/${id}/promote_to_user_story`, { project_id })) as number[];
        return client.get("/userstories/by_ref", { ref: refs[0], project: project_id }) as Promise<never>;
      });
      return { content: [{ type: "text" as const, text: JSON.stringify(await withUuid(client, "userstory", story)) }] };
    },
  );

  server.tool(
    "taiga_issues_bulk_create",
    "Bulk create issues.",
    {
      project_id: z.number().describe("Project ID"),
      bulk_issues: z.string().describe("Newline-separated issue subjects"),
    },
    async (params) => {
      const data = await withUuid(client, "issue", await client.post("/issues/bulk_create", params));
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_issues_filters_data",
    "Get filters data for issues in a project.",
    { project: z.number().describe("Project ID") },
    async (params) => {
      const data = await client.get(
        "/issues/filters_data",
        params as Record<string, unknown>,
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  // Voting
  server.tool(
    "taiga_issues_upvote",
    "Upvote an issue.",
    { id: z.number().describe("Issue ID") },
    async ({ id }) => {
      await client.post(`/issues/${id}/upvote`);
      return { content: [{ type: "text" as const, text: "Issue upvoted." }] };
    },
  );

  server.tool(
    "taiga_issues_downvote",
    "Remove vote from an issue.",
    { id: z.number().describe("Issue ID") },
    async ({ id }) => {
      await client.post(`/issues/${id}/downvote`);
      return { content: [{ type: "text" as const, text: "Vote removed." }] };
    },
  );

  server.tool(
    "taiga_issues_voters",
    "List voters of an issue.",
    { id: z.number().describe("Issue ID") },
    async ({ id }) => {
      const data = await client.get(`/issues/${id}/voters`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  // Watching
  server.tool(
    "taiga_issues_watch",
    "Watch an issue.",
    { id: z.number().describe("Issue ID") },
    async ({ id }) => {
      await client.post(`/issues/${id}/watch`);
      return {
        content: [{ type: "text" as const, text: "Now watching issue." }],
      };
    },
  );

  server.tool(
    "taiga_issues_unwatch",
    "Stop watching an issue.",
    { id: z.number().describe("Issue ID") },
    async ({ id }) => {
      await client.post(`/issues/${id}/unwatch`);
      return {
        content: [{ type: "text" as const, text: "Stopped watching issue." }],
      };
    },
  );

  server.tool(
    "taiga_issues_watchers",
    "List watchers of an issue.",
    { id: z.number().describe("Issue ID") },
    async ({ id }) => {
      const data = await client.get(`/issues/${id}/watchers`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  // Attachments
  server.tool(
    "taiga_issues_attachments_list",
    "List attachments of an issue.",
    {
      project: z.number().describe("Project ID"),
      object_id: z.number().describe("Issue ID"),
    },
    async (params) => {
      const data = await client.get(
        "/issues/attachments",
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
    "taiga_issues_attachment_get",
    "Get a specific issue attachment.",
    { id: z.number().describe("Attachment ID") },
    async ({ id }) => {
      const data = await client.get(`/issues/attachments/${id}`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );
}

import { z } from "zod";
import { withUuid } from "../identity.js";
import { createdWithOwner } from "../workflow/assignment.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TaigaClient } from "../client.js";

export function registerUserStoryTools(server: McpServer, client: TaigaClient) {
  server.tool(
    "taiga_userstories_list",
    "List user stories with optional filters.",
    {
      project: z.number().optional().describe("Project ID"),
      milestone: z.number().optional().describe("Milestone/Sprint ID"),
      milestone__isnull: z
        .boolean()
        .optional()
        .describe("True for backlog stories"),
      status: z.number().optional().describe("Status ID"),
      status__is_archived: z.boolean().optional(),
      tags: z.string().optional().describe("Comma-separated tags"),
      watchers: z.number().optional().describe("Watcher user ID"),
      assigned_to: z.number().optional().describe("Assigned user ID"),
      epic: z.number().optional().describe("Epic ID"),
      role: z.number().optional().describe("Role ID"),
      status__is_closed: z.boolean().optional(),
      exclude_status: z.number().optional(),
      exclude_tags: z.string().optional(),
      exclude_assigned_to: z.number().optional(),
      exclude_role: z.number().optional(),
      order_by: z.string().optional().describe("Order field"),
    },
    async (params) => {
      const data = await client.get(
        "/userstories",
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
    "taiga_userstories_create",
    "Create a new user story.",
    {
      project: z.number().describe("Project ID"),
      subject: z.string().describe("User story subject"),
      description: z.string().optional(),
      assigned_to: z.number().optional(),
      assigned_users: z.array(z.number()).optional(),
      blocked_note: z.string().optional(),
      client_requirement: z.boolean().optional(),
      is_blocked: z.boolean().optional(),
      is_closed: z.boolean().optional(),
      milestone: z.number().optional().describe("Sprint/Milestone ID"),
      points: z
        .record(z.string(), z.number())
        .optional()
        .describe("Points per role {role_id: points}"),
      sprint_order: z.number().optional(),
      status: z.number().optional().describe("Status ID"),
      tags: z.array(z.string()).optional(),
      team_requirement: z.boolean().optional(),
      watchers: z.array(z.number()).optional(),
    },
    async (params) => {
      const data = await withUuid(client, "userstory", await createdWithOwner(client, "userstory", { project: params.project, status: params.status }, () => client.post("/userstories", params) as Promise<never>));
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_userstories_get",
    "Get a user story by ID.",
    { id: z.number().describe("User Story ID") },
    async ({ id }) => {
      const data = await client.get(`/userstories/${id}`, {
        include_tasks: true,
      });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_userstories_get_by_ref",
    "Get a user story by ref and project.",
    {
      ref: z.number().describe("User story ref number"),
      project: z.number().describe("Project ID"),
    },
    async (params) => {
      const data = await client.get(
        "/userstories/by_ref",
        { ...params, include_tasks: true } as Record<string, unknown>,
      );
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_userstories_update",
    "Update a user story (partial). milestone only assigns a Sprint (a number); to return a Story to the Backlog use taiga_userstory_move_to_backlog.",
    {
      id: z.number().describe("User Story ID"),
      subject: z.string().optional(),
      description: z.string().optional(),
      assigned_to: z.number().optional(),
      assigned_users: z.array(z.number()).optional(),
      status: z.number().optional(),
      milestone: z.number().optional(),
      sprint_order: z.number().optional(),
      points: z.record(z.string(), z.number()).optional(),
      tags: z.array(z.string()).optional(),
      is_blocked: z.boolean().optional(),
      blocked_note: z.string().optional(),
      is_closed: z.boolean().optional(),
      version: z.number().describe("Current version for conflict check"),
    },
    async ({ id, ...body }) => {
      const data = await client.patch(`/userstories/${id}`, body);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  // Sprint -> Backlog: the supported way to clear a Story's Sprint. taiga_userstories_update only accepts a
  // numeric milestone and taiga_move(story_in_sprint) only reorders inside a Sprint.
  server.tool(
    "taiga_userstory_move_to_backlog",
    "Return an existing User Story from its Sprint to the Backlog in one call (Sprint assignment is the milestone; a Story with no milestone is in the Backlog). Reads the Story, clears the milestone with its current version, rereads and fails closed unless milestone is null, and keeps a valid backlog_order (assigns the end of the Backlog only if it has none). Story id/ref/status/content/history and child Tasks are untouched (no delete/recreate). A Story already in the Backlog is a no-op with zero writes. A stale version or API error is never retried: after a failed PATCH the Story is reread once, and if the milestone is already null (the write committed but the response failed) the call continues as a verified success with reconciled:true; otherwise it is an explicit failure.",
    { id: z.number().describe("User Story ID (not the ref)") },
    async ({ id }) => {
      const reply = (body: Record<string, unknown>, isError = false) => ({
        ...(isError ? { isError: true as const } : {}),
        content: [{ type: "text" as const, text: JSON.stringify(body) }],
      });
      const fail = (code: string, e: unknown) =>
        reply({ moved: false, code, message: e instanceof Error ? e.message : "unknown error" }, true);
      type Story = { id: number; ref: number; project: number; milestone: number | null; status: number; version: number; backlog_order?: number | null };
      const readStory = () => client.getKeeping(["backlog_order"], `/userstories/${id}`);
      const taskIds = async () =>
        ((await client.get("/tasks", { user_story: id })) as { id: number }[]).map((t) => t.id).sort((a, b) => a - b);

      let before: Story;
      let tasksBefore: number[];
      try {
        before = (await readStory()) as Story;
        tasksBefore = await taskIds();
      } catch (e) {
        return fail("read_failed", e);
      }
      const summary = (s: Story) => ({ id: s.id, ref: s.ref, status: s.status, milestone: s.milestone });
      if (before.milestone == null) {
        return reply({ moved: false, noop: "already_in_backlog", story: summary(before), tasks: tasksBefore });
      }

      let after!: Story;
      let reconciled = false;
      try {
        await client.patch(`/userstories/${id}`, { milestone: null, version: before.version });
      } catch (e) {
        // A transport/API error after the write is ambiguous (e.g. 502 after Taiga committed). Reread once, never rewrite.
        try {
          after = (await readStory()) as Story;
        } catch (re) {
          const msg = `${e instanceof Error ? e.message : "unknown error"}; reconciliation reread failed: ${re instanceof Error ? re.message : "unknown error"}`;
          return fail("move_failed", new Error(msg));
        }
        if (after.milestone != null) return fail("move_failed", e);
        reconciled = true;
      }
      try {
        if (!reconciled) after = (await readStory()) as Story;
      } catch (e) {
        return fail("move_failed", e);
      }
      if (after.milestone != null) {
        return reply({ moved: false, code: "not_verified", message: "Story still has a milestone after the update.", before: summary(before), after: summary(after) }, true);
      }

      let orderAssigned = false;
      if (typeof after.backlog_order !== "number" || !Number.isFinite(after.backlog_order)) {
        try {
          const backlog = (await client.getKeeping(["backlog_order"], "/userstories", { project: after.project, milestone__isnull: true })) as { backlog_order?: number | null }[];
          const max = Math.max(0, ...backlog.map((s) => (typeof s.backlog_order === "number" ? s.backlog_order : 0)));
          await client.patch(`/userstories/${id}`, { backlog_order: max + 1, version: after.version });
          after = (await readStory()) as Story;
          orderAssigned = true;
        } catch (e) {
          return fail("backlog_order_failed", e);
        }
        if (after.milestone != null || typeof after.backlog_order !== "number") {
          return reply({ moved: false, code: "not_verified", message: "Backlog state not valid after assigning backlog_order.", after: summary(after) }, true);
        }
      }

      let tasksAfter: number[];
      try {
        tasksAfter = await taskIds();
      } catch (e) {
        return fail("verify_tasks_failed", e);
      }
      const tasksIntact = tasksAfter.join() === tasksBefore.join();
      const intact = tasksIntact && after.status === before.status && after.id === before.id && after.ref === before.ref;
      return reply(
        { moved: true, verified: intact, reconciled, backlog_order_assigned: orderAssigned, before: summary(before), after: summary(after), tasks_before: tasksBefore, tasks_after: tasksAfter },
        !intact,
      );
    },
  );

  server.tool(
    "taiga_userstories_delete",
    "Delete a user story.",
    { id: z.number().describe("User Story ID") },
    async ({ id }) => {
      await client.delete(`/userstories/${id}`);
      return {
        content: [{ type: "text" as const, text: "User story deleted." }],
      };
    },
  );

  server.tool(
    "taiga_userstories_bulk_create",
    "Bulk create user stories.",
    {
      project_id: z.number().describe("Project ID"),
      bulk_stories: z
        .string()
        .describe("Newline-separated user story subjects"),
      status_id: z.number().optional(),
    },
    async (params) => {
      const data = await withUuid(client, "userstory", await createdWithOwner(client, "userstory", { project: params.project_id, status: params.status_id }, () => client.post("/userstories/bulk_create", params) as Promise<never>));
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_userstories_bulk_update_sprint_order",
    "Bulk update sprint order of user stories.",
    {
      project_id: z.number().describe("Project ID"),
      bulk_stories: z
        .array(z.array(z.number()))
        .describe("Array of [us_id, order] pairs"),
    },
    // This Taiga deployment answers 405 to the bulk endpoint, so reorder one Story at a time
    // with the accepted PATCH, in the given order, sending only sprint_order and a fresh version.
    async ({ bulk_stories }) => {
      const updated: unknown[] = [];
      for (const [id, sprint_order] of bulk_stories) {
        const current = (await client.get(`/userstories/${id}`)) as { version: number };
        updated.push(
          await client.patch(`/userstories/${id}`, {
            sprint_order,
            version: current.version,
          }),
        );
      }
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(updated) },
        ],
      };
    },
  );

  server.tool(
    "taiga_userstories_filters_data",
    "Get filters data for user stories in a project.",
    { project: z.number().describe("Project ID") },
    async (params) => {
      const data = await client.get(
        "/userstories/filters_data",
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
    "taiga_userstories_upvote",
    "Upvote a user story.",
    { id: z.number().describe("User Story ID") },
    async ({ id }) => {
      await client.post(`/userstories/${id}/upvote`);
      return {
        content: [{ type: "text" as const, text: "User story upvoted." }],
      };
    },
  );

  server.tool(
    "taiga_userstories_downvote",
    "Remove vote from a user story.",
    { id: z.number().describe("User Story ID") },
    async ({ id }) => {
      await client.post(`/userstories/${id}/downvote`);
      return { content: [{ type: "text" as const, text: "Vote removed." }] };
    },
  );

  server.tool(
    "taiga_userstories_voters",
    "List voters of a user story.",
    { id: z.number().describe("User Story ID") },
    async ({ id }) => {
      const data = await client.get(`/userstories/${id}/voters`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  // Watching
  server.tool(
    "taiga_userstories_watch",
    "Watch a user story.",
    { id: z.number().describe("User Story ID") },
    async ({ id }) => {
      await client.post(`/userstories/${id}/watch`);
      return {
        content: [{ type: "text" as const, text: "Now watching user story." }],
      };
    },
  );

  server.tool(
    "taiga_userstories_unwatch",
    "Stop watching a user story.",
    { id: z.number().describe("User Story ID") },
    async ({ id }) => {
      await client.post(`/userstories/${id}/unwatch`);
      return {
        content: [
          { type: "text" as const, text: "Stopped watching user story." },
        ],
      };
    },
  );

  server.tool(
    "taiga_userstories_watchers",
    "List watchers of a user story.",
    { id: z.number().describe("User Story ID") },
    async ({ id }) => {
      const data = await client.get(`/userstories/${id}/watchers`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  // Attachments
  server.tool(
    "taiga_userstories_attachments_list",
    "List attachments of a user story.",
    {
      project: z.number().describe("Project ID"),
      object_id: z.number().describe("User Story ID"),
    },
    async (params) => {
      const data = await client.get(
        "/userstories/attachments",
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
    "taiga_userstories_attachment_get",
    "Get a specific user story attachment.",
    { id: z.number().describe("Attachment ID") },
    async ({ id }) => {
      const data = await client.get(`/userstories/attachments/${id}`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );
}

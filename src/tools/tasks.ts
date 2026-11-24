import { z } from "zod";
import { withUuid } from "../identity.js";
import { createdWithOwner } from "../workflow/assignment.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TaigaClient } from "../client.js";

/** The one gate for Task creation: this project does not use storyless Tasks, so nothing is created without a User Story. */
const storylessRefused = {
  isError: true,
  content: [{ type: "text" as const, text: "refused: a Task must belong to a User Story (user_story / us_id is required). Storyless Tasks are not allowed in this workflow." }],
};

export function registerTaskTools(server: McpServer, client: TaigaClient) {
  server.tool(
    "taiga_tasks_list",
    "List tasks with optional filters.",
    {
      project: z.number().optional().describe("Project ID"),
      status: z.number().optional().describe("Status ID"),
      tags: z.string().optional().describe("Comma-separated tags"),
      user_story: z.number().optional().describe("User Story ID"),
      role: z.number().optional().describe("Role ID"),
      owner: z.number().optional().describe("Owner user ID"),
      milestone: z.number().optional().describe("Milestone ID"),
      watchers: z.number().optional().describe("Watcher user ID"),
      assigned_to: z.number().optional().describe("Assigned user ID"),
      status__is_closed: z.boolean().optional(),
      exclude_status: z.number().optional(),
      exclude_tags: z.string().optional(),
      exclude_assigned_to: z.number().optional(),
      exclude_role: z.number().optional(),
      exclude_owner: z.number().optional(),
      order_by: z.string().optional(),
    },
    async (params) => {
      const data = await client.get(
        "/tasks",
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
    "taiga_tasks_create",
    "Create a new task. user_story is required: a Task without a User Story is refused. A task linked to a user_story always belongs to that story's Sprint; milestone is honoured only for standalone tasks (no user_story).",
    {
      project: z.number().describe("Project ID"),
      subject: z.string().describe("Task subject"),
      description: z.string().optional(),
      assigned_to: z.number().optional(),
      blocked_note: z.string().optional(),
      is_blocked: z.boolean().optional(),
      is_closed: z.boolean().optional(),
      is_iocaine: z.boolean().optional(),
      milestone: z.number().optional().describe("Sprint ID, standalone tasks only. With user_story the Sprint is inherited from the story: a different value is rejected"),
      status: z.number().optional(),
      user_story: z.number().optional().describe("User Story ID, required"),
      tags: z.array(z.string()).optional(),
      watchers: z.array(z.number()).optional(),
    },
    async (params) => {
      if (params.user_story === undefined) return storylessRefused;
      // Taiga ignores a milestone that differs from the parent story's (live probe, Issue #67): refuse instead of lying.
      if (params.user_story !== undefined && params.milestone !== undefined) {
        const story = (await client.get(`/userstories/${params.user_story}`)) as { milestone?: number | null };
        if ((story.milestone ?? null) !== params.milestone) {
          return {
            isError: true,
            content: [{ type: "text" as const, text: `milestone ${params.milestone} conflicts with user story ${params.user_story} (milestone ${story.milestone ?? "none"}): a linked task inherits the story's Sprint. Update the story's milestone first, or omit milestone.` }],
          };
        }
      }
      const data = await withUuid(client, "task", await createdWithOwner(client, "task", { project: params.project, status: params.status }, () => client.post("/tasks", params) as Promise<never>));
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_tasks_get",
    "Get a task by ID.",
    { id: z.number().describe("Task ID") },
    async ({ id }) => {
      const data = await client.get(`/tasks/${id}`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_tasks_get_by_ref",
    "Get a task by ref and project.",
    {
      ref: z.number().describe("Task ref number"),
      project: z.number().describe("Project ID"),
    },
    async (params) => {
      const data = await client.get(
        "/tasks/by_ref",
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
    "taiga_tasks_update",
    "Update a task (partial).",
    {
      id: z.number().describe("Task ID"),
      subject: z.string().optional(),
      description: z.string().optional(),
      assigned_to: z.number().optional(),
      status: z.number().optional(),
      milestone: z.number().optional().describe("Sprint ID, standalone tasks only. A task linked to a user story inherits the story's Sprint: a different value is rejected"),
      user_story: z.number().optional(),
      tags: z.array(z.string()).optional(),
      is_blocked: z.boolean().optional(),
      blocked_note: z.string().optional(),
      is_closed: z.boolean().optional(),
      is_iocaine: z.boolean().optional(),
      taskboard_order: z.number().optional().describe("Position in the taskboard column"),
      version: z.number().describe("Current version for conflict check"),
    },
    async ({ id, ...body }) => {
      // Same contract as create (Issue #67, #190): Taiga silently ignores a milestone that differs from the linked story's.
      if (body.milestone !== undefined) {
        const storyId = body.user_story ?? ((await client.get(`/tasks/${id}`)) as { user_story?: number | null }).user_story;
        if (storyId != null) {
          const story = (await client.get(`/userstories/${storyId}`)) as { milestone?: number | null };
          if ((story.milestone ?? null) !== body.milestone) {
            return {
              isError: true,
              content: [{ type: "text" as const, text: `milestone ${body.milestone} conflicts with user story ${storyId} (milestone ${story.milestone ?? "none"}): a linked task inherits the story's Sprint. Update the story's milestone first, or omit milestone.` }],
            };
          }
        }
      }
      const data = await client.patch(`/tasks/${id}`, body);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_tasks_delete",
    "Delete a task.",
    { id: z.number().describe("Task ID") },
    async ({ id }) => {
      await client.delete(`/tasks/${id}`);
      return { content: [{ type: "text" as const, text: "Task deleted." }] };
    },
  );

  // This Taiga deployment rejects [[id, order]] pairs with 400 and wants [{task_id, order}] objects,
  // so the pairs the other bulk-order tools take are converted here, keeping the caller's sequence.
  const bulkTaskOrder = (name: string, endpoint: string, description: string, extra: z.ZodRawShape) => {
    server.tool(
      name,
      description,
      {
        project_id: z.number().describe("Project ID"),
        bulk_tasks: z.array(z.array(z.number())).describe("Array of [task_id, order] pairs"),
        user_story_id: z.number().optional().describe("User Story ID"),
        ...extra,
      },
      async ({ bulk_tasks, ...rest }: { bulk_tasks: number[][] } & Record<string, unknown>) => {
        const data = await client.post(`/tasks/${endpoint}`, {
          ...rest,
          bulk_tasks: bulk_tasks.map(([task_id, order]) => ({ task_id, order })),
        });
        return { content: [{ type: "text" as const, text: JSON.stringify(data) }] };
      },
    );
  };
  bulkTaskOrder(
    "taiga_tasks_bulk_update_taskboard_order",
    "bulk_update_taskboard_order",
    "Bulk update the order of tasks in the taskboard (taskboard_order).",
    { status_id: z.number().optional(), milestone_id: z.number().optional() },
  );

  server.tool(
    "taiga_tasks_bulk_create",
    "Bulk create tasks. us_id is required: Tasks without a User Story are refused.",
    {
      project_id: z.number().describe("Project ID"),
      bulk_tasks: z.string().describe("Newline-separated task subjects"),
      us_id: z.number().optional().describe("User Story ID, required"),
      sprint_id: z.number().optional().describe("Sprint/Milestone ID"),
      status_id: z.number().optional(),
    },
    async (params) => {
      if (params.us_id === undefined) return storylessRefused;
      const data = await withUuid(client, "task", await createdWithOwner(client, "task", { project: params.project_id, status: params.status_id }, () => client.post("/tasks/bulk_create", params) as Promise<never>));
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_tasks_filters_data",
    "Get filters data for tasks in a project.",
    { project: z.number().describe("Project ID") },
    async (params) => {
      const data = await client.get(
        "/tasks/filters_data",
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
    "taiga_tasks_upvote",
    "Upvote a task.",
    { id: z.number().describe("Task ID") },
    async ({ id }) => {
      await client.post(`/tasks/${id}/upvote`);
      return { content: [{ type: "text" as const, text: "Task upvoted." }] };
    },
  );

  server.tool(
    "taiga_tasks_downvote",
    "Remove vote from a task.",
    { id: z.number().describe("Task ID") },
    async ({ id }) => {
      await client.post(`/tasks/${id}/downvote`);
      return { content: [{ type: "text" as const, text: "Vote removed." }] };
    },
  );

  server.tool(
    "taiga_tasks_voters",
    "List voters of a task.",
    { id: z.number().describe("Task ID") },
    async ({ id }) => {
      const data = await client.get(`/tasks/${id}/voters`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  // Watching
  server.tool(
    "taiga_tasks_watch",
    "Watch a task.",
    { id: z.number().describe("Task ID") },
    async ({ id }) => {
      await client.post(`/tasks/${id}/watch`);
      return {
        content: [{ type: "text" as const, text: "Now watching task." }],
      };
    },
  );

  server.tool(
    "taiga_tasks_unwatch",
    "Stop watching a task.",
    { id: z.number().describe("Task ID") },
    async ({ id }) => {
      await client.post(`/tasks/${id}/unwatch`);
      return {
        content: [{ type: "text" as const, text: "Stopped watching task." }],
      };
    },
  );

  server.tool(
    "taiga_tasks_watchers",
    "List watchers of a task.",
    { id: z.number().describe("Task ID") },
    async ({ id }) => {
      const data = await client.get(`/tasks/${id}/watchers`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  // Attachments
  server.tool(
    "taiga_tasks_attachments_list",
    "List attachments of a task.",
    {
      project: z.number().describe("Project ID"),
      object_id: z.number().describe("Task ID"),
    },
    async (params) => {
      const data = await client.get(
        "/tasks/attachments",
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
    "taiga_tasks_attachment_get",
    "Get a specific task attachment.",
    { id: z.number().describe("Attachment ID") },
    async ({ id }) => {
      const data = await client.get(`/tasks/attachments/${id}`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );
}

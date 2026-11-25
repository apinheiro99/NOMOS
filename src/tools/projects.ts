import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TaigaClient } from "../client.js";
import { prepareProject } from "../project-profile.js";
import { inspect } from "../policy/mirror.js";
import type { PolicyRuntime } from "../policy/runtime.js";
import type { WorkflowIdentity } from "../workflow/actor.js";
import { policyHash } from "../policy/service.js";

export function registerProjectTools(server: McpServer, client: TaigaClient, identity: WorkflowIdentity = { mode: "syntactic", actor: null }, runtime?: PolicyRuntime) {
  server.tool(
    "taiga_projects_list",
    "List projects. Optionally filter by member, is_featured, etc.",
    {
      member: z.number().optional().describe("Filter by member user ID"),
      is_looking_for_people: z.boolean().optional(),
      is_featured: z.boolean().optional(),
      is_backlog_activated: z.boolean().optional(),
      is_kanban_activated: z.boolean().optional(),
      order_by: z.string().optional().describe("Order field"),
    },
    async (params) => {
      const data = await client.get(
        "/projects",
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
    "taiga_projects_create",
    "Create a new project.",
    {
      name: z.string().describe("Project name"),
      description: z.string().optional(),
      is_backlog_activated: z.boolean().optional(),
      is_issues_activated: z.boolean().optional(),
      is_kanban_activated: z.boolean().optional(),
      is_wiki_activated: z.boolean().optional(),
      is_epics_activated: z.boolean().optional(),
      is_contact_activated: z.boolean().optional(),
      is_private: z.boolean().optional(),
      total_milestones: z.number().optional(),
      total_story_points: z.number().optional(),
      request_key: z.string().min(8).max(100).optional().describe("Idempotency key for a policy-engine MCP: a retry with the same key and the same request returns the same project instead of creating another"),
      apply_profile: z.boolean().optional().describe("Default true: right after creation, bring the project to the canonical SCOPE profile (statuses, colours, types, priorities, severities) and make it UUID-ready. Set false for a raw Taiga default project."),
    },
    async ({ apply_profile, request_key, ...params }) => {
      // The SCOPE profile projects are born with every module on (Epics, Kanban, Wiki, Contact); an explicit flag still wins.
      const modules = apply_profile === false ? {} : { is_epics_activated: true, is_kanban_activated: true, is_wiki_activated: true, is_contact_activated: true };
      const make = async () => {
        const data = (await client.post("/projects", { ...modules, ...params })) as { id?: number; slug?: string; name?: string };
        if (apply_profile === false || typeof data?.id !== "number") return { data, prepared: undefined };
        // The project exists either way: a profile failure is reported, never thrown, and repaired by taiga_project_apply_profile.
        try { return { data, prepared: await prepareProject(client, data.id, { dryRun: false }) as unknown }; }
        catch (e) { return { data, prepared: { error: e instanceof Error ? e.message : String(e), note: "Project WAS created; run taiga_project_apply_profile (dry_run=false) to finish." } as unknown }; }
      };
      const text = (body: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(body) }] });
      if (runtime) {
        // A project born under the policy engine is bound (and gets its first policy) before it is reported; the intent is recorded first.
        let made: Awaited<ReturnType<typeof make>> | undefined;
        const out = await runtime.provision(
          { principal: identity.actor?.role ?? "unauthenticated", requestKey: request_key ?? `auto-${Date.now()}-${Math.random().toString(36).slice(2)}`, requestHash: policyHash({ apply_profile, ...params } as never) },
          async () => {
            made = await make();
            const row = made.data as { id: number; slug: string; name: string };
            return { id: row.id, slug: row.slug, name: row.name, seen: await inspect(client, row) };
          },
        );
        return text(made ? { ...made.data, ...(made.prepared ? { profile_result: made.prepared } : {}), provisioned: true } : { id: out.id, replay: out.replay, provisioned: true });
      }
      const { data, prepared } = await make();
      return text(prepared ? { ...data, profile_result: prepared } : data);
    },
  );

  server.tool(
    "taiga_project_apply_profile",
    "Check (dry_run=true, default) or fix (dry_run=false) a project against the canonical SCOPE profile: workflow statuses, colours, issue types, priorities, severities, epic statuses, the project default status of new Stories/Tasks/Issues/Epics (Ready, To Do, New, Proposed; existing cards never move), plus UUID readiness. Idempotent. The result is exactly the profile (no extras). A value outside the profile that still holds cards is never touched: the call FAILS with the blockers (value, card counts, how to fix) and writes nothing until they are resolved.",
    {
      project: z.number().describe("Project ID"),
      dry_run: z.boolean().optional().describe("Default true: only report what would change"),
      remap: z.record(z.string(), z.record(z.string(), z.string())).optional().describe('Explicit way out of a blocker: {"epic-statuses": {"In progress": "Active"}} moves the cards on the old value to the profile value, then deletes the old value'),
    },
    async ({ project, dry_run, remap }) => {
      const data = await prepareProject(client, project, { dryRun: dry_run !== false, remap });
      // A blocked or failed profile is an error, not a quiet report: the caller must see what to fix.
      return { isError: !data.ok, content: [{ type: "text" as const, text: JSON.stringify(data) }] };
    },
  );

  server.tool(
    "taiga_projects_get",
    "Get a project by its ID.",
    { id: z.number().describe("Project ID") },
    async ({ id }) => {
      const data = await client.get(`/projects/${id}`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_projects_get_by_slug",
    "Get a project by its slug.",
    { slug: z.string().describe("Project slug") },
    async ({ slug }) => {
      const data = await client.get("/projects/by_slug", { slug });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_projects_update",
    "Update a project (partial update).",
    {
      id: z.number().describe("Project ID"),
      name: z.string().optional(),
      description: z.string().optional(),
      is_backlog_activated: z.boolean().optional(),
      is_issues_activated: z.boolean().optional(),
      is_kanban_activated: z.boolean().optional(),
      is_wiki_activated: z.boolean().optional(),
      is_epics_activated: z.boolean().optional(),
      is_contact_activated: z.boolean().optional(),
      is_private: z.boolean().optional(),
    },
    async ({ id, ...body }) => {
      const data = await client.patch(`/projects/${id}`, body);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_projects_delete",
    "Delete a project by its ID.",
    { id: z.number().describe("Project ID") },
    async ({ id }) => {
      await client.delete(`/projects/${id}`);
      return {
        content: [
          { type: "text" as const, text: "Project deleted successfully." },
        ],
      };
    },
  );

  server.tool(
    "taiga_projects_stats",
    "Get project stats.",
    { id: z.number().describe("Project ID") },
    async ({ id }) => {
      const data = await client.get(`/projects/${id}/stats`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_projects_member_stats",
    "Get project member stats.",
    { id: z.number().describe("Project ID") },
    async ({ id }) => {
      const data = await client.get(`/projects/${id}/member_stats`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_projects_issues_stats",
    "Get project issues stats.",
    { id: z.number().describe("Project ID") },
    async ({ id }) => {
      const data = await client.get(`/projects/${id}/issues_stats`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_projects_create_tag",
    "Create a tag in a project.",
    {
      id: z.number().describe("Project ID"),
      tag: z.string().describe("Tag name"),
      color: z.string().optional().describe("HEX color"),
    },
    async ({ id, ...body }) => {
      const data = await client.post(`/projects/${id}/create_tag`, body);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_projects_edit_tag",
    "Edit a tag in a project.",
    {
      id: z.number().describe("Project ID"),
      from_tag: z.string().describe("Current tag name"),
      to_tag: z.string().optional().describe("New tag name"),
      color: z.string().optional().describe("New HEX color"),
    },
    async ({ id, ...body }) => {
      const data = await client.post(`/projects/${id}/edit_tag`, body);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_projects_delete_tag",
    "Delete a tag from a project.",
    {
      id: z.number().describe("Project ID"),
      tag: z.string().describe("Tag name"),
    },
    async ({ id, ...body }) => {
      const data = await client.post(`/projects/${id}/delete_tag`, body);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_projects_like",
    "Like a project.",
    { id: z.number().describe("Project ID") },
    async ({ id }) => {
      await client.post(`/projects/${id}/like`);
      return { content: [{ type: "text" as const, text: "Project liked." }] };
    },
  );

  server.tool(
    "taiga_projects_unlike",
    "Unlike a project.",
    { id: z.number().describe("Project ID") },
    async ({ id }) => {
      await client.post(`/projects/${id}/unlike`);
      return { content: [{ type: "text" as const, text: "Project unliked." }] };
    },
  );

  server.tool(
    "taiga_projects_fans",
    "List fans of a project.",
    { id: z.number().describe("Project ID") },
    async ({ id }) => {
      const data = await client.get(`/projects/${id}/fans`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    "taiga_projects_watch",
    "Watch a project.",
    {
      id: z.number().describe("Project ID"),
      notify_level: z.number().optional().describe("1=all, 2=involved, 3=none"),
    },
    async ({ id, ...body }) => {
      await client.post(`/projects/${id}/watch`, body);
      return {
        content: [{ type: "text" as const, text: "Now watching project." }],
      };
    },
  );

  server.tool(
    "taiga_projects_unwatch",
    "Stop watching a project.",
    { id: z.number().describe("Project ID") },
    async ({ id }) => {
      await client.post(`/projects/${id}/unwatch`);
      return {
        content: [{ type: "text" as const, text: "Stopped watching project." }],
      };
    },
  );

  server.tool(
    "taiga_projects_watchers",
    "List watchers of a project.",
    { id: z.number().describe("Project ID") },
    async ({ id }) => {
      const data = await client.get(`/projects/${id}/watchers`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );
}

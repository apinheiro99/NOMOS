import { prepareProject } from "../project-profile.js";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TaigaClient } from "../client.js";
import { isReservedName, initializeProject, resolveUuid, isUuidDefinition, guardUuidValues, type IdentityKind } from "../identity.js";

const refuse = (what: string) => ({ isError: true, content: [{ type: "text" as const, text: `The UUID custom attribute is MCP-owned and write-once: ${what} is refused.` }] });

function registerCustomAttributeResource(
  server: McpServer,
  client: TaigaClient,
  entityType: IdentityKind,
  endpoint: string,
  valuesEndpoint: string,
) {
  // Definitions
  server.tool(
    `taiga_${entityType}_custom_attributes_list`,
    `List custom attribute definitions for ${entityType}. Filter by project.`,
    { project: z.number().optional().describe("Project ID") },
    async (params) => {
      const data = await client.get(
        `/${endpoint}`,
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
    `taiga_${entityType}_custom_attributes_create`,
    `Create a custom attribute definition for ${entityType}.`,
    {
      project: z.number().describe("Project ID"),
      name: z.string().describe("Attribute name"),
      description: z.string().optional(),
      order: z.number().optional(),
      type: z
        .string()
        .optional()
        .describe(
          "Attribute type (text, multiline, richtext, date, url, dropdown, checkbox, number)",
        ),
    },
    async (params) => {
      if (isReservedName((params as { name?: string }).name)) return refuse(`creating a custom attribute named "${(params as { name?: string }).name}" (the name is reserved for the identity subsystem; use taiga_uuid_initialize_project)`);
      const data = await client.post(`/${endpoint}`, params);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    `taiga_${entityType}_custom_attributes_get`,
    `Get a custom attribute definition for ${entityType}.`,
    { id: z.number().describe("Custom attribute ID") },
    async ({ id }) => {
      const data = await client.get(`/${endpoint}/${id}`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    `taiga_${entityType}_custom_attributes_update`,
    `Update a custom attribute definition for ${entityType}.`,
    {
      id: z.number().describe("Custom attribute ID"),
      name: z.string().optional(),
      description: z.string().optional(),
      order: z.number().optional(),
      type: z.string().optional(),
    },
    async ({ id, ...body }) => {
      if (await isUuidDefinition(client, entityType, id)) return refuse("changing its definition");
      if (isReservedName(body.name)) return refuse("renaming another attribute to the reserved name");
      const data = await client.patch(`/${endpoint}/${id}`, body);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    `taiga_${entityType}_custom_attributes_delete`,
    `Delete a custom attribute definition for ${entityType}.`,
    { id: z.number().describe("Custom attribute ID") },
    async ({ id }) => {
      if (await isUuidDefinition(client, entityType, id)) return refuse("deleting its definition");
      await client.delete(`/${endpoint}/${id}`);
      return {
        content: [{ type: "text" as const, text: "Custom attribute deleted." }],
      };
    },
  );

  // Values
  server.tool(
    `taiga_${entityType}_custom_attributes_values_get`,
    `Get custom attribute values for a specific ${entityType}.`,
    { id: z.number().describe(`${entityType} ID`) },
    async ({ id }) => {
      const data = await client.get(`/${valuesEndpoint}/${id}`);
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );

  server.tool(
    `taiga_${entityType}_custom_attributes_values_update`,
    `Update custom attribute values for a specific ${entityType}.`,
    {
      id: z.number().describe(`${entityType} ID`),
      attributes_values: z
        .record(z.string(), z.string())
        .describe("Map of attribute_id -> value"),
      version: z.number().describe("Current version for conflict check"),
    },
    async ({ id, ...body }) => {
      const guarded = await guardUuidValues(client, entityType, id, body.attributes_values);
      if ("refuse" in guarded) return refuse(guarded.refuse);
      const data = await client.patch(`/${valuesEndpoint}/${id}`, { ...body, attributes_values: guarded.values });
      return {
        content: [
          { type: "text" as const, text: JSON.stringify(data) },
        ],
      };
    },
  );
}

export function registerCustomAttributeTools(
  server: McpServer,
  client: TaigaClient,
) {
  registerCustomAttributeResource(
    server,
    client,
    "epic",
    "epic-custom-attributes",
    "epics/custom-attributes-values",
  );
  registerCustomAttributeResource(
    server,
    client,
    "userstory",
    "userstory-custom-attributes",
    "userstories/custom-attributes-values",
  );
  registerCustomAttributeResource(
    server,
    client,
    "task",
    "task-custom-attributes",
    "tasks/custom-attributes-values",
  );
  registerCustomAttributeResource(
    server,
    client,
    "issue",
    "issue-custom-attributes",
    "issues/custom-attributes-values",
  );

  const kindsShape = z.array(z.enum(["task", "userstory", "epic", "issue"])).optional();
  const initialize = async ({ project, entities, dry_run }: { project: number; entities?: IdentityKind[]; dry_run?: boolean }) => {
    const report = await initializeProject(client, project, { dryRun: dry_run, kinds: entities });
    return { content: [{ type: "text" as const, text: JSON.stringify(report) }] };
  };
  server.tool(
    "taiga_uuid_initialize_project",
    "Make a project UUID-ready AND bring it to the canonical SCOPE profile (same as taiga_project_apply_profile; a blocked profile writes nothing). For Task, User Story, Epic and Issue, define the `UUID` custom attribute where it is missing and give every entity without one a UUIDv7 (MCP-generated). Valid UUIDv7 values are never changed; invalid existing values are only reported, never overwritten. Writes only the UUID attribute. Always covers all four kinds. Dry run by default (reports what would be created/assigned). Idempotent. The result says `uuid_ready: true|false` for the whole project; a duplicated `UUID` definition is reported as an integrity error and nothing is written for that kind. Sprint/Milestone are not covered (Taiga has no custom attributes for them).",
    { project: z.number().describe("Project ID"), dry_run: z.boolean().optional().describe("Default true. Pass false to write.") },
    async ({ project, dry_run }: { project: number; dry_run?: boolean }) => {
      // Making a project UUID-ready also brings it to the canonical SCOPE profile (statuses, colours, types, priorities, severities).
      const r = await prepareProject(client, project, { dryRun: dry_run !== false });
      return { isError: !r.ok, content: [{ type: "text" as const, text: JSON.stringify({ ...(r.uuid ?? {}), profile: r.profile }) }] };
    },
  );
  server.tool(
    "taiga_uuid_backfill",
    "DEPRECATED UUID-only variant of taiga_uuid_initialize_project (does NOT apply the profile). `entities` selects a subset; a partial result is never `uuid_ready` for the project (`partial: true`, `selected_kinds_ready`). Use taiga_uuid_initialize_project.",
    { project: z.number().describe("Project ID"), entities: kindsShape, dry_run: z.boolean().optional().describe("Default true. Pass false to write.") },
    initialize,
  );

  server.tool(
    "taiga_uuid_resolve",
    "Resolve a persistent entity UUID (UUIDv7) to its Task, User Story, Epic or Issue: type, project, internal id, human ref and subject. The UUID is the authoritative identity; #ref is only a convenience. Zero matches = not_found; more than one = duplicate (closed failure, all matches listed, none chosen). Taiga cannot filter by custom attribute, so this scans the given project (or every visible project): pass `project` when known.",
    {
      uuid: z.string().describe("The UUID to resolve"),
      project: z.number().optional().describe("Limit the scan to one project (recommended)"),
      entities: z.array(z.enum(["task", "userstory", "epic", "issue"])).optional(),
    },
    async ({ uuid, project, entities }) => {
      const r = await resolveUuid(client, uuid, { project, kinds: entities });
      return { isError: r.status !== "found", content: [{ type: "text" as const, text: JSON.stringify(r) }] };
    },
  );
}

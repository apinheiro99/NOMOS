import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TaigaClient } from "../client.js";
import { postComment } from "../comment.js";
import type { WorkflowIdentity } from "../workflow/actor.js";

export function registerHistoryTools(server: McpServer, client: TaigaClient, identity: WorkflowIdentity = { mode: "syntactic", actor: null }) {
  // History for each entity type
  const entityTypes = ["userstory", "task", "issue", "wiki"] as const;

  for (const entityType of entityTypes) {
    server.tool(
      `taiga_${entityType}_history`,
      `Get change history for a ${entityType}.`,
      { id: z.number().describe(`${entityType} ID`) },
      async ({ id }) => {
        const data = await client.get(`/history/${entityType}/${id}`);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(data) },
          ],
        };
      },
    );

    // Comments (create via history endpoint)
    server.tool(
      `taiga_${entityType}_comment_create`,
      `Add a comment to a ${entityType}. Comment is posted via the history endpoint.`,
      {
        id: z.number().describe(`${entityType} ID`),
        comment: z.string().describe("Comment text (without a signature: the MCP appends `-- <author>`)"),
        author: identity.actor
          ? z.string().optional().describe("Ignored: the signature comes from the authenticated actor")
          : z.string().describe("Required. Who is writing this comment, e.g. \"Andre\", \"GPT (GPT-6)\", \"Claude (Sonnet 5.5)\". Appended as the last line."),
      },
      async ({ id, comment, author }) => {
        const data = await postComment(client, entityType, id, comment, (identity.actor?.display ?? author) as string);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(data) },
          ],
        };
      },
    );

    server.tool(
      `taiga_${entityType}_comment_delete`,
      `Delete a comment from a ${entityType}.`,
      {
        id: z.number().describe(`${entityType} ID`),
        comment_id: z.string().describe("Comment ID (from history)"),
      },
      async ({ id, comment_id }) => {
        // Taiga takes the comment id as a query parameter, not in the body (the body form answers 404).
        await client.post(`/history/${entityType}/${id}/delete_comment?id=${encodeURIComponent(comment_id)}`);
        return {
          content: [{ type: "text" as const, text: "Comment deleted." }],
        };
      },
    );
  }
}

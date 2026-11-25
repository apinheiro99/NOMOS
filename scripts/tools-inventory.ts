// Prints the runtime tool inventory (name, entity, mutating, params, required) as JSON; F3 builds the policy catalog from it.
// Mutation is derived from the name; an unrecognised verb counts as mutating (fail-closed), so the list is reviewed, never trusted.
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTaigaMcpServer } from "../dist/server.js";

const READ_VERBS = new Set([
  "get", "list", "ref", "history", "stats", "fans", "voters", "watchers", "watched", "voted", "liked",
  "contacts", "me", "data", "search", "slug", "template", "state", "pending", "status", "resolve",
  "epic", "issue", "milestone", "project", "task", "user", "userstory", "wiki",
]);
// Parameters every tool accepts (added by the server for all of them): not part of what a tool is about.
const COMMON = new Set(["fields", "compact", "author", "model", "effort"]);
const READ_EXCEPTIONS = new Set(["taiga_governance_status", "taiga_timeline_profile"]);
// Reviewed by hand: the last word of these names looks like a read verb, but the tool writes to Taiga.
const WRITE_EXCEPTIONS = new Set(["taiga_human_decision_resolve", "taiga_issues_promote_to_userstory", "taiga_uuid_initialize_project"]);

export async function toolInventory() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "inventory", version: "1" });
  await Promise.all([createTaigaMcpServer({} as never).connect(a), client.connect(b)]);
  const { tools } = await client.listTools();

  const inventory = tools
    .map(({ name, inputSchema }) => {
      const parts = name.replace(/^taiga_/, "").split("_");
      const isRead = !WRITE_EXCEPTIONS.has(name) && (READ_EXCEPTIONS.has(name) || READ_VERBS.has(parts[parts.length - 1]));
      return { name, entity: parts[0], mutating: !isRead, params: Object.keys((inputSchema as { properties?: object }).properties ?? {}).filter((k) => !COMMON.has(k)).sort(), required: ((inputSchema as { required?: string[] }).required ?? []).filter((k) => !COMMON.has(k)).sort() };
    })
    .sort((x, y) => x.name.localeCompare(y.name));

  return inventory;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await toolInventory(), null, 2));

// Prints the runtime tool inventory (name, entity, mutating) as JSON; F3 builds the policy catalog from it.
// Mutation is derived from the name; an unrecognised verb counts as mutating (fail-closed), so the list is reviewed, never trusted.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTaigaMcpServer } from "../dist/server.js";

const READ_VERBS = new Set([
  "get", "list", "ref", "history", "stats", "fans", "voters", "watchers", "watched", "voted", "liked",
  "contacts", "me", "data", "search", "slug", "template", "state", "pending", "status", "resolve",
  "epic", "issue", "milestone", "project", "task", "user", "userstory", "wiki",
]);
const READ_EXCEPTIONS = new Set(["taiga_governance_status", "taiga_timeline_profile"]);

const [a, b] = InMemoryTransport.createLinkedPair();
const client = new Client({ name: "inventory", version: "1" });
await Promise.all([createTaigaMcpServer({} as never).connect(a), client.connect(b)]);
const { tools } = await client.listTools();

const inventory = tools
  .map(({ name }) => {
    const parts = name.replace(/^taiga_/, "").split("_");
    const isRead = READ_EXCEPTIONS.has(name) || READ_VERBS.has(parts[parts.length - 1]);
    return { name, entity: parts[0], mutating: !isRead };
  })
  .sort((x, y) => x.name.localeCompare(y.name));

console.log(JSON.stringify(inventory, null, 2));

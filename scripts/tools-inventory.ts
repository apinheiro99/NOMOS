// Prints the runtime tool inventory (name, entity, mutating, params, required) as JSON; F3 builds the policy catalog from it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTaigaMcpServer } from "../dist/server.js";

// Whether a tool writes is decided by a person, never by its name: scripts/tool-access.json lists every tool as read or write, and a tool that is in
// neither list stops the inventory until someone classifies it.
const ACCESS = JSON.parse(readFileSync(fileURLToPath(new URL("./tool-access.json", import.meta.url)), "utf8")) as { read: string[]; write: string[] };
// Parameters every tool accepts (added by the server for all of them): not part of what a tool is about.
const COMMON = new Set(["fields", "compact", "author", "model", "effort"]);

export async function toolInventory() {
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "inventory", version: "1" });
  await Promise.all([createTaigaMcpServer({} as never).connect(a), client.connect(b)]);
  const { tools } = await client.listTools();

  const inventory = tools
    .map(({ name, inputSchema }) => {
      const parts = name.replace(/^taiga_/, "").split("_");
      const isRead = ACCESS.read.includes(name);
      if (!isRead && !ACCESS.write.includes(name)) throw new Error(`${name} is not classified: add it to scripts/tool-access.json as read or write`);
      return { name, entity: parts[0], mutating: !isRead, params: Object.keys((inputSchema as { properties?: object }).properties ?? {}).filter((k) => !COMMON.has(k)).sort(), required: ((inputSchema as { required?: string[] }).required ?? []).filter((k) => !COMMON.has(k)).sort() };
    })
    .sort((x, y) => x.name.localeCompare(y.name));

  return inventory;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) console.log(JSON.stringify(await toolInventory(), null, 2));

import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTaigaMcpServer } from "../dist/server.js";

const sorted = (tools) => [...tools].sort((a, b) => a.name.localeCompare(b.name));

async function viaFactory() {
  const server = createTaigaMcpServer({});
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "t", version: "1" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  await client.close();
  return sorted(tools);
}

async function viaStdio() {
  const transport = new StdioClientTransport({
    command: "node",
    args: [new URL("../dist/index.js", import.meta.url).pathname],
    env: { ...process.env, TAIGA_URL: "http://127.0.0.1:1", TAIGA_USERNAME: "x", TAIGA_PASSWORD: "x" },
  });
  const client = new Client({ name: "t", version: "1" });
  await client.connect(transport);
  const { tools } = await client.listTools();
  await client.close();
  return sorted(tools);
}

test("factory builds the full 257-tool catalog without a transport", async () => {
  assert.equal((await viaFactory()).length, 257);
});

test("STDIO startup exposes exactly the factory catalog (names, schemas, descriptions)", async () => {
  assert.equal(JSON.stringify(await viaStdio()), JSON.stringify(await viaFactory()));
});

test("each factory call yields an independent server", () => {
  assert.notEqual(createTaigaMcpServer({}), createTaigaMcpServer({}));
});

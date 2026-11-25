import { test } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startHttpServer } from "../dist/http.js";
import { loadActorConfig } from "../dist/workflow/actor.js";
import { loadActorClients, verifyActorAccounts } from "../dist/workflow/actor-clients.js";

// F2.4: the resident process serves GPT, Claude and the PO with one Taiga account each.
const TOKENS = { TAIGA_MCP_GPT_TOKEN: "g".repeat(20), TAIGA_MCP_CLAUDE_TOKEN: "c".repeat(20), TAIGA_MCP_PO_TOKEN: "p".repeat(20) };
const ACCOUNTS = { TAIGA_URL: "http://taiga.invalid", TAIGA_USERNAME_GPT: "gpt-bot", TAIGA_PASSWORD_GPT: "x", TAIGA_USERNAME_CLAUDE: "claude-bot", TAIGA_PASSWORD_CLAUDE: "x", TAIGA_USERNAME_PO: "andre", TAIGA_PASSWORD_PO: "x" };

test("every actor with a token gets its own client, and a missing account stops the start", () => {
  const actors = loadActorConfig(TOKENS);
  const clients = loadActorClients(actors, ACCOUNTS);
  assert.deepEqual([...clients.keys()].sort(), ["claude", "gpt", "po"]);
  assert.equal(new Set(clients.values()).size, 3);
  assert.throws(() => loadActorClients(actors, { ...ACCOUNTS, TAIGA_USERNAME_CLAUDE: "" }), /TAIGA_USERNAME_CLAUDE/);
});

test("an actor without a token needs no account", () => {
  const actors = loadActorConfig({ TAIGA_MCP_GPT_TOKEN: TOKENS.TAIGA_MCP_GPT_TOKEN });
  assert.deepEqual([...loadActorClients(actors, { TAIGA_URL: "http://t", TAIGA_USERNAME_GPT: "a", TAIGA_PASSWORD_GPT: "b" }).keys()], ["gpt"]);
});

test("each account is checked against the one the configuration expects for that role", async () => {
  const fake = (username: string) => ({ authenticatedUsername: async () => username }) as never;
  const clients = new Map([["gpt", fake("gpt-bot")], ["claude", fake("claude-bot")]]) as never;
  await verifyActorAccounts(clients, { TAIGA_MCP_EXPECTED_ACCOUNT_GPT: "gpt-bot", TAIGA_MCP_EXPECTED_ACCOUNT_CLAUDE: "claude-bot" });
  await assert.rejects(verifyActorAccounts(clients, { TAIGA_MCP_EXPECTED_ACCOUNT_GPT: "gpt-bot", TAIGA_MCP_EXPECTED_ACCOUNT_CLAUDE: "somebody-else" }), /claude actor is bound to Taiga account "somebody-else"/);
});

test("a call is served with the client of the actor whose token it carries", async () => {
  const used: string[] = [];
  const spy = (name: string) => ({ get: async () => { used.push(name); return { id: 1, username: name }; } }) as never;
  const clients = new Map([["gpt", spy("gpt")], ["claude", spy("claude")], ["po", spy("po")]]) as never;
  const server = await startHttpServer({ host: "127.0.0.1", port: 0, path: "/mcp" }, clients, loadActorConfig(TOKENS));
  try {
    const url = new URL(`http://127.0.0.1:${(server.address() as { port: number }).port}/mcp`);
    for (const [role, token] of [["claude", TOKENS.TAIGA_MCP_CLAUDE_TOKEN], ["gpt", TOKENS.TAIGA_MCP_GPT_TOKEN], ["po", TOKENS.TAIGA_MCP_PO_TOKEN]]) {
      const c = new Client({ name: "t", version: "1" });
      await c.connect(new StreamableHTTPClientTransport(url, { requestInit: { headers: { authorization: `Bearer ${token}` } } }));
      await c.callTool({ name: "taiga_users_me", arguments: {} });
      await c.close();
      assert.equal(used.at(-1), role);
    }
    assert.deepEqual(used, ["claude", "gpt", "po"]);
  } finally {
    server.close();
  }
});

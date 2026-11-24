import { test } from "node:test";
import assert from "node:assert/strict";
import { TaigaClient } from "../dist/client.js";
import { actorFor } from "../dist/workflow/actor.js";
import { accountBindingProblem, bindingRejection } from "../dist/workflow/account-binding.js";

const bound = { TAIGA_MCP_EXPECTED_ACCOUNT_GPT: "chatgpt", TAIGA_MCP_EXPECTED_ACCOUNT_CLAUDE: "claudecode", TAIGA_MCP_EXPECTED_ACCOUNT_PO: "andre" };
const as = (username: string) => ({ authenticatedUsername: async () => username }) as unknown as TaigaClient;

test("each role matches only its own configured Taiga account", async () => {
  assert.equal(await accountBindingProblem(as("chatgpt"), actorFor("gpt"), bound), null);
  assert.equal(await accountBindingProblem(as("claudecode"), actorFor("claude"), bound), null);
  assert.equal(await accountBindingProblem(as("andre"), actorFor("po"), bound), null);
});

test("an actor running under another account fails closed, with no credential in the message", async () => {
  const problem = await accountBindingProblem(as("andre"), actorFor("claude"), bound);
  assert.match(problem!, /claude actor is bound to Taiga account "claudecode" but this process authenticated as "andre"/);
  Object.assign(process.env, bound);
  try {
    const rejected = await bindingRejection(as("andre"), actorFor("gpt"), { actor: "gpt" });
    assert.equal(JSON.parse(rejected!.content[0].text).code, "WORKFLOW_IDENTITY_MISMATCH");
  } finally { for (const k of Object.keys(bound)) delete process.env[k]; }
});

test("binding on but the actor's account not configured fails closed", async () => {
  const problem = await accountBindingProblem(as("chatgpt"), actorFor("claude"), { TAIGA_MCP_EXPECTED_ACCOUNT_GPT: "chatgpt" });
  assert.match(problem!, /TAIGA_MCP_EXPECTED_ACCOUNT_CLAUDE is not configured/);
});

test("nothing configured leaves the binding off (legacy behaviour)", async () => {
  assert.equal(await accountBindingProblem(as("anyone"), actorFor("claude"), {}), null);
});

test("the client reads users/me once per login and re-reads after a new login", async () => {
  const real = globalThis.fetch;
  const saved = { u: process.env.TAIGA_URL, n: process.env.TAIGA_USERNAME, p: process.env.TAIGA_PASSWORD };
  Object.assign(process.env, { TAIGA_URL: "http://t.test", TAIGA_USERNAME: "u", TAIGA_PASSWORD: "p" });
  const calls: string[] = [];
  let logins = 0;
  globalThis.fetch = (async (url: string) => {
    const path = new URL(String(url)).pathname.replace(/^.*\/api\/v1/, "");
    calls.push(path);
    if (path === "/auth") { logins++; return new Response(JSON.stringify({ auth_token: "t" })); }
    return new Response(JSON.stringify({ username: logins === 1 ? "chatgpt" : "claudecode" }));
  }) as typeof fetch;
  try {
    const client = new TaigaClient();
    assert.equal(await client.authenticatedUsername(), "chatgpt");
    assert.equal(await client.authenticatedUsername(), "chatgpt");
    assert.equal(calls.filter((c) => c === "/users/me").length, 1, "cached within one login");
    (client as unknown as { authToken: null }).authToken = null;
    await client.get("/projects");
    assert.equal(await client.authenticatedUsername(), "claudecode", "re-verified after a new login");
  } finally {
    globalThis.fetch = real;
    for (const [k, v] of [["TAIGA_URL", saved.u], ["TAIGA_USERNAME", saved.n], ["TAIGA_PASSWORD", saved.p]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  }
});

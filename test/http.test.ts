import { request as httpRequest } from "node:http";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseTransportConfig } from "../dist/config.js";
import { startHttpServer } from "../dist/http.js";
import { createTaigaMcpServer } from "../dist/server.js";

const wire = (tools) => JSON.stringify([...tools].sort((a, b) => a.name.localeCompare(b.name)));

test("default config is STDIO; no env needed", () => {
  assert.deepEqual(parseTransportConfig({}), { transport: "stdio" });
  assert.deepEqual(parseTransportConfig({ TAIGA_MCP_TRANSPORT: "stdio" }), { transport: "stdio" });
});

test("http defaults to loopback, port 8787, path /mcp", () => {
  assert.deepEqual(parseTransportConfig({ TAIGA_MCP_TRANSPORT: "http" }), { transport: "http", host: "127.0.0.1", port: 8787, path: "/mcp", allowedOrigins: [] });
  for (const h of ["localhost", "::1"]) assert.equal(parseTransportConfig({ TAIGA_MCP_TRANSPORT: "http", TAIGA_MCP_HTTP_HOST: h }).host, h);
});

test("non-loopback bind needs the explicit opt-in", () => {
  const env = { TAIGA_MCP_TRANSPORT: "http", TAIGA_MCP_HTTP_HOST: "0.0.0.0" };
  assert.throws(() => parseTransportConfig(env), /non-loopback/);
  assert.equal(parseTransportConfig({ ...env, TAIGA_MCP_HTTP_ALLOW_NON_LOOPBACK: "1" }).host, "0.0.0.0");
});

test("rejects unknown transport, bad port, bad path", () => {
  assert.throws(() => parseTransportConfig({ TAIGA_MCP_TRANSPORT: "sse" }), /Unsupported/);
  for (const p of ["abc", "-1", "70000", "1.5"]) assert.throws(() => parseTransportConfig({ TAIGA_MCP_TRANSPORT: "http", TAIGA_MCP_HTTP_PORT: p }), /PORT/);
  assert.throws(() => parseTransportConfig({ TAIGA_MCP_TRANSPORT: "http", TAIGA_MCP_HTTP_PATH: "mcp" }), /PATH/);
});

const http = await startHttpServer({ host: "127.0.0.1", port: 0, path: "/mcp" }, {});
const base = `http://127.0.0.1:${http.address().port}`;
after(() => http.close());

async function connect() {
  const client = new Client({ name: "t", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
  return client;
}

test("HTTP initialize + tools/list equals the factory catalog; fields/compact visible", async () => {
  const client = await connect();
  const { tools } = await client.listTools();
  await client.close();
  assert.equal(tools.length, 257);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const ref = new Client({ name: "r", version: "1" });
  await Promise.all([createTaigaMcpServer({}).connect(a), ref.connect(b)]);
  assert.equal(wire(tools), wire((await ref.listTools()).tools));
  await ref.close();
  const get = tools.find((t) => t.name === "taiga_tasks_get");
  assert.ok("fields" in get.inputSchema.properties && "compact" in get.inputSchema.properties);
  const upd = tools.find((t) => t.name === "taiga_tasks_update");
  assert.ok("fields" in upd.inputSchema.properties && "compact" in upd.inputSchema.properties);
});

test("lifecycle: concurrent clients work, wrong path 404, GET/DELETE 405, bind is loopback", async () => {
  const [c1, c2] = await Promise.all([connect(), connect()]);
  const [r1, r2] = await Promise.all([c1.listTools(), c2.listTools()]);
  assert.equal(r1.tools.length, r2.tools.length);
  await Promise.all([c1.close(), c2.close()]);
  assert.equal((await fetch(`${base}/nope`, { method: "POST" })).status, 404);
  for (const m of ["GET", "DELETE"]) {
    const r = await fetch(`${base}/mcp`, { method: m });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get("allow"), "POST");
  }
  assert.equal(http.address().address, "127.0.0.1");
});

const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "c", version: "1" } } };
const post = (headers) => fetch(`${base}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers }, body: JSON.stringify(init) });

test("Origin matrix: none works, loopback works, foreign/malformed 403 before dispatch", async () => {
  assert.equal((await post({})).status, 200);
  for (const o of ["http://localhost:3000", "http://127.0.0.1:9", "http://[::1]:5173"]) assert.equal((await post({ origin: o })).status, 200, o);
  for (const o of ["https://evil.example", "http://localhost.evil.example", "null", "not a url"]) assert.equal((await post({ origin: o })).status, 403, o);
});

test("foreign Origin is rejected on every method, even a wrong one, and listed origins pass", async () => {
  for (const m of ["GET", "DELETE"]) assert.equal((await fetch(`${base}/mcp`, { method: m, headers: { origin: "https://evil.example" } })).status, 403);
  const listed = await startHttpServer({ host: "127.0.0.1", port: 0, path: "/mcp", allowedOrigins: ["https://app.example"] }, {});
  try {
    const r = await fetch(`http://127.0.0.1:${listed.address().port}/mcp`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", origin: "https://app.example" }, body: JSON.stringify(init) });
    assert.equal(r.status, 200);
  } finally { listed.close(); }
});

test("Host header guard on loopback binds", async () => {
  const status = (host) => new Promise((resolve, reject) => {
    const r = httpRequest({ host: "127.0.0.1", port: http.address().port, path: "/mcp", method: "POST", headers: { host, "content-type": "application/json", accept: "application/json, text/event-stream" } }, (res) => { res.resume(); resolve(res.statusCode); });
    r.on("error", reject);
    r.end(JSON.stringify(init));
  });
  assert.equal(await status("evil.example"), 403);
  assert.equal(await status("localhost:8787"), 200);
});

test("allowed origins config is parsed", () => {
  const c = parseTransportConfig({ TAIGA_MCP_TRANSPORT: "http", TAIGA_MCP_HTTP_ALLOWED_ORIGINS: " https://a.example , https://b.example," });
  assert.deepEqual(c.allowedOrigins, ["https://a.example", "https://b.example"]);
});

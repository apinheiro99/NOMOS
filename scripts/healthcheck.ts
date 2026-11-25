// Checks the running process through its private admin API (the PO token authenticates it) and fails unless it reports ok.
//   node scripts/healthcheck.ts [--wait]     --wait retries for ~20 s, so a unit can use it as the "started" gate
// Reads TAIGA_MCP_ADMIN_URL (default http://127.0.0.1:8788) and TAIGA_MCP_PO_TOKEN.
const base = process.env.TAIGA_MCP_ADMIN_URL ?? "http://127.0.0.1:8788";
const token = process.env.TAIGA_MCP_PO_TOKEN;
if (!token) {
  console.error("healthcheck: TAIGA_MCP_PO_TOKEN is not set");
  process.exit(1);
}

async function once(): Promise<string | null> {
  try {
    const res = await fetch(`${base}/admin/api/v1/health`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) });
    const body = (await res.json()) as { status?: string; schema?: string | null; build?: string | null };
    if (res.status === 200 && body.status === "ok") {
      console.log(`healthcheck: ok (schema ${body.schema ?? "none"}, build ${body.build ?? "unset"})`);
      return null;
    }
    return `HTTP ${res.status} ${JSON.stringify(body)}`;
  } catch (e) {
    return (e as Error).message;
  }
}

const attempts = process.argv.includes("--wait") ? 10 : 1;
let problem: string | null = "no attempt";
for (let i = 0; i < attempts && problem !== null; i++) {
  if (i > 0) await new Promise((r) => setTimeout(r, 2000));
  problem = await once();
}
if (problem !== null) {
  console.error(`healthcheck: failed: ${problem}`);
  process.exit(1);
}

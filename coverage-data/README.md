# Raw coverage evidence (Task #262) — data only, no classification

Collected by Claude for the GPT, who owns the matrix, statuses, gap Issues and the final document.

- `root-routes.json`: `node scripts/taiga-rest.ts get /` — the deployed Taiga API root (DRF router listing) on 2026-11-07: 83 registered route keys. This is the deployment-specific route inventory source.
- `deployed-route-probes.json`: one read-only `GET` per route key through the sanctioned helper (regex keys with a sample id 1; plain keys with and without `?project=49`). Fields: `router_key`, `request`, `observed` (`ok` or the HTTP status), `shape` (top-level keys / array item keys). Only GET was used, so methods other than GET are NOT evidenced here; a 404/405/403 on a GET is an observation, not a verdict.
- `mcp-tools.json`: all 254 registered tools from `createTaigaMcpServer().listTools()` of this commit (authenticated actor gpt, governance default): name, description (governed tools carry their governance note), input keys, required keys, full input schema.

No sandbox-project-49 write probes were made. No route was classified.

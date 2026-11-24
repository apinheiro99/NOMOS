# Getting Started

## Prerequisites

- A running [Taiga](https://taiga.io) instance and one Taiga account per actor (`po`, `claude`, `gpt`)
- Node.js 24+ and [pnpm](https://pnpm.io)
- An MCP-compatible client (Claude Code, ChatGPT through a tunnel, Claude Desktop, ...)

## Install from source

```bash
git clone <your-repository-url> taiga-mcp
cd taiga-mcp
pnpm install --frozen-lockfile
pnpm run build
cp .env.example .env     # fill in your own values; never commit .env
```

## Register in an MCP client

One server entry per actor. The actor is fixed by the process environment, never by the model.

```json
{
  "mcpServers": {
    "taiga": {
      "command": "node",
      "args": ["/absolute/path/to/taiga-mcp/dist/index.js"],
      "env": {
        "TAIGA_URL": "https://taiga.example.com",
        "TAIGA_USERNAME": "your-user",
        "TAIGA_PASSWORD": "your-password",
        "TAIGA_MCP_ACTOR": "claude"
      }
    }
  }
}
```

## Docker

```bash
cp .env.example .env     # edit with your own values
docker compose up --build
```

## Environment variables

See [`.env.example`](../.env.example) for the complete, commented list (Taiga URL, one account per actor, expected-account bindings and the merge-authorization signing key).

## Verify

Ask your agent to list your Taiga projects. It should call `taiga_projects_list`. If it fails, check that `TAIGA_URL` is reachable and that the credentials are valid.

## Next

- [Operations reference](reference/operations.md)
- [Workflow transition matrix](workflow/transition-matrix.md)
- [Policy engine design](policy-engine/README.md)

# Closing the REST bypass (prepared, NOT applied)

Environment facts (assessed 2026-11-01): Claude Code, the Taiga MCP child process and the `taiga-ops` helper all run as the same OS user (`dev`);
the single shared Taiga login is in `~/.config/taiga-mcp/env` (0600, owner `dev`); `sudo` needs a password; `taiga-ops` has a Bash REST fallback that sources that file.
Taiga cannot tell the actors apart (one account), so a Taiga-side role cannot restrict mutations of one actor only.

Smallest closure (no new service, no new identity system):
1. `scripts/taiga-rest.ts` (this repo): the only sanctioned REST path. Reads credentials itself; reads are free; writes are an allow-list (ordering fields, Epic links, attachments). Status/comment/description/flags/deletes are refused. Tested in `test/rest-closure.test.ts`.
2. `claude-deny-rules.json`: permission deny rules that take the credential file, the Taiga API host/auth URL, `TAIGA_*` variables and `/proc/*/environ` out of Claude's tool surface (Read/Edit/Bash). The MCP child still reads the file at launch (not a tool call).
3. `taiga-ops-rest-fallback.md`: replaces the agent's REST fallback with the helper only.

Activation (all three are config of the Claude side only; nothing on GPT, tunnel or Taiga):
- merge the deny rules into `~/.claude/settings.json` (or the project settings), replace the REST fallback section in `/scope/.claude/agents/taiga-ops.md`, and confirm a fresh Claude session can still run `node scripts/taiga-rest.ts get /task-statuses?project=47`.

Residual (honest): this is pattern-level friction for a shell running as the same OS user, not isolation; a deliberately obfuscated command could still read the file.
Hard closure, if you want it: run the Taiga MCP (HTTP transport, `TAIGA_MCP_*_TOKEN`) as a separate OS user that owns the credentials file (needs sudo, a PO action), give Claude only its actor token, and drop the deny rules. The code already supports it.

Replacement for the "REST fallback" section of `.claude/agents/taiga-ops.md` (apply at activation; the agent keeps `Bash`).

REST fallback (only when the MCP cannot do the action: reordering Stories in a Sprint, Tasks in a Story, Sprints, Stories in an Epic; Epic links; attachments). MCP first, always.
- Use ONLY `node /scope/taiga-mcp/scripts/taiga-rest.ts`. You never log in, never source or read any credentials file, never call the Taiga API with curl.
  - `get <path>` reads anything.
  - `patch /<tasks|userstories|issues|epics|milestones>/<id> '{"version":N,"<ordering field>":V}'` carries ordering fields only (taskboard_order, sprint_order, kanban_order, backlog_order, epic_order, order).
  - `post|delete /epics/<id>/related_userstories[/<link id>]` for Epic links; `attach <kind> <project> <object_id> <file>` for attachments.
- The helper refuses status, comments, descriptions, flags and deletes. Those are workflow mutations: use the Taiga MCP (`taiga_workflow_transition` with a typed artifact, `taiga_workflow_request_*`). If the helper refuses, answer `FAILED: <refusal>`; never look for another way.
- Always re-read afterwards and verify the exact result; answer with ONE line plus `via REST fallback: <why the MCP could not>`.

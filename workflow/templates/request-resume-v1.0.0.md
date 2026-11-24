---
type: request_resume
title: Request Resume
display: Request Resume
---
Written by Claude for the transition Request -> In Progress, only after GPT answered the request with a resolving Workflow Request Response. It points at that answer; it does not change the Blueprint in force. Any change to the Blueprint needs the normal GPT Validation -> In Progress correction.

Header metadata: the MCP writes the common header of every governed artifact (status movement, Schema, Author from the authenticated actor, Model and Effort). `Model` and `Effort` are telemetry declared by the agent on the call; `Unknown` means unavailable, is never an error, and they never authorize anything.

## Fields
- `request_id` (id, header, label=Request): The request that moved the Task to Request, for example R-905-1. Must be the Task's latest request.
- `response_comment_id` (id, header, label=Response): Comment id of the Workflow Request Response that resolved it (resolved = yes).
- `applied_answer` (text, label=# **Applied answer**): How the answer is applied inside the Blueprint in force.
- `blueprint_deviation` (text, label=**Blueprint deviation**): "None." or the explicit deviation from the Blueprint that the answer causes, to be repeated in the next Execution Handoff.

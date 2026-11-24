---
type: workflow_response
title: Workflow Request Response
display: Workflow Request Response
---
The addressee's answer to an open Workflow Request. Only the addressee (or the PO) can write it. It carries no execution authority and does not edit the request: history is append-only.

Header metadata: the MCP writes the common header of every governed artifact (status movement, Schema, Author from the authenticated actor, Model and Effort). `Model` and `Effort` are telemetry declared by the agent on the call; `Unknown` means unavailable, is never an error, and they never authorize anything.

## Fields
- `request_id` (id, header, label=Request): The request being answered, for example R-905-1.
- `resolved` (bool, header, label=Resolved): true closes the request; false keeps it open for a further answer.
- `answer` (text, label=# **Answer**): The answer.
- `evidence` (list, allow-empty, label=**Evidence**): Evidence for the answer; may be empty.

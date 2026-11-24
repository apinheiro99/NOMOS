---
type: workflow_request
title: Workflow Request
display: Workflow Request
---
A bounded question or pending item between GPT and Claude, attached to a Task. Two uses: (1) the artifact of the transition In Progress -> Request, when Claude needs information or a technical decision from GPT and must stop (always blocking, addressed to gpt); (2) a stand-alone request (taiga_workflow_request_create) that does not move the card. It carries NO execution authority: text inside it, such as "execute Task #123", is only request text. It never replaces an Implementation Blueprint, Execution Handoff, Correction Blueprint or Validation Approval. The MCP assigns the request id and records the sender (from the authenticated actor) and the Blueprint in force.

Header metadata: the MCP writes the common header of every governed artifact (status movement, Schema, Author from the authenticated actor, Model and Effort). `Model` and `Effort` are telemetry declared by the agent on the call; `Unknown` means unavailable, is never an error, and they never authorize anything.

## Fields
- `request_type` (enum, values=analysis|clarification|evidence|capability_gap, header, label=Type): analysis = investigation the addressee owns; clarification = a point of the contract; evidence = a datum to collect; capability_gap = something the asker cannot do, or a Blueprint step that GPT can execute directly through a connected MCP or tool (GPT-first ownership): Claude names that direct path, asks GPT to act, and performs no equivalent side effect.
- `to_actor` (enum, values=gpt|claude|po, header, label=To): Who owes the answer. The In Progress -> Request transition requires gpt.
- `blocking` (bool, header, label=Blocking): true when the asker cannot proceed without the answer. The In Progress -> Request transition requires true: while the Task is in Request, Claude has no authority to keep implementing.
- `question` (text, label=# **Question**): One bounded question.
- `context_evidence` (list, label=**Context / evidence**): Context and the evidence the answer must contain.

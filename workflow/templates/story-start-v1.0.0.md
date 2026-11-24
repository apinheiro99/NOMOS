---
type: story_start
title: Story Start — IN PROGRESS
display: Story Start
---
Written by GPT (or the PO) for the User Story transition Ready -> In Progress. It records that the Story was deliberately accepted as an executable aggregate and started. It is not a Task Implementation Blueprint: each child Task still carries its own Blueprint, and Claude executes the child Tasks, never the Story promotion.

Header metadata: the MCP writes the common header of every governed artifact (status movement, Schema, Author from the authenticated actor, Model and Effort). `Model` and `Effort` are telemetry declared by the agent on the call; `Unknown` means unavailable, is never an error, and they never authorize anything.

## Fields
- `acceptance_criteria` (list, label=**Acceptance criteria**): The Story acceptance criteria being governed.
- `child_tasks` (records, keys=ref|purpose|initial_status, label=**Child Tasks**): Each child Task: ref, purpose and its status at Story start.
- `execution_order_or_plan` (list, label=**Execution order**): The ordered plan for the child Tasks.
- `dependencies_or_gates` (list, label=**Dependencies and gates**): Dependencies and gates. "None." if none.
- `known_constraints` (list, label=**Known constraints**): Known constraints. "None." if none.
- `known_risks` (list, label=**Known risks**): Known risks. "None." if none.
- `start_decision` (enum, values=started, label=**Start decision**): Must be "started".

---
type: story_correction
title: Story Correction — RETURNED TO IN PROGRESS
display: Story Correction
---
Written by GPT (or the PO) for the User Story transition GPT Validation -> In Progress. Story-level validation found a defect or gap that needs more implementation. The Story stays open (is_closed=false), completed Tasks are not silently reopened, and the corrective work is planned explicitly. Entering GPT Validation again needs a NEW Story Validation Handoff; the old one becomes stale.

Header metadata: the MCP writes the common header of every governed artifact (status movement, Schema, Author from the authenticated actor, Model and Effort). `Model` and `Effort` are telemetry declared by the agent on the call; `Unknown` means unavailable, is never an error, and they never authorize anything.

## Fields
- `handoff_comment_id` (id, header, label=Handoff): Comment id of the latest Story Validation Handoff that this correction rejects.
- `findings` (records, keys=id|evidence|required_correction, label=# **Findings**): All material Story-level findings in one batch, each with evidence and the required correction.
- `corrective_work` (list, label=**Corrective work**): Corrective Tasks to create or reopen according to the project rules.
- `revalidation_scope` (list, label=**Revalidation scope**): What GPT will revalidate after the correction.
- `known_limits` (list, label=**Known limits**): Anything not proven.

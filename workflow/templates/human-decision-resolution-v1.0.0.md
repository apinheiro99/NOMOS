---
type: human_decision_resolution
title: Human Decision Resolution
display: Human Decision Resolution
---
GPT (or the PO) records, as a governed artifact, an explicit decision the PO already took OUTSIDE Taiga for a Task in Human Decision. The decision authority is the PO: the author records the decision, it never takes it. Writing this artifact does NOT change the Task status: the Task stays in Human Decision, the MCP clears `is_blocked` and `blocked_note` once the artifact is persisted and read back, and the PO then moves the Task manually to `next_status`. The first line of the artifact reads `Human Decision → <next_status>`: it is the movement the PO is authorized to perform manually, NOT a transition the MCP executed. Only taiga_human_decision_resolve writes it.

Header metadata: the MCP writes the common header of every governed artifact (status movement, Schema, Author from the authenticated actor, Model and Effort) and a `Decision authority: PO` line. `Model` and `Effort` are telemetry declared by the agent on the call; `Unknown` means unavailable, is never an error, and they never authorize anything.

## Fields
- `decision_request_comment_id` (id, header, label=Decision request): Comment id of the Human Decision Request being resolved. Must be the Task's latest request that is not resolved yet.
- `verdict` (enum, header, values=resolved, label=Verdict): Always resolved.
- `next_status` (enum, header, values=To Do|In Progress|GPT Validation, label=Next status): Status the PO moves the Task to manually. Must be a destination the workflow allows from where the Task entered Human Decision and must follow from the decision.
- `next_owner` (enum, header, values=gpt|claude|po, label=Next owner): Owner expected after the move; must be the owner that next_status implies (To Do and GPT Validation: gpt, In Progress: claude).
- `po_decision` (text, label=# **PO decision**): The explicit decision of the PO, in the PO's terms.
- `decision_source` (text, label=**Decision source**): Factual reference to the instruction received from the PO (who said it, where and when).
- `decision_effect` (text, label=**Decision effect**): The effect of this decision on the execution of the Task.
- `constraints_remaining` (list, allow-empty, label=**Constraints remaining**): Limits and prohibitions that keep applying after the decision.
- `resume_instruction` (text, label=**Resume instruction**): Objective instruction for the next owner.

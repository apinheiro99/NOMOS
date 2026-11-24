---
type: story_validation_handoff
title: Story Validation Handoff — READY FOR GPT VALIDATION
display: Story Validation Handoff
---
Written by GPT (or the PO) for the User Story transition In Progress -> GPT Validation. It is cumulative over the whole Story: every child Task is Done or Cancelled and the aggregate is ready for independent Story-level validation. When the last child Task reaches Done or Cancelled the MCP normally promotes the Story itself (Story Readiness Promotion); this explicit transition remains for a Story that was not auto-promoted, and the MCP re-checks every child Task at call time.

Header metadata: the MCP writes the common header of every governed artifact (status movement, Schema, Author from the authenticated actor, Model and Effort). `Model` and `Effort` are telemetry declared by the agent on the call; `Unknown` means unavailable, is never an error, and they never authorize anything.

## Fields
- `completed_tasks` (records, keys=ref|status|evidence_summary, label=**Completed Tasks**): Each child Task with its Done status and a summary of its evidence.
- `acceptance_criteria_mapping` (records, keys=criterion|evidence|result, label=**Acceptance criteria mapping**): Each Story acceptance criterion with its evidence and result.
- `commits_or_integrations` (list, label=**Commits / integrations**): Commits and integrations that deliver the Story.
- `cumulative_implementation_summary` (list, label=# **Cumulative implementation**): Outcomes delivered by the Story as a whole, not a diary.
- `task_validation_evidence` (list, label=**Task validation evidence**): References to the Task validation artifacts or comments relied on.
- `integration_evidence` (list, label=**Integration evidence**): Evidence that the Tasks work together. "None." if not applicable.
- `focused_or_component_tests` (list, label=**Focused / component tests**): Tests run and their results.
- `full_ci` (text, label=**Full CI**): Full CI status, or "pending" / "not applicable" when it is intentionally asynchronous or not required at this boundary.
- `runtime_or_migration_evidence` (list, label=**Runtime / migration evidence**): Runtime or migration proof. "None." if not applicable.
- `known_limits` (list, label=**Known limits**): Anything not proven.
- `outstanding_findings` (list, label=**Outstanding findings**): Open findings. "None." if none.
- `readiness_decision` (enum, values=ready_for_gpt_validation, label=**Readiness decision**): Must be "ready_for_gpt_validation".

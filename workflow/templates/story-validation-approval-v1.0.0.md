---
type: story_validation_approval
title: Story Validation — APPROVED
display: Story Validation Approval
---
Written by GPT (or the PO) for the User Story transition GPT Validation -> Done. It is the cumulative independent Story-level audit (every child Task, the integration, the acceptance criteria), not a Task-level validation and not a check of the last patch only. It is the only normal operation that closes a Story. It must cite the LATEST Story Validation Handoff; a handoff that predates a correction is stale and refused.

Header metadata: the MCP writes the common header of every governed artifact (status movement, Schema, Author from the authenticated actor, Model and Effort). `Model` and `Effort` are telemetry declared by the agent on the call; `Unknown` means unavailable, is never an error, and they never authorize anything.

## Fields
- `handoff_comment_id` (id, header, label=Handoff): Comment id of the latest Story Validation Handoff that was validated.
- `completed_tasks_rechecked` (list, label=**Completed Tasks rechecked**): Child Tasks rechecked.
- `acceptance_results` (records, keys=criterion|result|evidence, label=# **Acceptance results**): Result of each Story acceptance criterion with its evidence.
- `cumulative_diff_or_integration_review` (text, label=**Cumulative diff / integration review**): What the cumulative diff and integration review covered and found.
- `contracts_and_adrs_rechecked` (list, label=**Contracts and ADRs rechecked**): Contracts, ADRs/STDs and acceptance clauses rechecked.
- `tests_verified` (list, label=**Tests verified**): Tests GPT verified independently.
- `ci_or_final_gate_evidence` (list, label=**CI / final gate evidence**): CI or final-gate evidence verified. A red applicable gate means the approval must not be issued.
- `runtime_evidence_verified` (list, label=**Runtime evidence verified**): Runtime or live evidence verified. "None." if not applicable.
- `regression_hunt` (list, label=**Regression hunt**): Regressions hunted across the Story.
- `pending_items` (list, label=**Pending items**): Items still pending. "None." if none.
- `issues_created` (list, label=**Issues created**): Issues opened for separate findings. "None." if none.
- `known_limits` (list, label=**Known limits**): Anything not proven.
- `verdict` (enum, values=approved, label=**Verdict**): Must be "approved".

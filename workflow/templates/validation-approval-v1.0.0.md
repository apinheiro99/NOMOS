---
type: validation_approval
title: Validation — APPROVED
display: Validation Approval
---
Written by GPT (or the PO) for GPT Validation -> Done. The MCP, not the caller, writes the first line "Validation — APPROVED". It records a cumulative independent audit, not only a check of the last patch.

Header metadata: the MCP writes the common header of every governed artifact (status movement, Schema, Author from the authenticated actor, Model and Effort). `Model` and `Effort` are telemetry declared by the agent on the call; `Unknown` means unavailable, is never an error, and they never authorize anything.

## Fields
- `blueprint_comment_id` (id, header, task-only, label=Blueprint): Comment id of the current Blueprint.
- `handoff_comment_id` (id, header, label=Handoff): Comment id of the latest Execution Handoff that was validated.
- `commits_validated` (list, label=**Commits validated**): Commits GPT reviewed.
- `cumulative_diff_review` (text, label=**Cumulative diff review**): What the full cumulative diff review covered and found.
- `contracts_rechecked` (list, label=**Contracts rechecked**): Contracts, ADRs/STDs and acceptance clauses rechecked.
- `owners_rechecked` (list, label=**Owners rechecked**): Architecture owners rechecked (no parallel owner introduced).
- `acceptance_results` (list, label=# **Acceptance results**): Result of each acceptance criterion.
- `tests_verified` (list, label=**Tests verified**): Tests GPT verified independently.
- `runtime_evidence_verified` (list, label=**Runtime evidence verified**): Runtime/live evidence GPT verified. "None." if not applicable.
- `regression_hunt` (list, label=**Regression hunt**): Regressions hunted in the touched areas.
- `issues_created` (list, label=**Issues created**): Issues opened for separate findings. "None." if none.
- `known_limits` (list, label=**Known limits**): Anything not proven.
- `po_gates_not_run` (list, label=**Po gates not run**): PO-only gates intentionally not run (push, full suite, ...).
- `verdict` (enum, values=approved, label=**Verdict**): Must be "approved".

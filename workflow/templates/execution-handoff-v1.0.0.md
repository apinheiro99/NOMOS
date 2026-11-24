---
type: execution_handoff
title: Execution Handoff — READY FOR GPT VALIDATION
display: Execution Handoff
---
Written by Claude for the transition In Progress -> GPT Validation (Stories/Epics: the same hand-off to GPT Validation). Outcome-based evidence for GPT's independent validation; it does not replace that validation. Return exactly the evidence the Blueprint asked for.

Header metadata: the MCP writes the common header of every governed artifact (status movement, Schema, Author from the authenticated actor, Model and Effort). `Model` and `Effort` are telemetry declared by the agent on the call; `Unknown` means unavailable, is never an error, and they never authorize anything.

## Fields
- `blueprint_comment_id` (id, header, task-only, label=Blueprint): Comment id of the current Blueprint this work executes.
- `branch` (text, label=**Branch**): Local branch holding the work.
- `commits` (records, keys=id|contains, label=**Commits**): Local commit ids and what each contains.
- `implementation_summary` (list, label=# **Implementation**): Outcomes delivered, not a diary.
- `files_changed` (list, label=**Files changed**): Files changed.
- `focused_tests` (records, keys=command|result, optional-keys=counts|pre_existing, label=**Focused tests**): Each test command/suite with its result; counts and whether a failure pre-dated the Task when relevant.
- `typecheck` (text, label=**Typecheck**): Typecheck result.
- `runtime_evidence` (list, label=**Runtime / migration evidence**): Live or runtime proof the Blueprint required. Write "None." if not applicable.
- `migrations_or_service_actions` (list, label=**Migrations / service actions**): Migrations, restarts and health checks performed. Write "None." if none.
- `deviations_from_blueprint` (list, label=**Deviations**): Explicit deviations from the Blueprint; "No deviations." is valid.
- `known_limits` (list, label=**Known limits**): Anything not proven.
- `bug_hunt` (list, label=**Bug hunt**): What Claude inspected for implementation-time regressions inside its scope. Does not replace GPT validation.
- `unrelated_findings` (list, label=**Unrelated findings**): Material findings outside the Task (Issue candidates). "None." if none.
- `prohibited_actions_not_performed` (list, label=**Prohibited actions not performed**): For example no push, no full suite.
- `working_tree_notes` (list, label=**Working tree notes**): State of the working tree and unrelated local changes.

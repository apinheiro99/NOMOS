---
type: implementation_blueprint
mode: correction
title: Implementation Blueprint
display: Correction Blueprint
---
Written by GPT for the transition GPT Validation -> In Progress after a failed validation. Same contract as the Implementation Blueprint plus the findings. It may contain implementation work but never an unresolved broad investigation: GPT states the root cause of every finding. It supersedes the previous Blueprint; history is never rewritten.

Header metadata: the MCP writes the common header of every governed artifact (status movement, Schema, Author from the authenticated actor, Model and Effort). `Model` and `Effort` are telemetry declared by the agent on the call; `Unknown` means unavailable, is never an error, and they never authorize anything.

## Fields
- `validation_round` (int, header, label=Validation round): The validation round that failed. Must be the previous round + 1 (the first correction is 1).
- `supersedes_blueprint_comment_id` (id, header, label=Supersedes): Comment id of the current Blueprint this one supersedes.
- `objective` (text, label=**Objective**): One concrete correction outcome.
- `verified_baseline` (text, label=**Verified baseline**): Facts GPT verified: commits validated, current behavior, evidence of each failure.
- `problem_model` (text, label=**Problem model**): The established cause of the failures. Must not delegate investigation to Claude.
- `cumulative_audit_scope` (text, label=**Cumulative audit scope**): What the cumulative revalidation will cover (previous blockers, full new diff, regressions in touched areas, criteria the patch could invalidate).
- `findings` (records, keys=id|evidence|classification|root_cause|required_correction|affected_owners|regression_scope, label=# **Findings**): One complete batch of every material finding of this round, each with evidence, an established root cause and the required correction.
- `binding_contracts` (list, label=**Binding contracts**): ADRs/STDs and acceptance clauses that bind the correction.
- `architecture_owners` (records, keys=responsibility|current_owner|intended_owner|forbidden_parallel_owner, label=**Architecture / owners**): Per affected responsibility: current owner, intended owner, forbidden parallel owner.
- `implementation_scope` (list, label=**Implementation scope**): Concrete corrections Claude must implement.
- `files_and_interfaces` (list, label=**Files / interfaces**): Known files, modules, functions, APIs and boundaries.
- `invariants` (list, label=**Invariants**): What must stay true across the correction.
- `unchanged_verified_invariants` (list, label=**Unchanged verified invariants**): Invariants already verified in a previous round that must not regress.
- `known_traps_and_risks` (list, label=**Risks / traps**): Failure modes, including those seen in earlier rounds.
- `focused_test_matrix` (list, label=**Focused test matrix**): Tests that reproduce each finding and guard against regression.
- `cumulative_revalidation_matrix` (list, label=**Cumulative revalidation matrix**): Everything GPT will recheck at the next validation, including previously passed criteria.
- `evidence_expected` (list, label=**Evidence expected at handoff**): Exactly what the next Execution Handoff must return.
- `operational_steps` (list, label=**Operational steps and gates**): Routine steps Claude may perform; "None." if none.
- `prohibited_actions` (list, label=**Prohibited actions**): For example no push, no full suite, no unrelated refactor.
- `stop_condition` (text, label=**Stop condition**): The exact state at which Claude stops and hands back to GPT Validation.
- `open_questions` (questions, label=**Open questions**): Normally empty (`[]`); only implementation-local questions are accepted.

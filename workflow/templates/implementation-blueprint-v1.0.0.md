---
type: implementation_blueprint
mode: initial
title: Implementation Blueprint
display: Implementation Blueprint
---
Written by GPT for the transition To Do -> In Progress. One complete, self-contained contract: Claude must not need to rediscover architecture or root cause. If the root cause or an architectural question is still open, the Task is NOT ready for Claude and must not be released.

Header metadata: the MCP writes the common header of every governed artifact (status movement, Schema, Author from the authenticated actor, Model and Effort). `Model` and `Effort` are telemetry declared by the agent on the call; `Unknown` means unavailable, is never an error, and they never authorize anything.

## Fields
- `objective` (text, label=**Objective**): One concrete delivery outcome. Not "investigate and fix".
- `verified_baseline` (text, label=**Verified baseline**): Facts GPT verified before release: branch/commit, Task and Story state, current source behavior, live evidence, predecessor state. No unverified assumption written as fact.
- `problem_model` (text, label=**Problem model**): The established defect, root cause or design problem. Must not delegate investigation to Claude.
- `binding_contracts` (list, label=**Binding contracts**): Accepted ADRs/STDs, Task acceptance clauses and canonical owner contracts that bind the change.
- `architecture_owners` (records, keys=responsibility|current_owner|intended_owner|forbidden_parallel_owner, label=**Architecture / owners**): Per affected responsibility: current owner, intended owner, and the parallel owner/cache/state machine that is forbidden.
- `implementation_scope` (list, label=# **Implementation scope**): Concrete outcomes Claude must implement.
- `files_and_interfaces` (list, label=**Files / interfaces**): Known files, modules, functions, APIs, schemas and boundaries, so nothing has to be rediscovered.
- `invariants` (list, label=**Invariants**): What must stay true: idempotency, concurrency, ownership, persistence, security, pacing, append-only history.
- `known_traps_and_risks` (list, label=**Risks / traps**): Previously observed failure modes and regressions to avoid.
- `focused_test_matrix` (list, label=**Focused test matrix**): Named behaviors, failure reproduction, regression expectations, typecheck and runtime proof.
- `evidence_expected` (list, label=**Evidence expected at handoff**): Exactly what the Execution Handoff must return.
- `operational_steps` (list, label=**Operational steps and gates**): Routine migration/restart/health/live-proof steps Claude may perform; PO-only gates stated separately. Actions GPT can execute directly through a connected MCP or tool (GPT-first ownership) are GPT steps, never Claude steps: state them as "GPT executes directly" and keep only repository-local code, tests and runtime work for Claude. Write "None." if there are none.
- `prohibited_actions` (list, label=**Prohibited actions**): For example no push, no full suite, no destructive live data change, no unrelated refactor, no new owner/cache/state machine.
- `stop_condition` (text, label=**Stop condition**): The exact state at which Claude stops and hands back to GPT Validation.
- `open_questions` (questions, label=**Open questions**): Normally empty (`[]`). Only {question, classification: "implementation_local"} entries are accepted; architectural questions must be resolved by GPT first.

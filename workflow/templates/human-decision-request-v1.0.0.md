---
type: human_decision_request
title: Human Decision Request
display: Human Decision Request
---
For a genuine unresolved Product Owner choice that the current contract does not decide. Routine execution (migration, restart, health check, focused tests, local git) is never a Human Decision.

Header metadata: the MCP writes the common header of every governed artifact (status movement, Schema, Author from the authenticated actor, Model and Effort). `Model` and `Effort` are telemetry declared by the agent on the call; `Unknown` means unavailable, is never an error, and they never authorize anything.

## Fields
- `decision_needed` (text, label=# **Decision needed**): The single decision the PO must make.
- `why_existing_contract_does_not_decide_it` (text, label=**Why existing contract does not decide it**): Why the Task, ADRs and Guides do not already decide it.
- `evidence` (list, label=**Evidence**): Evidence behind the question.
- `options` (list, min=2, label=**Options**): The options available (at least two).
- `recommendation` (text, label=**Recommendation**): The recommended option and why.
- `impact_of_each_option` (list, label=**Impact of each option**): Consequences of each option.
- `blocked` (bool, header, label=Blocking): true when the unresolved decision gates downstream dependent work; the MCP then also sets is_blocked with the blocked_note.
- `blocked_note` (text, optional, label=**Blocked note**): Required when blocked is true: what is gated.
- `resume_target` (text, label=**Resume target**): The status/step the card resumes at once decided.

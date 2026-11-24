---
type: po_decision
title: PO Decision
display: PO Decision
---
Leaves an explainable record when the PO overrides the normal workflow, and when GPT cancels a card on an explicit PO instruction. It does not record a Human Decision: that is the Human Decision Resolution (taiga_human_decision_resolve). It is the only artifact the PO may use for transitions outside the actor/state matrix.

Header metadata: the MCP writes the common header of every governed artifact (status movement, Schema, Author from the authenticated actor, Model and Effort). `Model` and `Effort` are telemetry declared by the agent on the call; `Unknown` means unavailable, is never an error, and they never authorize anything.

## Fields
- `decision` (text, label=# **Decision**): What was decided.
- `rationale` (text, label=**Rationale**): Why the PO decided this way.
- `effect` (text, label=**Effect**): What changes on the card (status, scope, block).
- `instruction_reference` (text, optional, label=**Instruction reference**): The explicit PO instruction being followed. Required unless the PO signs the decision.

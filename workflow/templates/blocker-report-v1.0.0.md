---
type: blocker_report
title: Blocker Report
display: Blocker Report
---
For In Progress -> To Do when something blocks the card (Guide 3, ruling 2026-10-31). The MCP also sets is_blocked=true with the blocked_note. The finding becomes an Issue and predecessor work is created before the blocked card; the block is cleared and the card released again by GPT.

Header metadata: the MCP writes the common header of every governed artifact (status movement, Schema, Author from the authenticated actor, Model and Effort). `Model` and `Effort` are telemetry declared by the agent on the call; `Unknown` means unavailable, is never an error, and they never authorize anything.

## Fields
- `finding` (text, label=# **Finding**): What blocks the card.
- `evidence` (list, label=**Evidence**): Evidence of the blocker.
- `blocked_note` (text, label=**Blocked note**): The specific note stored on the card.
- `issue_reference` (text, label=**Issue reference**): The Issue that records the finding, or "to be created".
- `required_predecessor_work` (list, label=**Required predecessor work**): Work that must be resolved first, in order.

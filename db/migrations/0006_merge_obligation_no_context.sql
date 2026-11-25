-- A Done approved with no merge_context while the Task's hand-off declares a work branch still owes an authorization the MCP cannot issue: no SHA, no target and no
-- authorization are invented. That obligation is stored with no context, in `review` (never signed), until the PO resolves it.
ALTER TABLE merge_obligation ALTER COLUMN context DROP NOT NULL, ALTER COLUMN work_item DROP NOT NULL, ALTER COLUMN target_work_item DROP NOT NULL;
ALTER TABLE merge_obligation ADD CONSTRAINT merge_obligation_context_check
  CHECK ((context IS NULL) = (work_item IS NULL) AND (context IS NULL) = (target_work_item IS NULL) AND (context IS NOT NULL OR state IN ('review', 'abandoned')));

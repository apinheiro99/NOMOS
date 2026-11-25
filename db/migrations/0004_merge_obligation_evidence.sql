-- A merge obligation is bound to the exact approval it was opened for, to the policy activation and journal entry it ran under, and to its
-- original recipient, so a recovery proves the Done is THAT approval's and delivers to the same party. `review` holds an outcome that cannot be proven.
-- Rows written by 0003 carry none of that evidence: each gets a journal entry of its own (same id, marked legacy), the project's active activation,
-- and a pending one becomes `review` (it can no longer be proven from Taiga, so it is reported, never signed and never dropped).
ALTER TABLE merge_obligation DROP CONSTRAINT merge_obligation_state_check;
ALTER TABLE merge_obligation DROP CONSTRAINT merge_obligation_check;
ALTER TABLE merge_obligation
  ADD COLUMN activation_id uuid,
  ADD COLUMN journal_id uuid,
  ADD COLUMN actor text,
  ADD COLUMN recipient text,
  ADD COLUMN approval_hash text,
  ADD COLUMN approval_comment_id text;
UPDATE merge_obligation m SET activation_id = coalesce(
  (SELECT b.active_activation_id FROM project_binding b WHERE b.id = m.project_id),
  (SELECT a.id FROM policy_activation a WHERE a.project_id = m.project_id ORDER BY a.activated_at LIMIT 1));
INSERT INTO mutation_journal (id, project_id, activation_id, operation, target_key, phase, result, created_at, updated_at)
  SELECT authorization_id, project_id, activation_id, 'workflow_transition', entity || ':' || taiga_id, 'completed', '{"legacy":true}'::jsonb, created_at, updated_at FROM merge_obligation;
UPDATE merge_obligation SET journal_id = authorization_id, actor = 'po', approval_hash = 'legacy:unproven',
  state = CASE WHEN state = 'pending' THEN 'review' ELSE state END;
ALTER TABLE merge_obligation
  ALTER COLUMN activation_id SET NOT NULL, ALTER COLUMN journal_id SET NOT NULL, ALTER COLUMN actor SET NOT NULL, ALTER COLUMN approval_hash SET NOT NULL,
  ADD CONSTRAINT merge_obligation_actor_check CHECK (actor IN ('gpt', 'claude', 'po')),
  ADD CONSTRAINT merge_obligation_recipient_check CHECK (recipient IN ('gpt', 'claude')),
  ADD FOREIGN KEY (journal_id) REFERENCES mutation_journal (id),
  ADD FOREIGN KEY (project_id, activation_id) REFERENCES policy_activation (project_id, id),
  ADD CONSTRAINT merge_obligation_state_check CHECK (state IN ('pending', 'signed', 'abandoned', 'review')),
  ADD CONSTRAINT merge_obligation_envelope_check CHECK ((state = 'signed') = (envelope IS NOT NULL));
DROP INDEX merge_obligation_pending_idx;
CREATE INDEX merge_obligation_open_idx ON merge_obligation (created_at) WHERE state IN ('pending', 'review');

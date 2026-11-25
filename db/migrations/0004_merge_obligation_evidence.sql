-- A merge obligation is bound to the exact approval it was opened for, to the policy activation and journal entry it ran under, and to its
-- original recipient, so a recovery proves the Done is THAT approval's and delivers to the same party. `review` holds an outcome that cannot be proven.
ALTER TABLE merge_obligation
  ADD COLUMN activation_id uuid NOT NULL,
  ADD COLUMN journal_id uuid NOT NULL REFERENCES mutation_journal (id),
  ADD COLUMN actor text NOT NULL CHECK (actor IN ('gpt', 'claude', 'po')),
  ADD COLUMN recipient text CHECK (recipient IN ('gpt', 'claude')),
  ADD COLUMN approval_hash text NOT NULL,
  ADD COLUMN approval_comment_id text,
  ADD FOREIGN KEY (project_id, activation_id) REFERENCES policy_activation (project_id, id);
ALTER TABLE merge_obligation DROP CONSTRAINT merge_obligation_state_check;
ALTER TABLE merge_obligation DROP CONSTRAINT merge_obligation_check;
ALTER TABLE merge_obligation
  ADD CONSTRAINT merge_obligation_state_check CHECK (state IN ('pending', 'signed', 'abandoned', 'review')),
  ADD CONSTRAINT merge_obligation_envelope_check CHECK ((state = 'signed') = (envelope IS NOT NULL));
DROP INDEX merge_obligation_pending_idx;
CREATE INDEX merge_obligation_open_idx ON merge_obligation (created_at) WHERE state IN ('pending', 'review');

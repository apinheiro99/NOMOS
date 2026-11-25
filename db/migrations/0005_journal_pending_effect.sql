-- A governed Done that owes a merge authorization is not complete when the Done is verified: the journal entry stays in `pending_effect` until the signed
-- envelope is stored AND its delivery was attempted, so a crash in between is found and finished by the recovery (the same envelope, never a second one).
ALTER TABLE mutation_journal DROP CONSTRAINT mutation_journal_phase_check;
ALTER TABLE mutation_journal ADD CONSTRAINT mutation_journal_phase_check CHECK (phase IN ('intent', 'applied', 'pending_effect', 'completed', 'failed'));
CREATE INDEX mutation_journal_pending_effect_idx ON mutation_journal (updated_at) WHERE phase = 'pending_effect';

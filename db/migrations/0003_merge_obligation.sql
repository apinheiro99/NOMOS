-- A merge authorization is owed from the moment a managed Done is attempted: the obligation is stored BEFORE the Done is written,
-- so a crash after the Done leaves what is needed to issue exactly one authorization. A row is never signed by observing a Done alone.
CREATE TABLE merge_obligation (
  authorization_id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES project_binding,
  entity text NOT NULL CHECK (entity IN ('task', 'userstory')),
  taiga_id bigint NOT NULL,
  done_status bigint NOT NULL,
  taiga_project bigint NOT NULL,
  context jsonb NOT NULL,
  work_item jsonb NOT NULL,
  target_work_item text NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'signed', 'abandoned')),
  envelope jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((state = 'signed') = (envelope IS NOT NULL))
);
CREATE INDEX merge_obligation_project_idx ON merge_obligation (project_id);
CREATE INDEX merge_obligation_pending_idx ON merge_obligation (created_at) WHERE state = 'pending';

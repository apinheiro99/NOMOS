-- Policy engine schema (F2). Integrity is enforced by the database: composite foreign keys keep every row inside its own project,
-- policy history is append-only, and an activation needs an approved review of the very version it activates.

CREATE TABLE taiga_instance (
  id uuid PRIMARY KEY,
  instance_key text NOT NULL UNIQUE,
  base_url text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE project_binding (
  id uuid PRIMARY KEY,
  instance_id uuid NOT NULL REFERENCES taiga_instance,
  taiga_project_id bigint NOT NULL,
  slug text NOT NULL,
  name text NOT NULL,
  lifecycle text NOT NULL CHECK (lifecycle IN ('pending', 'managed', 'drift', 'inaccessible', 'archived', 'legacy')),
  uuid_ready boolean NOT NULL DEFAULT false,
  profile_fingerprint text,
  metadata jsonb NOT NULL DEFAULT '{}',
  last_seen_at timestamptz,
  active_activation_id uuid,
  UNIQUE (instance_id, taiga_project_id)
);

CREATE TABLE policy_version (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES project_binding,
  revision bigint NOT NULL CHECK (revision > 0),
  parent_id uuid,
  catalog_version text NOT NULL,
  schema_version integer NOT NULL,
  payload jsonb NOT NULL,
  content_hash text NOT NULL,
  proposed_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, revision),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, parent_id) REFERENCES policy_version (project_id, id)
);

CREATE TABLE policy_review (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES project_binding,
  policy_id uuid NOT NULL,
  decision text NOT NULL CHECK (decision IN ('approved', 'rejected', 'withdrawn')),
  actor text NOT NULL,
  reason text NOT NULL CHECK (length(reason) > 0),
  reviewed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, policy_id, id),
  FOREIGN KEY (project_id, policy_id) REFERENCES policy_version (project_id, id)
);

CREATE TABLE policy_activation (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES project_binding,
  policy_id uuid NOT NULL,
  review_id uuid NOT NULL UNIQUE,
  previous_activation_id uuid,
  activated_by text NOT NULL,
  reason text NOT NULL CHECK (length(reason) > 0),
  activated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, id),
  FOREIGN KEY (project_id, policy_id) REFERENCES policy_version (project_id, id),
  FOREIGN KEY (project_id, policy_id, review_id) REFERENCES policy_review (project_id, policy_id, id),
  FOREIGN KEY (project_id, previous_activation_id) REFERENCES policy_activation (project_id, id)
);

-- project_binding is the only owner of the active pointer.
ALTER TABLE project_binding ADD FOREIGN KEY (id, active_activation_id) REFERENCES policy_activation (project_id, id);

CREATE TABLE policy_audit (
  id uuid PRIMARY KEY,
  instance_id uuid NOT NULL REFERENCES taiga_instance,
  project_id uuid,
  activation_id uuid,
  principal text NOT NULL,
  operation text NOT NULL,
  resource_kind text,
  resource_key text,
  decision text NOT NULL,
  rule_key text,
  correlation_id uuid NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  occurred_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id) REFERENCES project_binding (id),
  FOREIGN KEY (project_id, activation_id) REFERENCES policy_activation (project_id, id)
);

CREATE TABLE mutation_journal (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL REFERENCES project_binding,
  activation_id uuid NOT NULL,
  operation text NOT NULL,
  target_key text,
  expected_taiga_version bigint,
  phase text NOT NULL CHECK (phase IN ('intent', 'applied', 'completed', 'failed')),
  evidence_ref text,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (project_id, activation_id) REFERENCES policy_activation (project_id, id)
);

-- Project creation happens before the Taiga project id exists, so its intent cannot live in the journal.
CREATE TABLE provisioning_intent (
  id uuid PRIMARY KEY,
  instance_id uuid NOT NULL REFERENCES taiga_instance,
  principal text NOT NULL,
  operation text NOT NULL,
  request_key text NOT NULL,
  request_hash text NOT NULL,
  external_project_id bigint,
  phase text NOT NULL CHECK (phase IN ('intent', 'created', 'bound', 'failed')),
  evidence jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (instance_id, request_key)
);

-- Indexes on the foreign keys that no unique constraint already covers, and on what is read by date, phase and correlation.
CREATE INDEX project_binding_instance_idx ON project_binding (instance_id);
CREATE INDEX policy_review_policy_idx ON policy_review (project_id, policy_id);
CREATE INDEX policy_activation_project_idx ON policy_activation (project_id, activated_at DESC);
CREATE INDEX policy_activation_previous_idx ON policy_activation (project_id, previous_activation_id);
CREATE INDEX policy_audit_project_idx ON policy_audit (project_id, occurred_at DESC);
CREATE INDEX policy_audit_correlation_idx ON policy_audit (correlation_id);
CREATE INDEX policy_audit_instance_idx ON policy_audit (instance_id);
CREATE INDEX mutation_journal_activation_idx ON mutation_journal (project_id, activation_id);
CREATE INDEX mutation_journal_phase_idx ON mutation_journal (phase, updated_at);
CREATE INDEX provisioning_intent_phase_idx ON provisioning_intent (phase);

-- Append-only: history is never rewritten, not even by the owner of the application.
CREATE FUNCTION reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'restrict_violation';
END $$;
CREATE TRIGGER policy_version_append_only BEFORE UPDATE OR DELETE ON policy_version FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER policy_review_append_only BEFORE UPDATE OR DELETE ON policy_review FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER policy_activation_append_only BEFORE UPDATE OR DELETE ON policy_activation FOR EACH ROW EXECUTE FUNCTION reject_change();
CREATE TRIGGER policy_audit_append_only BEFORE UPDATE OR DELETE ON policy_audit FOR EACH ROW EXECUTE FUNCTION reject_change();

-- An activation needs an APPROVED review, and its previous activation is the project's current one (or none for the first).
CREATE FUNCTION require_approved_review() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT decision FROM policy_review WHERE id = NEW.review_id) <> 'approved' THEN
    RAISE EXCEPTION 'activation requires an approved review' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.previous_activation_id IS DISTINCT FROM (SELECT active_activation_id FROM project_binding WHERE id = NEW.project_id) THEN
    RAISE EXCEPTION 'previous activation is not the current one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER policy_activation_needs_review BEFORE INSERT ON policy_activation FOR EACH ROW EXECUTE FUNCTION require_approved_review();

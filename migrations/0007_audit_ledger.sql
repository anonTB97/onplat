-- =============================================================================
-- 0007 — Audit ledger: append-only and hash-chained.
--
-- NOTHING IS DELETED, EVER. Supersession is a state, not a DELETE. UPDATE and
-- DELETE are revoked at the grant level (from PUBLIC and from the application
-- role); the application may only INSERT and SELECT. `entry_hash` chains to
-- `prev_hash` so a silent edit to history is detectable by `wadl verify-ledger`.
-- =============================================================================

CREATE TABLE audit_entry (
  entry_id        bigserial PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  vessel_id       uuid REFERENCES vessel(vessel_id),
  action          text NOT NULL,            -- ACTIVITY_SUSPENDED, PERMIT_APPROVED ...
  rule_version_id uuid REFERENCES rule_version(rule_version_id),
  subject_type    text,
  subject_id      uuid,
  by_person       uuid REFERENCES person(person_id),
  persona_id      uuid REFERENCES persona(persona_id),
  detail          text NOT NULL,
  occurred_at     timestamptz NOT NULL,     -- device time where applicable
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  prev_hash       bytea,
  entry_hash      bytea NOT NULL
);

CREATE INDEX ON audit_entry (org_id, vessel_id, recorded_at DESC);
CREATE INDEX ON audit_entry (subject_type, subject_id);

ALTER TABLE audit_entry ENABLE ROW LEVEL SECURITY;
CREATE POLICY audit_entry_tenant ON audit_entry
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

-- Append-only, enforced by privilege. The application inserts and reads; it
-- cannot rewrite history.
REVOKE UPDATE, DELETE ON audit_entry FROM PUBLIC;
GRANT SELECT, INSERT ON audit_entry TO wadl_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wadl_app;
REVOKE UPDATE, DELETE ON audit_entry FROM wadl_app;

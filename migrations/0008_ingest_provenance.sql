-- =============================================================================
-- 0008 — Ingest provenance.
--
-- Nothing enters the system without a source. Every ingested row can be traced
-- to an ingest_run; the P6 field crosswalk lives in ingest_field_map, with a
-- reliability grade so a low-confidence mapping (compartment parsed from an
-- activity name) is never mistaken for a high-confidence one.
-- =============================================================================

CREATE TABLE ingest_run (
  run_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  source_system   text NOT NULL,            -- 'primavera_p6', 'ifs', 'csv_upload'
  source_file     text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  row_count       integer,
  reject_count    integer,
  notes           text
);

CREATE TABLE ingest_field_map (
  map_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  source_system   text NOT NULL,
  target_field    text NOT NULL,            -- 'compartment_no'
  source_field    text NOT NULL,            -- 'UDF: Compartment' or 'parse:activity_name'
  transform       jsonb,
  reliability     text CHECK (reliability IN ('high','medium','low','theatre')),
  confirmed_by    uuid REFERENCES person(person_id),
  UNIQUE (org_id, source_system, target_field)
);

ALTER TABLE ingest_run ENABLE ROW LEVEL SECURITY;
CREATE POLICY ingest_run_tenant ON ingest_run
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE ingest_field_map ENABLE ROW LEVEL SECURITY;
CREATE POLICY ingest_field_map_tenant ON ingest_field_map
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wadl_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wadl_app;
-- Re-assert the audit ledger's append-only privilege after the blanket grant.
REVOKE UPDATE, DELETE ON audit_entry FROM wadl_app;

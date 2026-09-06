-- =============================================================================
-- 0018 — One row per schedule import, the served run pointed to (pilot
-- barrier B4, HIGH item H4).
--
-- ingest_run (0008) finally has a writer: every XER commit records the field
-- map it was read through, the encoding, who imported it and how, the
-- quarantine and exclusions, and the schedule of record it produced — so any
-- prior run can be served again and any two can be diffed. Columns are
-- nullable so the table's (empty) history stays valid. RLS is 0008's org
-- policy; the hull gate is the store's get_vessel before every read.
--
-- The P6 field map joins the ingested documents as kind 'p6_field_map': the
-- yard's export conventions as data, one per hull, through a door with a
-- ledger line. The kind CHECK lists every kind in force, including 0016's
-- yard_clock.
-- =============================================================================

ALTER TABLE ingest_run
  ADD COLUMN vessel_id      uuid REFERENCES vessel(vessel_id),
  ADD COLUMN seq            integer,
  ADD COLUMN label          text,
  ADD COLUMN encoding       text,
  ADD COLUMN decoded_by     text,
  ADD COLUMN imported_by    jsonb,   -- { org, person, via }
  ADD COLUMN field_map      jsonb,   -- the map the run was read through
  ADD COLUMN report         jsonb,   -- quarantine, exclusions, fields_seen, findings, counts, projects_served
  ADD COLUMN doc            jsonb,   -- the run's schedule of record, the shape ingested_document serves
  ADD COLUMN schema_version integer;

COMMENT ON COLUMN ingest_run.seq IS '1, 2, 3… per hull, assigned under a per-hull advisory lock at commit';
COMMENT ON COLUMN ingest_run.doc IS 'the run''s schedule of record; serving a prior run copies it into ingested_document';

CREATE INDEX ON ingest_run (vessel_id, seq DESC);

ALTER TABLE ingested_document ADD COLUMN run_id uuid REFERENCES ingest_run(run_id);
COMMENT ON COLUMN ingested_document.run_id IS 'for kind schedule_of_record: the run whose document this is; NULL when set without a run';

ALTER TABLE ingested_document DROP CONSTRAINT ingested_document_kind_check;
ALTER TABLE ingested_document ADD CONSTRAINT ingested_document_kind_check
  CHECK (kind IN ('schedule_of_record','zone_register','budget_book','manning_book',
                  'geometry_register','compartment_register','coupling_register',
                  'yard_clock','p6_field_map'));

-- Grants are inherited: 0008's blanket GRANT covers ingest_run's new columns,
-- 0011's covers ingested_document's.

-- 0016: the yard's clock joins the ingested documents (pilot barrier B6).
-- One row per hull: IANA zone, standard offset, an optional daylight rule as two
-- nth-weekday transitions, the watch length, the shifts by the yard's names.
-- Evaluated by wadl_domain::civil on the server and its mirror in the shell; a
-- tz database would be a dependency that must be re-released when a clock law
-- changes, where this is a document that goes through a door with a ledger line.
-- Until a clock is loaded, the database-backed store serves UTC and says so.
ALTER TABLE ingested_document DROP CONSTRAINT ingested_document_kind_check;
ALTER TABLE ingested_document ADD CONSTRAINT ingested_document_kind_check
  CHECK (kind IN
    ('schedule_of_record','zone_register','budget_book','manning_book',
     'geometry_register','compartment_register','coupling_register','yard_clock'));

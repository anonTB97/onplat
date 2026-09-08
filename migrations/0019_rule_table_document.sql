-- =============================================================================
-- 0019 — The rule table joins the ingested documents (pilot barrier B11).
--
-- The safety authority's CSV — the handoff's twelve columns plus the nine the
-- sitting fills — is the versioned record of the rules in force: one
-- `ingested_document` row of kind 'rule_table' per hull, carrying the cells as
-- they arrived, the entries they compiled to (with content-addressed version
-- ids, recorded on every trace), the table's hash, and the safety authority's
-- signature when given. `rules_in_force` serves the document's entries when
-- one is stored and the seed rows otherwise.
--
-- The 0004 rule tables (rule, rule_version, rule_binding) are NOT mirrored
-- from the door: they keep serving the development seed, which `wadl seed`
-- writes from `RuleSet::seed_usn_hot_work()` (a retired seed version has its
-- effective_to set). The document is the record; its ids are its own.
--
-- CHECK widening only, listing every kind in force.
-- rollback: additive
-- =============================================================================

ALTER TABLE ingested_document DROP CONSTRAINT ingested_document_kind_check;
ALTER TABLE ingested_document ADD CONSTRAINT ingested_document_kind_check
  CHECK (kind IN ('schedule_of_record','zone_register','budget_book','manning_book',
                  'geometry_register','compartment_register','coupling_register',
                  'yard_clock','p6_field_map','rule_table'));

-- Grants are inherited: 0011's blanket GRANT on ingested_document covers the
-- new kind.

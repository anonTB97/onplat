-- =============================================================================
-- 0011 — Hazards, ingested documents, and the ledger's subject key.
--
-- The three additions that let the PostgreSQL store serve the FULL
-- `Repositories` trait (docs/poam.md POAM-2), each carrying the modelling
-- decision it embodies:
--
--   hazard              live conditions as first-class recorded facts.
--   ingested_document   the three all-or-nothing imports, stored as documents.
--   audit_entry.subject_ref   the ledger's denormalised lookup key.
--
-- This migration also writes down the rule-payload contract (see below), which
-- 0004 deliberately left open.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Hazards.
--
-- MODELLING DECISION, stated for the record: a hazard is a *recorded fact* —
-- "bus 3-SG-2 is energised", "CT-3160-4 is curing" — entered by the systems and
-- people who own those facts, not a view derived from permits and certificates.
-- The alternative (deriving hazards from `permit` rows by work_type plus
-- `space_certificate` expiry) makes the serving read depend on a safety-relevant
-- inference this platform would then own. Keeping the table primary means those
-- systems may POPULATE it (an ingest adapter writing hazard rows from a permit
-- feed is fine) but what the engine evaluates is always an explicit row someone
-- can point at, challenge, and clear. `cleared_at` closes a hazard; nothing is
-- deleted.
--
-- `kind` uses the engine's own serde names (`wadl_engine::HazardKind`,
-- snake_case), so a row and the domain type convert without a mapping table
-- that could drift.
-- -----------------------------------------------------------------------------
CREATE TABLE hazard (
  hazard_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  vessel_id       uuid NOT NULL REFERENCES vessel(vessel_id),
  compartment_no  text NOT NULL,            -- the origin space
  kind            text NOT NULL CHECK (kind IN
                    ('coating_open','hot_work_live','energised_bus',
                     'flammable_stow','stop_work')),
  raised_at       timestamptz NOT NULL,
  label           text NOT NULL,            -- e.g. 'CT-3160-4 · final coat, curing'
  cleared_at      timestamptz
);

CREATE INDEX ON hazard (vessel_id) WHERE cleared_at IS NULL;

ALTER TABLE hazard ENABLE ROW LEVEL SECURITY;
CREATE POLICY hazard_tenant ON hazard
  USING (EXISTS (SELECT 1 FROM vessel v WHERE v.vessel_id = hazard.vessel_id));

-- -----------------------------------------------------------------------------
-- Ingested documents.
--
-- The schedule of record, the zone chart, and the budget book arrive through
-- all-or-nothing import doors: previewed via dry run, committed whole, reverted
-- whole. The DOCUMENT is therefore the unit of consistency, and it is stored as
-- one — a jsonb payload in the store's own read-model shapes, one row per
-- (hull, kind), replaced or deleted atomically. Its rows are never queried
-- piecemeal by SQL; every reader takes the whole register and computes, which
-- is the same contract the in-memory store serves.
--
-- This is deliberately a different layer from `p6_activity` (0009): that table
-- is verbatim ingest EVIDENCE, stamped with its run and kept for the argument
-- about what the file actually said. This table is what WADL SERVES. Evidence
-- accumulates; the served document is replaced.
-- -----------------------------------------------------------------------------
CREATE TABLE ingested_document (
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  vessel_id       uuid NOT NULL REFERENCES vessel(vessel_id),
  kind            text NOT NULL CHECK (kind IN
                    ('schedule_of_record','zone_register','budget_book')),
  label           text NOT NULL,            -- e.g. 'CVN73-PIA26-full.xer'
  doc             jsonb NOT NULL,
  ingested_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (vessel_id, kind)
);

ALTER TABLE ingested_document ENABLE ROW LEVEL SECURITY;
CREATE POLICY ingested_document_tenant ON ingested_document
  USING (EXISTS (SELECT 1 FROM vessel v WHERE v.vessel_id = ingested_document.vessel_id));

-- (The ledger's `subject_ref` lookup key already exists — 0010 added it, with
-- its index and its outside-the-hash-chain rationale.)

-- A distributed package's test verb — the gate its segments are proven with
-- ("leak-tested", "megger-tested"). Carried as data because an HVAC package's
-- gates are not interchangeable with a cableway's, and the phrase appears in
-- served prose.
ALTER TABLE work_order ADD COLUMN test_verb text;

-- A segment's human name ("Main supply trunk — AC-2 to Fr 148"). The code is
-- the key; the label is what a walkthrough reads aloud.
ALTER TABLE work_segment ADD COLUMN label text;

-- -----------------------------------------------------------------------------
-- The rule payload contract, written down (closing 0004's open question).
--
-- `rule_version.trigger_expr` IS the serde-JSON form of
-- `wadl_engine::rules::RuleEntry` — the engine's own shape, versioned with the
-- engine. The structured columns 0004 carries (`result_state`, `max_hops`,
-- `coupling_type_id`) remain as queryable annotations that MUST agree with the
-- payload; the payload is what `rules_in_force` deserializes and hands to
-- `evaluate()`. One shape, owned by the crate that interprets it, so "rules are
-- versioned data" (ADR 0002) has a concrete schema instead of an aspiration.
-- The demo rule set is seeded programmatically from
-- `RuleSet::seed_usn_hot_work()` by `wadl seed`, guaranteeing byte-exact
-- round-trip between what is stored and what the engine was written against.
-- -----------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON hazard, ingested_document TO wadl_app;

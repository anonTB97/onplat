-- =============================================================================
-- 0010 — Recording what a planner decided about a proposed mitigation.
--
-- `wadl_mitigate` proposes; a planner chooses. This is where the choosing is
-- kept, and it is kept in the audit ledger rather than a table of its own for a
-- reason: "we were offered the bus isolation on the 12th and took the coating
-- wait instead" is exactly the kind of statement a board of inquiry asks about,
-- and the ledger is the one structure in this schema that a silent edit cannot
-- pass through.
--
-- No new table. A decision is `audit_entry` with action MITIGATION_ACCEPTED or
-- MITIGATION_REJECTED, and the whole option — the action, the effect as computed
-- at the time, the rule versions the holds fired under, the instant the options
-- were computed for — goes in the hashed `detail`.
--
-- Storing the effect matters. The option was priced under a rule set and a hazard
-- state that will both have moved on by the time anyone asks. Re-deriving "what
-- would this have freed" years later would answer a different question.
-- =============================================================================

-- The ledger's subject columns are `(subject_type, subject_id uuid)`, which
-- cannot name a compartment: a placard number is a string, not a key. Rather than
-- mint surrogate ids for spaces, this adds a text reference.
--
-- It is a lookup index, NOT the record. The authoritative subject is inside the
-- hashed `detail`; this column is outside the hash chain and therefore not
-- trusted — a query narrows with it and then reads the detail. Adding it to the
-- hash would have changed the chain format for every existing entry, which is a
-- migration no append-only ledger should ever need.
ALTER TABLE audit_entry
  ADD COLUMN subject_ref text;

COMMENT ON COLUMN audit_entry.subject_ref IS
  'Denormalised, unhashed lookup key (e.g. a compartment placard). The trusted '
  'value is inside the hashed detail; never read this column as the record.';

-- The query the surface makes: what has been decided about this space, newest
-- first.
CREATE INDEX ON audit_entry (org_id, vessel_id, subject_ref, entry_id DESC);

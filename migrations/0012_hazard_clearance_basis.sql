-- 0012: the basis of an administrative hazard clearance.
--
-- 0011 already modelled the closure itself: `cleared_at` closes a hazard,
-- nothing is deleted, and every read of live hazards filters on it. What it
-- did not carry is WHY the clearing authority considered the field condition
-- resolved — "tags verified hung by shift electrician", "gas-free certificate
-- sighted". That basis is the difference between an administrative clearance
-- and a silent delete: the row stays pointable-at and challengeable after it
-- closes.
--
-- The authoritative record of the clearance is the audit ledger entry
-- (`HAZARD_CLEARED`, hash-chained, with the basis in the hashed detail); this
-- column is the queryable copy on the fact itself, so "why is this hazard
-- closed" never requires a ledger scan.
ALTER TABLE hazard ADD COLUMN cleared_basis text;

-- A closure carries its basis, and an open hazard carries neither. NOT VALID
-- is unnecessary: no deployment has ever written cleared_at, so existing rows
-- (all open) satisfy the constraint as-is.
ALTER TABLE hazard ADD CONSTRAINT hazard_clearance_pairs
  CHECK ((cleared_at IS NULL) = (cleared_basis IS NULL));

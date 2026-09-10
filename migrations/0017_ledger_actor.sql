-- =============================================================================
-- 0017 — A person on every ledger row (pilot barrier B5; POA&M 1 and 6).
--
-- The identity proxy's subject is a string (EDIPI, badge), not a row in
-- `person`; `by_person uuid` stays reserved for a directory-backed person.
-- Rows written before this migration are chain format 1 and keep verifying;
-- rows from now on are format 2 and hash the actor (`wadl_store::ledger`).
-- =============================================================================

ALTER TABLE audit_entry
  ADD COLUMN actor_id      text,
  ADD COLUMN actor_name    text,
  ADD COLUMN chain_version smallint NOT NULL DEFAULT 1 CHECK (chain_version >= 1),
  ADD CONSTRAINT audit_entry_v2_names_a_person CHECK (chain_version = 1 OR actor_id IS NOT NULL);

COMMENT ON COLUMN audit_entry.actor_id IS
  'x-wadl-person as asserted by the identity proxy (dev:… on the shim, system:… for the binary); hashed into entry_hash from chain_version 2';
COMMENT ON COLUMN audit_entry.actor_name IS
  'display name at the time of the row; hashed with actor_id from chain_version 2';
COMMENT ON COLUMN audit_entry.chain_version IS
  'hash chain format: 1 = action/detail/instant (rows before 0017), 2 = plus actor_id and actor_name';

CREATE INDEX ON audit_entry (org_id, actor_id, entry_id DESC);

-- RLS, the append-only grants and the tenant policy are inherited: no new
-- table, and 0007's REVOKE UPDATE/DELETE still governs every column.

-- 0013: the manning book joins the ingested documents.
--
-- Crew planning has two sides. The DEMAND side is computed from the register:
-- a window's scheduled hours divided by the window is the people the schedule
-- implies. The SUPPLY side — how many electricians the yard actually has for
-- this availability, per half-shift — is a yard's claim, and claims enter this
-- platform through import doors or not at all. The manning book is that claim:
-- one line per trade, replaced whole, reverted whole, same consistency unit as
-- the other served documents (0011).
ALTER TABLE ingested_document DROP CONSTRAINT ingested_document_kind_check;
ALTER TABLE ingested_document ADD CONSTRAINT ingested_document_kind_check
  CHECK (kind IN
    ('schedule_of_record','zone_register','budget_book','manning_book'));

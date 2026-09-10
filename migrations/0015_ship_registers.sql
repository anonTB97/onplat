-- 0015: the ship itself joins the ingested documents.
--
-- A hull's compartment register (its decks and spaces) and its coupling
-- register (the physical paths a hazard can travel) entered only as seed
-- rows or owner-role SQL. They are the yard's own claims about its ship, and
-- claims enter through import doors: previewed with findings, committed
-- whole, reverted whole. Once ingested, a register replaces the seeded
-- template for that hull — a yard onboarding its ship is replacing a demo,
-- not annotating it.
ALTER TABLE ingested_document DROP CONSTRAINT ingested_document_kind_check;
ALTER TABLE ingested_document ADD CONSTRAINT ingested_document_kind_check
  CHECK (kind IN
    ('schedule_of_record','zone_register','budget_book','manning_book',
     'geometry_register','compartment_register','coupling_register'));

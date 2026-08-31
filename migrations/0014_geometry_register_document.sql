-- 0014: the geometry register joins the ingested documents.
--
-- A compartment's drawn position was a parse of its placard number — an
-- honest guess, labelled as one. True geometry (forward AND aft boundary
-- frames per space, and the frame bands where each deck physically exists)
-- is a drawing's claim, and claims enter through import doors: previewed
-- with findings, committed whole, reverted whole. The design and its truth
-- checks are docs/geometry-accuracy.md.
ALTER TABLE ingested_document DROP CONSTRAINT ingested_document_kind_check;
ALTER TABLE ingested_document ADD CONSTRAINT ingested_document_kind_check
  CHECK (kind IN
    ('schedule_of_record','zone_register','budget_book','manning_book',
     'geometry_register'));

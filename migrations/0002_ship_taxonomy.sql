-- =============================================================================
-- 0002 — Ship taxonomy: the platform's core abstraction.
--
-- CLASS HOLDS THE TEMPLATE, HULL HOLDS THE TRUTH. Compartments, decks and
-- adjacency are authored once per class and inherited; per-hull divergence is a
-- first-class delta, never a fork of the template.
-- =============================================================================

CREATE TABLE ship_class (
  class_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  code            text NOT NULL,            -- 'CVN-68', 'DDG-51 Flt III', 'Type 26'
  name            text NOT NULL,
  hull_type       text,                     -- CVN, DDG, LPD, SSN, FFG ...
  -- Compartment numbering is NOT universal. A USN hull uses deck-frame-side-usage;
  -- a RN hull does not. The platform stores the convention and parses accordingly.
  numbering_scheme text NOT NULL DEFAULT 'usn_deck_frame_side_use',
  numbering_regex text,
  frame_min       integer,
  frame_max       integer,
  UNIQUE (org_id, code)
);

-- Deck levels are per class and ORDERED. Ordering is what makes "the space
-- directly above" computable; a text label cannot be compared.
CREATE TABLE class_deck (
  deck_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id        uuid NOT NULL REFERENCES ship_class(class_id) ON DELETE CASCADE,
  code            text NOT NULL,            -- '03','02','01','1','2','3' ...
  label           text NOT NULL,            -- 'Third Deck'
  ordinal         integer NOT NULL,         -- ascending downward
  UNIQUE (class_id, code),
  UNIQUE (class_id, ordinal)
);

CREATE TABLE vessel (
  vessel_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  class_id        uuid NOT NULL REFERENCES ship_class(class_id),
  hull_no         text NOT NULL,            -- 'CVN-73'
  name            text,                     -- 'USS George Washington'
  delivered_on    date,
  UNIQUE (org_id, hull_no)
);

-- The class-level compartment template. Authored once, inherited by every hull.
CREATE TABLE class_compartment (
  class_comp_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id        uuid NOT NULL REFERENCES ship_class(class_id) ON DELETE CASCADE,
  compartment_no  text NOT NULL,            -- as printed on the placard
  deck_id         uuid REFERENCES class_deck(deck_id),
  frame_fwd       numeric,
  frame_aft       numeric,
  side            text,
  usage_code      text,                     -- Q, E, L, M, A, C, T, W, F ...
  category        text,                     -- CATEGORY, not the letter, decides secure status
  name            text,
  zone            text,
  UNIQUE (class_id, compartment_no)
);

-- Per-hull divergence. A row exists ONLY where this hull differs from its class.
CREATE TABLE vessel_compartment (
  vessel_comp_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id       uuid NOT NULL REFERENCES vessel(vessel_id) ON DELETE CASCADE,
  class_comp_id   uuid REFERENCES class_compartment(class_comp_id),
  compartment_no  text NOT NULL,
  delta_kind      text NOT NULL CHECK (delta_kind IN ('added','removed','renamed','recategorised','modified')),
  delta_reason    text,                     -- e.g. 'converted to berthing in DPIA-24'
  effective_from  date NOT NULL DEFAULT CURRENT_DATE,
  category        text,
  name            text,
  is_secure       boolean,                  -- REQ-054, admin-controlled per hull
  UNIQUE (vessel_id, compartment_no, effective_from)
);

-- Deferred foreign keys: vessel_grant and person_assignment were declared in
-- 0001, before vessel existed. Adding them now keeps tenancy readable first.
ALTER TABLE vessel_grant
  ADD CONSTRAINT vessel_grant_vessel_fk FOREIGN KEY (vessel_id) REFERENCES vessel(vessel_id) ON DELETE CASCADE;
ALTER TABLE person_assignment
  ADD CONSTRAINT person_assignment_vessel_fk FOREIGN KEY (vessel_id) REFERENCES vessel(vessel_id) ON DELETE CASCADE;

-- -----------------------------------------------------------------------------
-- Row-level security.
-- -----------------------------------------------------------------------------

ALTER TABLE ship_class ENABLE ROW LEVEL SECURITY;
CREATE POLICY ship_class_tenant ON ship_class
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE class_deck ENABLE ROW LEVEL SECURITY;
CREATE POLICY class_deck_tenant ON class_deck
  USING (EXISTS (SELECT 1 FROM ship_class c WHERE c.class_id = class_deck.class_id));

-- A hull is visible to its owning org OR to any org holding a live grant.
ALTER TABLE vessel ENABLE ROW LEVEL SECURITY;
CREATE POLICY vessel_tenant ON vessel
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
         OR EXISTS (SELECT 1 FROM vessel_grant g
                    WHERE g.vessel_id = vessel.vessel_id
                      AND g.org_id = NULLIF(current_setting('app.org_id', true), '')::uuid
                      AND g.revoked_at IS NULL));

ALTER TABLE class_compartment ENABLE ROW LEVEL SECURITY;
CREATE POLICY class_compartment_tenant ON class_compartment
  USING (EXISTS (SELECT 1 FROM ship_class c WHERE c.class_id = class_compartment.class_id));

ALTER TABLE vessel_compartment ENABLE ROW LEVEL SECURITY;
CREATE POLICY vessel_compartment_tenant ON vessel_compartment
  USING (EXISTS (SELECT 1 FROM vessel v WHERE v.vessel_id = vessel_compartment.vessel_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wadl_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wadl_app;

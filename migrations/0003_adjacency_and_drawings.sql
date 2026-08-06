-- =============================================================================
-- 0003 — Adjacency (the semantics, not the geometry) and drawings.
-- =============================================================================

-- Coupling types are tenant-configurable because what counts as coupled is a
-- safety judgement, not a physical fact.
CREATE TABLE coupling_type (
  coupling_type_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  code            text NOT NULL,            -- shared_bulkhead, deck_penetration, ...
  label           text NOT NULL,
  directional     boolean NOT NULL,         -- deck penetration: yes. bulkhead: no.
  propagates      text[] NOT NULL,          -- {'heat','vapour','energy','load','egress'}
  default_max_hops integer NOT NULL DEFAULT 1,
  decays          boolean NOT NULL DEFAULT false,
  breakable_by    text[],                   -- {'closed_damper','isolated_branch','blank'}
  UNIQUE (org_id, code)
);

-- Class-level edges. Directed: for a symmetric coupling, insert both directions.
CREATE TABLE class_coupling (
  class_coupling_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id        uuid NOT NULL REFERENCES ship_class(class_id) ON DELETE CASCADE,
  from_comp_id    uuid NOT NULL REFERENCES class_compartment(class_comp_id) ON DELETE CASCADE,
  to_comp_id      uuid NOT NULL REFERENCES class_compartment(class_comp_id) ON DELETE CASCADE,
  coupling_type_id uuid NOT NULL REFERENCES coupling_type(coupling_type_id),
  strength        numeric DEFAULT 1.0,
  note            text,
  UNIQUE (class_id, from_comp_id, to_comp_id, coupling_type_id)
);

-- Per-hull overrides. 'suppressed' removes an inherited class edge.
CREATE TABLE vessel_coupling_override (
  override_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id       uuid NOT NULL REFERENCES vessel(vessel_id) ON DELETE CASCADE,
  from_comp_no    text NOT NULL,
  to_comp_no      text NOT NULL,
  coupling_type_id uuid NOT NULL REFERENCES coupling_type(coupling_type_id),
  action          text NOT NULL CHECK (action IN ('added','suppressed','modified')),
  reason          text NOT NULL,
  authorised_by   uuid REFERENCES person(person_id),
  effective_from  date NOT NULL DEFAULT CURRENT_DATE
);

-- A crew may challenge a derived adjacency but never delete it (rule R14). The
-- edge stays live while an approver rules on the challenge.
CREATE TABLE coupling_challenge (
  challenge_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id       uuid NOT NULL REFERENCES vessel(vessel_id),
  from_comp_no    text NOT NULL,
  to_comp_no      text NOT NULL,
  raised_by       uuid NOT NULL REFERENCES person(person_id),
  raised_at       timestamptz NOT NULL DEFAULT now(),
  rationale       text,
  status          text NOT NULL DEFAULT 'open' CHECK (status IN ('open','upheld','rejected','withdrawn')),
  ruled_by        uuid REFERENCES person(person_id),
  ruled_at        timestamptz
);

CREATE TABLE drawing_set (
  drawing_set_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  class_id        uuid REFERENCES ship_class(class_id),
  vessel_id       uuid REFERENCES vessel(vessel_id),
  title           text NOT NULL,
  discipline      text,
  revision        text,
  issued_on       date,
  source_system   text,
  CHECK (class_id IS NOT NULL OR vessel_id IS NOT NULL)
);

-- REQ-021/022. The deck link lets the app open the right sheet from a
-- compartment number instead of scrolling a thirteen-page set.
CREATE TABLE drawing_sheet (
  sheet_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drawing_set_id  uuid NOT NULL REFERENCES drawing_set(drawing_set_id) ON DELETE CASCADE,
  sheet_no        integer NOT NULL,
  label           text NOT NULL,
  deck_id         uuid REFERENCES class_deck(deck_id),
  file_uri        text NOT NULL,
  mime_type       text NOT NULL,
  width_px        integer,
  height_px       integer,
  georef          jsonb,
  UNIQUE (drawing_set_id, sheet_no)
);

-- -----------------------------------------------------------------------------
-- Row-level security.
-- -----------------------------------------------------------------------------

ALTER TABLE coupling_type ENABLE ROW LEVEL SECURITY;
CREATE POLICY coupling_type_tenant ON coupling_type
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE class_coupling ENABLE ROW LEVEL SECURITY;
CREATE POLICY class_coupling_tenant ON class_coupling
  USING (EXISTS (SELECT 1 FROM ship_class c WHERE c.class_id = class_coupling.class_id));

ALTER TABLE vessel_coupling_override ENABLE ROW LEVEL SECURITY;
CREATE POLICY vessel_coupling_override_tenant ON vessel_coupling_override
  USING (EXISTS (SELECT 1 FROM vessel v WHERE v.vessel_id = vessel_coupling_override.vessel_id));

ALTER TABLE coupling_challenge ENABLE ROW LEVEL SECURITY;
CREATE POLICY coupling_challenge_tenant ON coupling_challenge
  USING (EXISTS (SELECT 1 FROM vessel v WHERE v.vessel_id = coupling_challenge.vessel_id));

ALTER TABLE drawing_set ENABLE ROW LEVEL SECURITY;
CREATE POLICY drawing_set_tenant ON drawing_set
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE drawing_sheet ENABLE ROW LEVEL SECURITY;
CREATE POLICY drawing_sheet_tenant ON drawing_sheet
  USING (EXISTS (SELECT 1 FROM drawing_set d WHERE d.drawing_set_id = drawing_sheet.drawing_set_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wadl_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wadl_app;

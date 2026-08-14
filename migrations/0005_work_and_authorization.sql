-- =============================================================================
-- 0005 — Work orders, distributed packages, permits and decisions.
--
-- AUTHORIZATION IS MANY-TO-MANY WITH SPACE. One permit covers N compartments;
-- one compartment carries N permits. permit_space is where the queries live.
-- =============================================================================

CREATE TABLE availability (
  availability_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id       uuid NOT NULL REFERENCES vessel(vessel_id),
  code            text NOT NULL,            -- 'PIA-26'
  kind            text,                     -- new construction, PIA, SRA, DPIA ...
  location        text,
  start_on        date,
  end_on          date,
  UNIQUE (vessel_id, code)
);

CREATE TABLE work_order (
  work_order_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  availability_id uuid NOT NULL REFERENCES availability(availability_id),
  code            text NOT NULL,            -- WI / WO number
  title           text NOT NULL,
  system          text,
  trade           text,
  is_distributed  boolean NOT NULL DEFAULT false,
  source_ref      text,                     -- provenance: the document it came from
  source_verified boolean NOT NULL DEFAULT false,
  UNIQUE (availability_id, code)
);

-- Segments of a distributed package, with upstream topology. This is what makes
-- "you cannot test this until everything upstream is complete" computable.
CREATE TABLE work_segment (
  segment_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_order_id   uuid NOT NULL REFERENCES work_order(work_order_id) ON DELETE CASCADE,
  code            text NOT NULL,            -- 'T1', 'B2'
  kind            text,                     -- trunk, branch, riser, run, header
  upstream_id     uuid REFERENCES work_segment(segment_id),
  UNIQUE (work_order_id, code)
);

CREATE TABLE work_segment_space (
  segment_id      uuid NOT NULL REFERENCES work_segment(segment_id) ON DELETE CASCADE,
  compartment_no  text NOT NULL,
  budget_hours    numeric NOT NULL DEFAULT 0,
  earned_hours    numeric NOT NULL DEFAULT 0,
  PRIMARY KEY (segment_id, compartment_no)
);

CREATE TYPE permit_status AS ENUM
  ('draft','submitted','pending_gf','pending_fm','approved','active',
   'suspended','hold','rejected','withdrawn','complete','closed');

CREATE TABLE permit (
  permit_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id       uuid NOT NULL REFERENCES vessel(vessel_id),
  availability_id uuid REFERENCES availability(availability_id),
  work_order_id   uuid REFERENCES work_order(work_order_id),
  code            text NOT NULL,            -- 'HW-1043'
  work_type       text NOT NULL,
  status          permit_status NOT NULL DEFAULT 'draft',
  priority        text CHECK (priority IN ('High','Medium','Low')),
  -- REQ-008/019/045: the window is chosen, bounded, and has an explicit end.
  permit_date     date NOT NULL,
  shift_code      text NOT NULL,
  starts_at       timestamptz NOT NULL,
  ends_at         timestamptz NOT NULL,
  raised_by       uuid NOT NULL REFERENCES person(person_id),
  raised_at       timestamptz NOT NULL DEFAULT now(),
  fire_watch_id   uuid REFERENCES person(person_id),
  fire_watch_credential_id uuid,
  extinguisher_id uuid,
  note            text,                     -- REQ-018
  UNIQUE (vessel_id, code)
);

CREATE INDEX ON permit (vessel_id, status);
CREATE INDEX ON permit (starts_at, ends_at);

-- THE central join. A permit covers many spaces; each keeps its own decision.
CREATE TABLE permit_space (
  permit_id       uuid NOT NULL REFERENCES permit(permit_id) ON DELETE CASCADE,
  compartment_no  text NOT NULL,
  role            text NOT NULL CHECK (role IN ('primary','certification_set','added_by_crew')),
  source          text NOT NULL CHECK (source IN ('model','crew')),   -- REQ-007
  challenged      boolean NOT NULL DEFAULT false,
  current_state   decision_state,
  PRIMARY KEY (permit_id, compartment_no)
);

CREATE INDEX ON permit_space (compartment_no);

-- Every evaluation, kept. rule_version_id is why a 2027 decision is explainable
-- in 2031.
CREATE TABLE decision_event (
  decision_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id       uuid NOT NULL REFERENCES permit(permit_id) ON DELETE CASCADE,
  compartment_no  text,
  rule_version_id uuid REFERENCES rule_version(rule_version_id),
  state           decision_state NOT NULL,
  hop_depth       integer,
  source_comp_no  text,
  path            text[],
  reason          text NOT NULL,
  earliest_clear  timestamptz,
  evaluated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX ON decision_event (permit_id, evaluated_at DESC);

CREATE TABLE permit_approval (
  approval_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id       uuid NOT NULL REFERENCES permit(permit_id) ON DELETE CASCADE,
  node            text NOT NULL,            -- 'gforeman', 'marshal'
  action          text NOT NULL CHECK (action IN ('approved','rejected','refused_by_engine')),
  by_person       uuid NOT NULL REFERENCES person(person_id),
  persona_id      uuid REFERENCES persona(persona_id),
  reason          text,
  at              timestamptz NOT NULL DEFAULT now()
);

-- REQ-055. Designation inserts the Fire Marshal into the path for a date range.
CREATE TABLE space_designation (
  designation_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id       uuid NOT NULL REFERENCES vessel(vessel_id),
  compartment_no  text NOT NULL,
  kind            text NOT NULL DEFAULT 'designated' CHECK (kind IN ('designated','secure')),
  reason          text NOT NULL,
  from_date       date NOT NULL,
  to_date         date NOT NULL,
  set_by          uuid NOT NULL REFERENCES person(person_id),
  set_at          timestamptz NOT NULL DEFAULT now(),
  lifted_at       timestamptz
);

CREATE INDEX ON space_designation (vessel_id, compartment_no, from_date, to_date);

-- -----------------------------------------------------------------------------
-- Row-level security. Work scopes through availability -> vessel; permits and
-- their children scope through permit -> vessel.
-- -----------------------------------------------------------------------------

ALTER TABLE availability ENABLE ROW LEVEL SECURITY;
CREATE POLICY availability_tenant ON availability
  USING (EXISTS (SELECT 1 FROM vessel v WHERE v.vessel_id = availability.vessel_id));

ALTER TABLE work_order ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_order_tenant ON work_order
  USING (EXISTS (SELECT 1 FROM availability a WHERE a.availability_id = work_order.availability_id));

ALTER TABLE work_segment ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_segment_tenant ON work_segment
  USING (EXISTS (SELECT 1 FROM work_order w WHERE w.work_order_id = work_segment.work_order_id));

ALTER TABLE work_segment_space ENABLE ROW LEVEL SECURITY;
CREATE POLICY work_segment_space_tenant ON work_segment_space
  USING (EXISTS (SELECT 1 FROM work_segment s WHERE s.segment_id = work_segment_space.segment_id));

ALTER TABLE permit ENABLE ROW LEVEL SECURITY;
CREATE POLICY permit_tenant ON permit
  USING (EXISTS (SELECT 1 FROM vessel v WHERE v.vessel_id = permit.vessel_id));

ALTER TABLE permit_space ENABLE ROW LEVEL SECURITY;
CREATE POLICY permit_space_tenant ON permit_space
  USING (EXISTS (SELECT 1 FROM permit p WHERE p.permit_id = permit_space.permit_id));

ALTER TABLE decision_event ENABLE ROW LEVEL SECURITY;
CREATE POLICY decision_event_tenant ON decision_event
  USING (EXISTS (SELECT 1 FROM permit p WHERE p.permit_id = decision_event.permit_id));

ALTER TABLE permit_approval ENABLE ROW LEVEL SECURITY;
CREATE POLICY permit_approval_tenant ON permit_approval
  USING (EXISTS (SELECT 1 FROM permit p WHERE p.permit_id = permit_approval.permit_id));

ALTER TABLE space_designation ENABLE ROW LEVEL SECURITY;
CREATE POLICY space_designation_tenant ON space_designation
  USING (EXISTS (SELECT 1 FROM vessel v WHERE v.vessel_id = space_designation.vessel_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wadl_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wadl_app;

-- =============================================================================
-- Shipyard AI Onboard + WADL — platform schema
-- PostgreSQL 15+.  Draft for development. Not validated against a customer.
--
-- FIVE DECISIONS THIS SCHEMA MAKES, stated up front because they are expensive
-- to reverse and everything below follows from them:
--
--  1. ORGANIZATION IS THE TENANT.  Every row that is not public reference data
--     carries org_id and is protected by row-level security. A shipbuilder and
--     a navy are both organizations; they may share a hull without sharing a
--     database view of it (see vessel_grant).
--
--  2. CLASS HOLDS THE TEMPLATE, HULL HOLDS THE TRUTH.  Compartments, decks,
--     adjacency and drawings are authored once per ship_class and inherited by
--     every vessel of that class. Sister ships diverge the day the first one
--     is modified, so divergence is a first-class object (vessel_compartment,
--     vessel_coupling_override) rather than a fork of the template.
--
--  3. RULES ARE DATA, AND VERSIONED.  A rule is a row with an effective range.
--     Every decision records the rule_version it was made under, so a decision
--     from 2027 can still be explained in 2031 after the rule has changed twice.
--     Nothing in application code may hard-code a threshold.
--
--  4. AUTHORIZATION IS MANY-TO-MANY WITH SPACE.  One permit covers N
--     compartments (a distributed package), and one compartment carries N
--     permits. permit_space is where the interesting queries live.
--
--  5. THE LEDGER IS APPEND-ONLY AND HASH-CHAINED.  Nothing is deleted, ever.
--     Supersession is a state, not a DELETE.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- =============================================================================
-- 1. TENANCY AND IDENTITY
-- =============================================================================

CREATE TYPE org_kind AS ENUM ('shipbuilder', 'navy', 'class_society', 'regulator', 'vendor');

CREATE TABLE organization (
  org_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind            org_kind      NOT NULL,
  name            text          NOT NULL,
  country         text,                     -- ISO 3166-1 alpha-3; drives régime defaults
  locale          text          NOT NULL DEFAULT 'en',
  created_at      timestamptz   NOT NULL DEFAULT now()
);

-- A yard and its customer navy both need to see the same hull, with different
-- authority. Granting is explicit and revocable, never implied by ownership.
CREATE TABLE vessel_grant (
  vessel_id       uuid NOT NULL,
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  access          text NOT NULL CHECK (access IN ('owner','operator','read','audit')),
  granted_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at      timestamptz,
  PRIMARY KEY (vessel_id, org_id)
);

CREATE TABLE person (
  person_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  full_name       text NOT NULL,
  badge_no        text,                     -- yard badge; unique per org, not globally
  department      text,
  phone_ext       text,                     -- REQ-028: an audit name is only useful if reachable
  email           text,
  active          boolean NOT NULL DEFAULT true,
  UNIQUE (org_id, badge_no)
);

-- Personas are tenant-configurable. The six in the prototype are a seed, not a
-- fixed set — a navy's rank structure is not a yard's shop structure.
CREATE TABLE persona (
  persona_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  code            text NOT NULL,            -- 'foreman', 'gforeman', 'marshal', ...
  label           text NOT NULL,
  description     text,
  UNIQUE (org_id, code)
);

-- Capabilities are named, not numbered. A numeric "access level" cannot express
-- "may stop work anywhere but may not approve a permit".
CREATE TABLE persona_capability (
  persona_id      uuid NOT NULL REFERENCES persona(persona_id) ON DELETE CASCADE,
  capability      text NOT NULL,            -- raise_permit, approve_gf, approve_fm,
                                            -- set_priority, designate_space, stop_work,
                                            -- disposition_hold_point, second_attest,
                                            -- admin_users, read_only
  PRIMARY KEY (persona_id, capability)
);

-- Assignment is per person PER VESSEL. The same foreman may be a foreman on one
-- hull and have no access to the next berth. This table is the RBAC spine.
CREATE TABLE person_assignment (
  person_id       uuid NOT NULL REFERENCES person(person_id) ON DELETE CASCADE,
  vessel_id       uuid NOT NULL,
  persona_id      uuid NOT NULL REFERENCES persona(persona_id),
  effective_from  date NOT NULL DEFAULT CURRENT_DATE,
  effective_to    date,
  PRIMARY KEY (person_id, vessel_id, persona_id, effective_from)
);

-- =============================================================================
-- 2. SHIP TAXONOMY — the platform's core abstraction
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
  numbering_regex text,                     -- for schemes the platform cannot infer
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
  ordinal         integer NOT NULL,         -- ascending downward; the only reliable
                                            -- way to answer "above" and "below"
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
  side            text,                     -- port / stbd / centreline, or scheme-specific
  usage_code      text,                     -- Q, E, L, M, A, C, T, W, F ...
  category        text,                     -- 'Ammunition', 'Machinery / electrical', ...
                                            -- CATEGORY, not the letter, decides secure
                                            -- status and hazard defaults.
  name            text,
  zone            text,
  UNIQUE (class_id, compartment_no)
);

-- Per-hull divergence. A row exists ONLY where this hull differs from its class,
-- so a fleet of twelve sister ships is one template plus twelve small deltas.
CREATE TABLE vessel_compartment (
  vessel_comp_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id       uuid NOT NULL REFERENCES vessel(vessel_id) ON DELETE CASCADE,
  class_comp_id   uuid REFERENCES class_compartment(class_comp_id),
  compartment_no  text NOT NULL,            -- may differ from the class template
  delta_kind      text NOT NULL CHECK (delta_kind IN ('added','removed','renamed','recategorised','modified')),
  delta_reason    text,                     -- e.g. 'converted to berthing in DPIA-24'
  effective_from  date NOT NULL DEFAULT CURRENT_DATE,
  category        text,
  name            text,
  is_secure       boolean,                  -- REQ-054, admin-controlled per hull
  UNIQUE (vessel_id, compartment_no, effective_from)
);

-- Deferred foreign keys: both tables are declared in section 1, before vessel
-- exists in section 2. Adding them here rather than reordering keeps tenancy and
-- identity readable as the first thing in the file.
ALTER TABLE vessel_grant
  ADD CONSTRAINT vessel_grant_vessel_fk FOREIGN KEY (vessel_id) REFERENCES vessel(vessel_id) ON DELETE CASCADE;
ALTER TABLE person_assignment
  ADD CONSTRAINT person_assignment_vessel_fk FOREIGN KEY (vessel_id) REFERENCES vessel(vessel_id) ON DELETE CASCADE;

-- =============================================================================
-- 3. ADJACENCY — the semantics, not the geometry
-- =============================================================================

-- Coupling types are tenant-configurable because what counts as coupled is a
-- safety judgement, not a physical fact. See the adjacency taxonomy in the
-- Development Steering Pack for the ten seeded types.
CREATE TABLE coupling_type (
  coupling_type_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  code            text NOT NULL,            -- shared_bulkhead, deck_penetration,
                                            -- exhaust_trunk, supply_branch, bilge,
                                            -- electrical_bus, load_path, access,
                                            -- pressure_boundary
  label           text NOT NULL,
  directional     boolean NOT NULL,         -- deck penetration: yes. bulkhead: no.
  propagates      text[] NOT NULL,          -- {'heat','vapour','energy','load','egress'}
  default_max_hops integer NOT NULL DEFAULT 1,
  decays          boolean NOT NULL DEFAULT false,   -- does severity fall with distance?
  breakable_by    text[],                   -- {'closed_damper','isolated_branch','blank'}
  UNIQUE (org_id, code)
);

-- Class-level edges. Directed: for a symmetric coupling, insert both directions
-- (explicitly, so a query never has to remember which way round it was stored).
CREATE TABLE class_coupling (
  class_coupling_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  class_id        uuid NOT NULL REFERENCES ship_class(class_id) ON DELETE CASCADE,
  from_comp_id    uuid NOT NULL REFERENCES class_compartment(class_comp_id) ON DELETE CASCADE,
  to_comp_id      uuid NOT NULL REFERENCES class_compartment(class_comp_id) ON DELETE CASCADE,
  coupling_type_id uuid NOT NULL REFERENCES coupling_type(coupling_type_id),
  strength        numeric DEFAULT 1.0,      -- for decaying couplings
  note            text,
  UNIQUE (class_id, from_comp_id, to_comp_id, coupling_type_id)
);

-- Per-hull overrides: a modification that added a penetration, or a bulkhead
-- that was blanked. 'suppressed' removes an inherited class edge.
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
-- challenge is a record an approver rules on; the edge stays live meanwhile.
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

-- =============================================================================
-- 4. DRAWINGS — customer-uploaded, per class or per hull
-- =============================================================================

CREATE TABLE drawing_set (
  drawing_set_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  class_id        uuid REFERENCES ship_class(class_id),
  vessel_id       uuid REFERENCES vessel(vessel_id),   -- hull-specific set, if any
  title           text NOT NULL,
  discipline      text,                     -- 'general arrangement', 'ventilation', 'electrical'
  revision        text,
  issued_on       date,
  source_system   text,                     -- the drawing system of record
  CHECK (class_id IS NOT NULL OR vessel_id IS NOT NULL)
);

-- REQ-021/022. The deck link is what lets the app open the right sheet from a
-- compartment number instead of making someone scroll a thirteen-page set.
CREATE TABLE drawing_sheet (
  sheet_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  drawing_set_id  uuid NOT NULL REFERENCES drawing_set(drawing_set_id) ON DELETE CASCADE,
  sheet_no        integer NOT NULL,
  label           text NOT NULL,
  deck_id         uuid REFERENCES class_deck(deck_id),   -- null for non-deck sheets
  file_uri        text NOT NULL,            -- object storage key
  mime_type       text NOT NULL,
  width_px        integer,
  height_px       integer,
  -- Affine transform from sheet pixels to frame/offset, so a compartment can be
  -- pinned on the drawing. Null until someone registers the sheet.
  georef          jsonb,
  UNIQUE (drawing_set_id, sheet_no)
);

-- =============================================================================
-- 5. STANDARDS REGISTRY
-- =============================================================================

-- Public reference tier: org_id NULL means "known to the platform", and a tenant
-- may shadow any row with its own. Editions matter more than titles.
CREATE TABLE standard (
  standard_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid REFERENCES organization(org_id),
  code            text NOT NULL,            -- 'MIL-STD-2035'
  title           text NOT NULL,
  issuing_body    text,                     -- NAVSEA, ASTM, NFPA, IACS member ...
  regime          text                      -- 'usn', 'uk_mod', 'class_society' ...
);

CREATE TABLE standard_edition (
  edition_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  standard_id     uuid NOT NULL REFERENCES standard(standard_id) ON DELETE CASCADE,
  edition         text NOT NULL,            -- 'Rev. A', '2021'
  effective_from  date,
  superseded_on   date,
  document_uri    text,
  UNIQUE (standard_id, edition)
);

-- Which edition THIS contract invokes — which is frequently not the newest.
CREATE TABLE contract_standard (
  contract_id     uuid NOT NULL,
  edition_id      uuid NOT NULL REFERENCES standard_edition(edition_id),
  invoked_by      text,                     -- spec tree reference
  PRIMARY KEY (contract_id, edition_id)
);

-- =============================================================================
-- 6. RULES AS DATA
-- =============================================================================

CREATE TYPE decision_state AS ENUM ('ALLOW','WARN','BLOCK','SUSPEND');

CREATE TABLE rule (
  rule_id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  code            text NOT NULL,            -- 'R03'
  name            text NOT NULL,
  kind            text NOT NULL CHECK (kind IN
                    ('hazard_cascade','authorization_gate','completeness_gate',
                     'evidence_gate','itp_gate','temporal_gate','governance')),
  UNIQUE (org_id, code)
);

-- The version is the unit of truth. Editing a rule creates a new version; the
-- old one is retained so historical decisions remain explainable.
CREATE TABLE rule_version (
  rule_version_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_id         uuid NOT NULL REFERENCES rule(rule_id) ON DELETE CASCADE,
  version_no      integer NOT NULL,
  effective_from  timestamptz NOT NULL,
  effective_to    timestamptz,
  trigger_expr    jsonb NOT NULL,           -- structured predicate, not code
  coupling_type_id uuid REFERENCES coupling_type(coupling_type_id),
  max_hops        integer,
  result_state    decision_state NOT NULL,
  clearing_expr   jsonb NOT NULL,
  clearing_authority text,                  -- 'marine_chemist', 'isolation_authority' ...
  authority_edition_id uuid REFERENCES standard_edition(edition_id),
  waivable        boolean NOT NULL DEFAULT false,   -- hazard cascades: false
  params          jsonb NOT NULL DEFAULT '{}',      -- thresholds, hold minutes
  approved_by     uuid REFERENCES person(person_id),
  approved_at     timestamptz,
  UNIQUE (rule_id, version_no)
);

CREATE INDEX ON rule_version (rule_id, effective_from DESC);

-- Which rules apply to which work, per class. A yard that does not do
-- radiography does not carry radiography rules.
CREATE TABLE rule_binding (
  binding_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_version_id uuid NOT NULL REFERENCES rule_version(rule_version_id) ON DELETE CASCADE,
  class_id        uuid REFERENCES ship_class(class_id),
  work_type       text,                     -- hot_work, cold_work, rt, confined_entry ...
  category        text                      -- compartment category filter
);

-- Surrogate key above, uniqueness here: all three qualifiers are nullable
-- (null = "applies to every class / work type / category"), and a PRIMARY KEY
-- cannot be null. Expressions are legal in an index but not in a table
-- constraint, which is why this is not simply a UNIQUE(...) on the table.
CREATE UNIQUE INDEX rule_binding_uq ON rule_binding (
  rule_version_id,
  COALESCE(class_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(work_type, ''),
  COALESCE(category, '')
);

-- =============================================================================
-- 7. WORK AND AUTHORIZATION
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
  is_distributed  boolean NOT NULL DEFAULT false,   -- spans many compartments
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

-- Every evaluation, kept. This is the rule trace the field app renders and the
-- board of inquiry reads. rule_version_id is why a 2027 decision is explainable
-- in 2031.
CREATE TABLE decision_event (
  decision_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id       uuid NOT NULL REFERENCES permit(permit_id) ON DELETE CASCADE,
  compartment_no  text,
  rule_version_id uuid REFERENCES rule_version(rule_version_id),
  state           decision_state NOT NULL,
  hop_depth       integer,
  source_comp_no  text,                     -- where the hazard originated
  path            text[],                   -- the compartments traversed
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

-- =============================================================================
-- 8. CREDENTIALS AND CERTIFICATES
-- =============================================================================

CREATE TABLE credential_type (
  credential_type_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  code            text NOT NULL,            -- 'FW', 'VT', 'RT', 'ISO'
  label           text NOT NULL,
  levels          text[],                   -- {'I','II','III'}
  UNIQUE (org_id, code)
);

CREATE TABLE credential (
  credential_id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  person_id       uuid NOT NULL REFERENCES person(person_id) ON DELETE CASCADE,
  credential_type_id uuid NOT NULL REFERENCES credential_type(credential_type_id),
  reference       text NOT NULL,            -- 'FW-2291'
  level           text,
  scope           text[],                   -- methods/materials it covers
  issued_on       date NOT NULL,
  expires_on      date,
  suspended_at    timestamptz,
  UNIQUE (person_id, reference)
);

CREATE INDEX ON credential (expires_on);

-- Gas-free and similar certificates are per space with a validity window and a
-- retest clock. Their expiry drives rules, so they are not documents but data.
CREATE TABLE space_certificate (
  certificate_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id       uuid NOT NULL REFERENCES vessel(vessel_id),
  compartment_no  text NOT NULL,
  kind            text NOT NULL,            -- 'gas_free', 'entry', 'hot_work'
  reference       text NOT NULL,            -- 'MC-104'
  issued_by       uuid REFERENCES person(person_id),
  issued_at       timestamptz NOT NULL,
  valid_until     timestamptz NOT NULL,
  retest_due_at   timestamptz,
  voided_at       timestamptz,
  void_reason     text
);

CREATE INDEX ON space_certificate (vessel_id, compartment_no, valid_until);

CREATE TABLE equipment (
  equipment_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  kind            text NOT NULL,            -- 'extinguisher'
  reference       text NOT NULL,            -- 'FB-1180'
  spec            text,                     -- 'CO2 15 lb'
  last_test_on    date,
  next_test_due   date,
  UNIQUE (org_id, reference)
);

-- =============================================================================
-- 9. ITP, INSPECTION AND EVIDENCE
-- =============================================================================

CREATE TABLE inspection_plan (
  itp_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id       uuid REFERENCES vessel(vessel_id),
  class_id        uuid REFERENCES ship_class(class_id),
  code            text NOT NULL,
  title           text NOT NULL,
  contract_id     uuid,
  CHECK (vessel_id IS NOT NULL OR class_id IS NOT NULL)
);

CREATE TABLE inspection_point (
  point_id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  itp_id          uuid NOT NULL REFERENCES inspection_plan(itp_id) ON DELETE CASCADE,
  work_order_id   uuid REFERENCES work_order(work_order_id),
  code            text NOT NULL,            -- 'IP-4471-r'
  compartment_no  text,
  point_type      text NOT NULL CHECK (point_type IN ('hold','witness','review')),
  discipline      text NOT NULL,            -- VT, RT, UT, MT, PT, DFT
  min_level       text,                     -- 'II'
  attribute       text,                     -- 'pressure boundary', 'structural'
  second_attest_required boolean NOT NULL DEFAULT false,
  acceptance_edition_id uuid REFERENCES standard_edition(edition_id),
  method_edition_id     uuid REFERENCES standard_edition(edition_id),
  -- Method and acceptance are DIFFERENT standards and a disposition must cite
  -- both. Systems that model one produce packages that fail review.
  status          text NOT NULL DEFAULT 'armed'
                  CHECK (status IN ('armed','accepted','accepted_with_note',
                                    'pending_attest','rework','rejected','superseded')),
  UNIQUE (itp_id, code)
);

CREATE TABLE disposition (
  disposition_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  point_id        uuid NOT NULL REFERENCES inspection_point(point_id) ON DELETE CASCADE,
  choice          text NOT NULL CHECK (choice IN ('accept','accept_with_note','rework','reject')),
  by_person       uuid NOT NULL REFERENCES person(person_id),
  by_credential   uuid NOT NULL REFERENCES credential(credential_id),
  -- The credential's validity AT SIGNING, denormalised deliberately: a
  -- disposition signed on a credential that later lapses is still valid, and
  -- one signed on a credential that had already lapsed never was.
  credential_valid_at_signing boolean NOT NULL,
  note            text,
  signed_at       timestamptz NOT NULL DEFAULT now(),
  provisional     boolean NOT NULL DEFAULT false,   -- captured offline
  synced_at       timestamptz,
  superseded_by   uuid REFERENCES disposition(disposition_id)
);

CREATE TABLE second_attest (
  attest_id       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  disposition_id  uuid NOT NULL REFERENCES disposition(disposition_id) ON DELETE CASCADE,
  by_person       uuid NOT NULL REFERENCES person(person_id),
  by_credential   uuid NOT NULL REFERENCES credential(credential_id),
  at              timestamptz NOT NULL DEFAULT now(),
  CHECK (by_person IS NOT NULL)
);

-- In-progress inspection (REQ-047). A stop_work here suspends the activity.
CREATE TABLE inspection_log (
  log_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id       uuid NOT NULL REFERENCES permit(permit_id) ON DELETE CASCADE,
  verdict         text NOT NULL CHECK (verdict IN ('pass','stop_work')),
  by_person       uuid NOT NULL REFERENCES person(person_id),
  by_credential   uuid REFERENCES credential(credential_id),
  note            text,
  at              timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE oqe_item (
  oqe_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id       uuid REFERENCES permit(permit_id) ON DELETE CASCADE,
  point_id        uuid REFERENCES inspection_point(point_id) ON DELETE CASCADE,
  kind            text NOT NULL,            -- photo, signature, certificate_ref,
                                            -- radiograph, reading, disposition,
                                            -- attestation
  sequence_no     integer NOT NULL DEFAULT 1,   -- REQ-016: frames accumulate
  file_uri        text,
  sha256          bytea NOT NULL,
  captured_by     uuid REFERENCES person(person_id),
  captured_at     timestamptz NOT NULL,     -- DEVICE time, preserved through sync
  synced_at       timestamptz,
  device_offline  boolean NOT NULL DEFAULT false,
  superseded_by   uuid REFERENCES oqe_item(oqe_id),   -- never deleted
  CHECK (permit_id IS NOT NULL OR point_id IS NOT NULL)
);

-- REQ-054. Two signatures, two people, in lieu of a photograph in a secure space.
CREATE TABLE site_attestation (
  attestation_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id       uuid NOT NULL REFERENCES permit(permit_id) ON DELETE CASCADE,
  compartment_no  text NOT NULL,
  signer_id       uuid NOT NULL REFERENCES person(person_id),
  signer_credential uuid REFERENCES credential(credential_id),
  signed_at       timestamptz NOT NULL,
  witness_id      uuid REFERENCES person(person_id),
  witness_credential uuid REFERENCES credential(credential_id),
  witnessed_at    timestamptz,
  designation_id  uuid REFERENCES space_designation(designation_id),
  CHECK (witness_id IS NULL OR witness_id <> signer_id)   -- rule R23, in the schema
);

-- =============================================================================
-- 10. COLLABORATION
-- =============================================================================

CREATE TABLE ticket_message (
  message_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id       uuid NOT NULL REFERENCES permit(permit_id) ON DELETE CASCADE,
  node            text NOT NULL,            -- routing node the author spoke at
  by_person       uuid NOT NULL REFERENCES person(person_id),
  body            text NOT NULL,
  written_at      timestamptz NOT NULL,     -- device time
  posted_at       timestamptz,              -- null until synced
  UNIQUE (permit_id, by_person, written_at)
);

-- =============================================================================
-- 11. CONFIGURATION AND HISTORY (PLM)
-- =============================================================================

CREATE TABLE config_baseline (
  baseline_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id       uuid NOT NULL REFERENCES vessel(vessel_id),
  compartment_no  text NOT NULL,
  system          text,
  component       text NOT NULL,
  drawing_ref     text,
  drawing_rev     text,
  installed_by_wo uuid REFERENCES work_order(work_order_id),
  installed_on    date,
  evidence_oqe_id uuid REFERENCES oqe_item(oqe_id),
  attested        boolean NOT NULL DEFAULT false,   -- an honest baseline shows gaps
  superseded_by   uuid REFERENCES config_baseline(baseline_id)
);

CREATE INDEX ON config_baseline (vessel_id, compartment_no);

CREATE TABLE condition_reading (
  reading_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id       uuid NOT NULL REFERENCES vessel(vessel_id),
  compartment_no  text NOT NULL,
  metric          text NOT NULL,            -- 'plate_thickness_mm', 'coating_age_months'
  value           numeric NOT NULL,
  unit            text NOT NULL,
  taken_at        timestamptz NOT NULL,
  availability_id uuid REFERENCES availability(availability_id),
  method_edition_id uuid REFERENCES standard_edition(edition_id)
);

CREATE INDEX ON condition_reading (vessel_id, compartment_no, metric, taken_at);

CREATE TABLE deviation (
  deviation_id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vessel_id       uuid NOT NULL REFERENCES vessel(vessel_id),
  compartment_no  text,
  kind            text NOT NULL CHECK (kind IN ('waiver','departure','liaison_action','engineering_change')),
  reference       text NOT NULL,
  description     text NOT NULL,
  raised_on       date NOT NULL,
  closed_on       date,
  authority       text,
  inherited_from  uuid REFERENCES deviation(deviation_id)   -- carried between periods
);

CREATE TABLE deferred_work (
  deferral_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  from_availability uuid NOT NULL REFERENCES availability(availability_id),
  to_availability uuid REFERENCES availability(availability_id),
  work_order_id   uuid REFERENCES work_order(work_order_id),
  compartment_no  text,
  reason          text NOT NULL,
  man_hours       numeric,
  earliest_window text,
  accepted_at     timestamptz
);

-- =============================================================================
-- 12. AUDIT LEDGER — append-only, hash-chained
-- =============================================================================

CREATE TABLE audit_entry (
  entry_id        bigserial PRIMARY KEY,
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  vessel_id       uuid REFERENCES vessel(vessel_id),
  action          text NOT NULL,            -- ACTIVITY_SUSPENDED, PERMIT_APPROVED ...
  rule_version_id uuid REFERENCES rule_version(rule_version_id),
  subject_type    text,
  subject_id      uuid,
  by_person       uuid REFERENCES person(person_id),
  persona_id      uuid REFERENCES persona(persona_id),
  detail          text NOT NULL,
  occurred_at     timestamptz NOT NULL,     -- device time where applicable
  recorded_at     timestamptz NOT NULL DEFAULT now(),
  prev_hash       bytea,
  entry_hash      bytea NOT NULL
);

CREATE INDEX ON audit_entry (org_id, vessel_id, recorded_at DESC);
CREATE INDEX ON audit_entry (subject_type, subject_id);

REVOKE UPDATE, DELETE ON audit_entry FROM PUBLIC;

-- =============================================================================
-- 13. INGEST PROVENANCE
-- =============================================================================

-- Nothing enters the system without a source. The P6 crosswalk lives here.
CREATE TABLE ingest_run (
  run_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  source_system   text NOT NULL,            -- 'primavera_p6', 'ifs', 'csv_upload'
  source_file     text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz,
  row_count       integer,
  reject_count    integer,
  notes           text
);

CREATE TABLE ingest_field_map (
  map_id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  source_system   text NOT NULL,
  target_field    text NOT NULL,            -- 'compartment_no'
  source_field    text NOT NULL,            -- 'UDF: Compartment' or 'parse:activity_name'
  transform       jsonb,
  reliability     text CHECK (reliability IN ('high','medium','low','theatre')),
  confirmed_by    uuid REFERENCES person(person_id),
  UNIQUE (org_id, source_system, target_field)
);

-- =============================================================================
-- 14. ROW-LEVEL SECURITY
-- =============================================================================
-- Applied to every tenant table. Illustrated on two; replicate for the rest.

ALTER TABLE vessel ENABLE ROW LEVEL SECURITY;
CREATE POLICY vessel_tenant ON vessel
  USING (org_id = current_setting('app.org_id')::uuid
         OR EXISTS (SELECT 1 FROM vessel_grant g
                    WHERE g.vessel_id = vessel.vessel_id
                      AND g.org_id = current_setting('app.org_id')::uuid
                      AND g.revoked_at IS NULL));

ALTER TABLE permit ENABLE ROW LEVEL SECURITY;
CREATE POLICY permit_tenant ON permit
  USING (EXISTS (SELECT 1 FROM vessel v WHERE v.vessel_id = permit.vessel_id));

-- NOTE: RBAC by vessel (person_assignment) is enforced in the application's
-- authorization layer, not here — a policy cannot express "this persona may
-- approve but not designate". Row-level security keeps tenants apart; the
-- capability model keeps people honest inside a tenant.

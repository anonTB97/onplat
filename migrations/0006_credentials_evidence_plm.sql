-- =============================================================================
-- 0006 — Credentials, ITP/evidence, collaboration, and configuration/history.
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
  scope           text[],
  issued_on       date NOT NULL,
  expires_on      date,
  suspended_at    timestamptz,
  UNIQUE (person_id, reference)
);

CREATE INDEX ON credential (expires_on);

-- Gas-free and similar certificates are per space with a validity window and a
-- retest clock. Their expiry drives rules, so they are data, not documents.
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
  min_level       text,
  attribute       text,
  second_attest_required boolean NOT NULL DEFAULT false,
  acceptance_edition_id uuid REFERENCES standard_edition(edition_id),
  method_edition_id     uuid REFERENCES standard_edition(edition_id),
  -- Method and acceptance are DIFFERENT standards and a disposition must cite both.
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
  -- Validity AT SIGNING, denormalised deliberately: a disposition signed on a
  -- credential that later lapses is still valid; one signed on an already-lapsed
  -- credential never was.
  credential_valid_at_signing boolean NOT NULL,
  note            text,
  signed_at       timestamptz NOT NULL DEFAULT now(),
  provisional     boolean NOT NULL DEFAULT false,
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
  kind            text NOT NULL,            -- photo, signature, certificate_ref, ...
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

CREATE TABLE ticket_message (
  message_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  permit_id       uuid NOT NULL REFERENCES permit(permit_id) ON DELETE CASCADE,
  node            text NOT NULL,
  by_person       uuid NOT NULL REFERENCES person(person_id),
  body            text NOT NULL,
  written_at      timestamptz NOT NULL,     -- device time
  posted_at       timestamptz,              -- null until synced
  UNIQUE (permit_id, by_person, written_at)
);

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
  inherited_from  uuid REFERENCES deviation(deviation_id)
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

-- -----------------------------------------------------------------------------
-- Row-level security.
-- -----------------------------------------------------------------------------

ALTER TABLE credential_type ENABLE ROW LEVEL SECURITY;
CREATE POLICY credential_type_tenant ON credential_type
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE credential ENABLE ROW LEVEL SECURITY;
CREATE POLICY credential_tenant ON credential
  USING (EXISTS (SELECT 1 FROM person pe WHERE pe.person_id = credential.person_id));

ALTER TABLE space_certificate ENABLE ROW LEVEL SECURITY;
CREATE POLICY space_certificate_tenant ON space_certificate
  USING (EXISTS (SELECT 1 FROM vessel v WHERE v.vessel_id = space_certificate.vessel_id));

ALTER TABLE equipment ENABLE ROW LEVEL SECURITY;
CREATE POLICY equipment_tenant ON equipment
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE inspection_plan ENABLE ROW LEVEL SECURITY;
CREATE POLICY inspection_plan_tenant ON inspection_plan
  USING (EXISTS (SELECT 1 FROM vessel v WHERE v.vessel_id = inspection_plan.vessel_id)
         OR EXISTS (SELECT 1 FROM ship_class c WHERE c.class_id = inspection_plan.class_id));

ALTER TABLE inspection_point ENABLE ROW LEVEL SECURITY;
CREATE POLICY inspection_point_tenant ON inspection_point
  USING (EXISTS (SELECT 1 FROM inspection_plan p WHERE p.itp_id = inspection_point.itp_id));

ALTER TABLE disposition ENABLE ROW LEVEL SECURITY;
CREATE POLICY disposition_tenant ON disposition
  USING (EXISTS (SELECT 1 FROM inspection_point ip WHERE ip.point_id = disposition.point_id));

ALTER TABLE second_attest ENABLE ROW LEVEL SECURITY;
CREATE POLICY second_attest_tenant ON second_attest
  USING (EXISTS (SELECT 1 FROM disposition d WHERE d.disposition_id = second_attest.disposition_id));

ALTER TABLE inspection_log ENABLE ROW LEVEL SECURITY;
CREATE POLICY inspection_log_tenant ON inspection_log
  USING (EXISTS (SELECT 1 FROM permit p WHERE p.permit_id = inspection_log.permit_id));

ALTER TABLE oqe_item ENABLE ROW LEVEL SECURITY;
CREATE POLICY oqe_item_tenant ON oqe_item
  USING (EXISTS (SELECT 1 FROM permit p WHERE p.permit_id = oqe_item.permit_id)
         OR EXISTS (SELECT 1 FROM inspection_point ip WHERE ip.point_id = oqe_item.point_id));

ALTER TABLE site_attestation ENABLE ROW LEVEL SECURITY;
CREATE POLICY site_attestation_tenant ON site_attestation
  USING (EXISTS (SELECT 1 FROM permit p WHERE p.permit_id = site_attestation.permit_id));

ALTER TABLE ticket_message ENABLE ROW LEVEL SECURITY;
CREATE POLICY ticket_message_tenant ON ticket_message
  USING (EXISTS (SELECT 1 FROM permit p WHERE p.permit_id = ticket_message.permit_id));

ALTER TABLE config_baseline ENABLE ROW LEVEL SECURITY;
CREATE POLICY config_baseline_tenant ON config_baseline
  USING (EXISTS (SELECT 1 FROM vessel v WHERE v.vessel_id = config_baseline.vessel_id));

ALTER TABLE condition_reading ENABLE ROW LEVEL SECURITY;
CREATE POLICY condition_reading_tenant ON condition_reading
  USING (EXISTS (SELECT 1 FROM vessel v WHERE v.vessel_id = condition_reading.vessel_id));

ALTER TABLE deviation ENABLE ROW LEVEL SECURITY;
CREATE POLICY deviation_tenant ON deviation
  USING (EXISTS (SELECT 1 FROM vessel v WHERE v.vessel_id = deviation.vessel_id));

ALTER TABLE deferred_work ENABLE ROW LEVEL SECURITY;
CREATE POLICY deferred_work_tenant ON deferred_work
  USING (EXISTS (SELECT 1 FROM availability a WHERE a.availability_id = deferred_work.from_availability));

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wadl_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wadl_app;

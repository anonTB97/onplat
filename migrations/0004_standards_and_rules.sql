-- =============================================================================
-- 0004 — Standards registry and rules-as-data.
--
-- RULES ARE DATA, AND VERSIONED. A rule is a row with an effective range; every
-- decision records the rule_version it was made under, so a 2027 decision is
-- still explainable in 2031. Nothing in application code hard-codes a threshold.
-- =============================================================================

-- Public reference tier: org_id NULL means "known to the platform", and a tenant
-- may shadow any row with its own.
CREATE TABLE standard (
  standard_id     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid REFERENCES organization(org_id),
  code            text NOT NULL,            -- 'MIL-STD-2035'
  title           text NOT NULL,
  issuing_body    text,
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
  clearing_authority text,
  authority_edition_id uuid REFERENCES standard_edition(edition_id),
  waivable        boolean NOT NULL DEFAULT false,
  params          jsonb NOT NULL DEFAULT '{}',
  approved_by     uuid REFERENCES person(person_id),
  approved_at     timestamptz,
  UNIQUE (rule_id, version_no)
);

CREATE INDEX ON rule_version (rule_id, effective_from DESC);

-- Which rules apply to which work, per class.
CREATE TABLE rule_binding (
  binding_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  rule_version_id uuid NOT NULL REFERENCES rule_version(rule_version_id) ON DELETE CASCADE,
  class_id        uuid REFERENCES ship_class(class_id),
  work_type       text,                     -- hot_work, cold_work, rt, confined_entry ...
  category        text
);

-- Surrogate key above, uniqueness here: all three qualifiers are nullable
-- (null = "applies to everything"), and a PRIMARY KEY cannot be null.
CREATE UNIQUE INDEX rule_binding_uq ON rule_binding (
  rule_version_id,
  COALESCE(class_id, '00000000-0000-0000-0000-000000000000'::uuid),
  COALESCE(work_type, ''),
  COALESCE(category, '')
);

-- -----------------------------------------------------------------------------
-- Row-level security. Standards have a public tier (org_id NULL) any tenant
-- may read; tenant rows are private.
-- -----------------------------------------------------------------------------

ALTER TABLE standard ENABLE ROW LEVEL SECURITY;
CREATE POLICY standard_tenant ON standard
  USING (org_id IS NULL OR org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE standard_edition ENABLE ROW LEVEL SECURITY;
CREATE POLICY standard_edition_tenant ON standard_edition
  USING (EXISTS (SELECT 1 FROM standard s WHERE s.standard_id = standard_edition.standard_id));

ALTER TABLE contract_standard ENABLE ROW LEVEL SECURITY;
CREATE POLICY contract_standard_tenant ON contract_standard
  USING (EXISTS (SELECT 1 FROM standard_edition e WHERE e.edition_id = contract_standard.edition_id));

ALTER TABLE rule ENABLE ROW LEVEL SECURITY;
CREATE POLICY rule_tenant ON rule
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE rule_version ENABLE ROW LEVEL SECURITY;
CREATE POLICY rule_version_tenant ON rule_version
  USING (EXISTS (SELECT 1 FROM rule r WHERE r.rule_id = rule_version.rule_id));

ALTER TABLE rule_binding ENABLE ROW LEVEL SECURITY;
CREATE POLICY rule_binding_tenant ON rule_binding
  USING (EXISTS (SELECT 1 FROM rule_version rv WHERE rv.rule_version_id = rule_binding.rule_version_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wadl_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wadl_app;

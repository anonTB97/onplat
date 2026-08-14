-- =============================================================================
-- 0001 — Tenancy, identity, and the row-level-security baseline.
--
-- This is the first migration and it establishes the security model the rest of
-- the schema inherits, because retrofitting tenant isolation is how a leak ends
-- up in production.
--
-- THE RLS MODEL
--   * ORGANIZATION IS THE TENANT. Every non-reference row is scoped to an org
--     and protected by row-level security.
--   * The application connects as the NON-OWNER role `wadl_app`, for which RLS
--     is enforced. Migrations and seeding run as the table owner, which RLS does
--     not restrict — so seeds are written by the owner, never by `wadl_app`.
--   * The current tenant is carried in the `app.org_id` GUC, set per request /
--     per transaction by the API. Policies read it with the missing-ok form
--     `current_setting('app.org_id', true)`, so an UNSET tenant resolves to NULL
--     and every policy denies by default rather than erroring open.
--   * Child tables with no `org_id` of their own scope THROUGH their parent via
--     an EXISTS subquery; the parent's own policy filters that subquery, so the
--     scoping is transitive and there is one source of truth per hull.
--
--   RBAC (which persona may approve vs designate) is NOT expressed here — a
--   policy cannot say "may approve but not designate". RLS keeps tenants apart;
--   the capability model in the application keeps people honest inside a tenant.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- The application role. Created NOLOGIN; ops attaches a login method out of band.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'wadl_app') THEN
    CREATE ROLE wadl_app NOLOGIN;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO wadl_app;

-- -----------------------------------------------------------------------------
-- Tenancy and identity
-- -----------------------------------------------------------------------------

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
-- The vessel FK is added in 0002, after vessel exists.
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

-- Personas are tenant-configurable. The prototype's set is a seed, not a fixed
-- list — a navy's rank structure is not a yard's shop structure.
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
-- hull and have no access to the next berth. This table is the RBAC spine; the
-- vessel FK is added in 0002.
CREATE TABLE person_assignment (
  person_id       uuid NOT NULL REFERENCES person(person_id) ON DELETE CASCADE,
  vessel_id       uuid NOT NULL,
  persona_id      uuid NOT NULL REFERENCES persona(persona_id),
  effective_from  date NOT NULL DEFAULT CURRENT_DATE,
  effective_to    date,
  PRIMARY KEY (person_id, vessel_id, persona_id, effective_from)
);

-- -----------------------------------------------------------------------------
-- Row-level security for this migration's tables.
-- -----------------------------------------------------------------------------

ALTER TABLE organization ENABLE ROW LEVEL SECURITY;
CREATE POLICY organization_tenant ON organization
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE vessel_grant ENABLE ROW LEVEL SECURITY;
CREATE POLICY vessel_grant_tenant ON vessel_grant
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE person ENABLE ROW LEVEL SECURITY;
CREATE POLICY person_tenant ON person
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE persona ENABLE ROW LEVEL SECURITY;
CREATE POLICY persona_tenant ON persona
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE persona_capability ENABLE ROW LEVEL SECURITY;
CREATE POLICY persona_capability_tenant ON persona_capability
  USING (EXISTS (SELECT 1 FROM persona p WHERE p.persona_id = persona_capability.persona_id));

ALTER TABLE person_assignment ENABLE ROW LEVEL SECURITY;
CREATE POLICY person_assignment_tenant ON person_assignment
  USING (EXISTS (SELECT 1 FROM person pe WHERE pe.person_id = person_assignment.person_id));

GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO wadl_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO wadl_app;

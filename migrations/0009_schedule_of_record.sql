-- =============================================================================
-- 0009 — The schedule of record.
--
-- The time dimension (docs/BACKLOG.md, T-series) reads dated work: a compartment
-- is "held" only if somebody is due in it at the instant being asked about. The
-- in-memory store already serves those windows from its seed; this migration is
-- where they live for real, and where a Primavera P6 export lands.
--
-- Three things are kept apart on purpose, because collapsing them is how a
-- schedule import quietly becomes the authority on things it should not decide:
--
--   p6_activity        what the scheduler's file SAYS, ingested verbatim.
--   p6_relationship    the logic between those activities, also verbatim.
--   work_order.planned_*  what WADL WORKS TO, which a planner has accepted.
--
-- The first two are evidence. The third is the fact the product acts on. A row
-- in `p6_activity` changes nothing about authorization until it is mapped onto a
-- work order, which is the same discipline `source_verified` already applies to
-- provenance: ingested is not confirmed.
--
-- See docs/p6-ingest-schema.md for the field-level mapping and the questions a
-- real planner has to answer before any of it can be trusted.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- What WADL works to.
--
-- Half-open [planned_start, planned_finish), matching `wadl_domain::time::Window`
-- and for the same reason: abutting activities must not both count at the
-- changeover, or "how many man-hours are booked at 1600" answers with two shifts'
-- worth. P6's finish IS the instant work ends, so it maps straight onto the
-- exclusive bound with no fencepost arithmetic.
--
-- Both nullable, and the pair is the unit: a half-dated window cannot bound
-- anything, so the check requires both or neither. Undated work is a real and
-- common condition — a footprint authored against the class before dates were
-- loaded — and the surfaces are built to count it at every instant and label it,
-- rather than hide it.
-- -----------------------------------------------------------------------------
ALTER TABLE work_order
  ADD COLUMN planned_start  timestamptz,
  ADD COLUMN planned_finish timestamptz,
  ADD CONSTRAINT work_order_planned_window_complete
    CHECK ((planned_start IS NULL) = (planned_finish IS NULL)),
  ADD CONSTRAINT work_order_planned_window_ordered
    CHECK (planned_finish IS NULL OR planned_finish > planned_start);

-- Per-compartment dates on a distributed package. A trunk is worked before the
-- branches hanging off it, so a package's footprint moves through the hull over
-- the availability rather than lighting up all at once — the same fact the
-- segment topology already asserts, expressed in time.
ALTER TABLE work_segment_space
  ADD COLUMN planned_start  timestamptz,
  ADD COLUMN planned_finish timestamptz,
  ADD CONSTRAINT work_segment_space_planned_window_complete
    CHECK ((planned_start IS NULL) = (planned_finish IS NULL)),
  ADD CONSTRAINT work_segment_space_planned_window_ordered
    CHECK (planned_finish IS NULL OR planned_finish > planned_start);

-- The two questions asked of these columns are "what is booked at instant T"
-- (deck states, readiness) and "what is booked in this space", so the indexes
-- lead with the window.
CREATE INDEX ON work_order (planned_start, planned_finish);
CREATE INDEX ON work_segment_space (planned_start, planned_finish);
CREATE INDEX ON work_segment_space (compartment_no);

-- -----------------------------------------------------------------------------
-- What the scheduler's file says.
--
-- Ingested verbatim, one row per P6 activity, stamped with the ingest_run it came
-- from (0008). Verbatim matters: when the board and the schedule disagree, the
-- argument is settled by reading what was actually imported, not by re-deriving
-- it from a transform nobody kept.
--
-- Every mapped-out column keeps P6's own name in its comment, because the field
-- that looks obvious is usually the one that is wrong — `target_start_date` is
-- P6's *baseline*, not the date the yard is working to.
-- -----------------------------------------------------------------------------
CREATE TABLE p6_activity (
  p6_activity_id  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  run_id          uuid NOT NULL REFERENCES ingest_run(run_id),
  -- P6 PROJECT.proj_short_name. One project per hull is the assumption; the
  -- crosswalk flags "multiple hulls per project" as a question to settle.
  proj_short_name text NOT NULL,
  -- P6 TASK.task_code — the Activity ID a planner reads aloud. Stable across
  -- baseline re-issues is an ASSUMPTION; if it is regenerated, this is not a key
  -- and re-ingest will duplicate rather than update.
  task_code       text NOT NULL,
  task_name       text NOT NULL,            -- TASK.task_name
  wbs_path        text,                     -- PROJWBS, root-first, '/'-joined
  -- TASK.status_code: TK_NotStart | TK_Active | TK_Complete.
  status_code     text CHECK (status_code IN ('TK_NotStart','TK_Active','TK_Complete')),
  target_start    timestamptz,              -- TASK.target_start_date (baseline)
  target_finish   timestamptz,              -- TASK.target_end_date   (baseline)
  early_start     timestamptz,              -- TASK.early_start_date  (CPM)
  early_finish    timestamptz,              -- TASK.early_end_date    (CPM)
  act_start       timestamptz,              -- TASK.act_start_date    (actual)
  act_finish      timestamptz,              -- TASK.act_end_date      (actual)
  -- TASKRSRC.target_qty summed over the activity's resource assignments.
  budget_work_qty numeric,
  remain_work_qty numeric,
  -- Resolved from a resource assignment or an activity-code prefix; which one is
  -- a per-yard question (crosswalk: Medium).
  trade           text,
  -- The compartment this activity is in — THE dominant risk. Held with its own
  -- reliability grade because it is frequently a UDF, an activity code, or parsed
  -- out of free text, and a parsed value must never be mistaken for an authored
  -- one. `NULL` with a `low` grade is the honest state for "we could not tell".
  compartment_no  text,
  compartment_reliability text NOT NULL DEFAULT 'low'
    CHECK (compartment_reliability IN ('high','medium','low','theatre')),
  -- How many hard date constraints P6 carries on this activity. Reported as a
  -- data-quality metric, per the crosswalk: constraints used in place of logic
  -- hide the sequence, and a schedule driven by constraints cannot be reasoned
  -- about as a network.
  constraint_type text,
  is_milestone    boolean NOT NULL DEFAULT false,
  -- The work order this activity was accepted onto, once a planner mapped it.
  -- NULL means ingested but not yet acted on, which is the default and must stay
  -- visible: unmapped scheduled work is work the product cannot see.
  work_order_id   uuid REFERENCES work_order(work_order_id),
  mapped_by       uuid REFERENCES person(person_id),
  mapped_at       timestamptz,
  UNIQUE (org_id, proj_short_name, task_code, run_id)
);

CREATE INDEX ON p6_activity (org_id, proj_short_name, task_code);
CREATE INDEX ON p6_activity (work_order_id);
-- Finding the scheduled work nobody has mapped yet — the gap between the plan
-- and what the product can act on.
CREATE INDEX ON p6_activity (run_id) WHERE work_order_id IS NULL;

-- -----------------------------------------------------------------------------
-- The logic between activities.
--
-- Needed for sequence-inversion detection: a coating activity scheduled before
-- the hot work whose vapour it will be cured through is a plan that cannot be
-- executed, and it is only visible if the relationships are imported. Kept
-- verbatim, including lag, because a negative lag is itself a finding.
-- -----------------------------------------------------------------------------
CREATE TABLE p6_relationship (
  p6_relationship_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          uuid NOT NULL REFERENCES organization(org_id),
  run_id          uuid NOT NULL REFERENCES ingest_run(run_id),
  proj_short_name text NOT NULL,
  -- TASKPRED.pred_task_id / task_id, resolved to activity codes rather than
  -- P6's internal integer ids, which are not stable across exports.
  pred_task_code  text NOT NULL,
  succ_task_code  text NOT NULL,
  -- TASKPRED.pred_type: PR_FS | PR_SS | PR_FF | PR_SF.
  pred_type       text NOT NULL
    CHECK (pred_type IN ('PR_FS','PR_SS','PR_FF','PR_SF')),
  lag_hours       numeric NOT NULL DEFAULT 0,
  UNIQUE (org_id, proj_short_name, pred_task_code, succ_task_code, pred_type, run_id)
);

CREATE INDEX ON p6_relationship (org_id, proj_short_name, succ_task_code);

-- -----------------------------------------------------------------------------
-- Tenancy. Same shape as every other tenant-scoped table: RLS supplies the org
-- filter so no query has to remember it, and the app role is granted DML.
-- -----------------------------------------------------------------------------
ALTER TABLE p6_activity ENABLE ROW LEVEL SECURITY;
CREATE POLICY p6_activity_tenant ON p6_activity
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

ALTER TABLE p6_relationship ENABLE ROW LEVEL SECURITY;
CREATE POLICY p6_relationship_tenant ON p6_relationship
  USING (org_id = NULLIF(current_setting('app.org_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON p6_activity, p6_relationship TO wadl_app;

-- Seeds the demo world into PostgreSQL, mirroring InMemoryStore::demo() so both
-- stores tell the same story. Idempotent: every insert is ON CONFLICT DO NOTHING
-- keyed on the natural key, so re-seeding a dev database is safe.
--
-- Run as the table OWNER, not as wadl_app: row-level security is enforced for the
-- application role, and a seed that could write across tenants would defeat the
-- policy it is meant to demonstrate.

-- Tenants -------------------------------------------------------------------
INSERT INTO organization (org_id, kind, name, country) VALUES
  ('00000000-0000-0000-0000-000000000001', 'shipbuilder', 'Demo Yard', 'USA'),
  ('00000000-0000-0000-0000-000000000002', 'navy',        'Demo Navy', 'USA')
ON CONFLICT (org_id) DO NOTHING;

-- Classes -------------------------------------------------------------------
INSERT INTO ship_class (class_id, org_id, code, name, hull_type, frame_min, frame_max) VALUES
  ('00000000-0000-0000-0000-0000000c0068', '00000000-0000-0000-0000-000000000001', 'CVN-68', 'Nimitz class', 'CVN', 1, 260),
  ('00000000-0000-0000-0000-0000000c0051', '00000000-0000-0000-0000-000000000001', 'DDG-51 Flt IIA', 'Arleigh Burke class', 'DDG', 1, 140),
  ('00000000-0000-0000-0000-0000000c0017', '00000000-0000-0000-0000-000000000001', 'LPD-17', 'San Antonio class', 'LPD', 1, 160),
  -- The navy tenant authors its own class; the taxonomy is per tenant.
  ('00000000-0000-0000-0000-0000000c9068', '00000000-0000-0000-0000-000000000002', 'CVN-68', 'Nimitz class', 'CVN', 1, 260)
ON CONFLICT (class_id) DO NOTHING;

-- Decks, per class and ORDERED. The ordinal is what makes "directly above"
-- computable; a label cannot be compared.
INSERT INTO class_deck (deck_id, class_id, code, label, ordinal) VALUES
  ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-0000000c0068', 'Main', 'Main Deck',   1),
  ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-0000000c0068', '2nd',  'Second Deck', 2),
  ('00000000-0000-0000-0000-00000000d003', '00000000-0000-0000-0000-0000000c0068', '3rd',  'Third Deck',  3),
  ('00000000-0000-0000-0000-00000000d004', '00000000-0000-0000-0000-0000000c0068', '4th',  'Fourth Deck', 4)
ON CONFLICT (deck_id) DO NOTHING;

-- Hulls ---------------------------------------------------------------------
INSERT INTO vessel (vessel_id, org_id, class_id, hull_no, name) VALUES
  ('00000000-0000-0000-0000-000000000073', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000c0068', 'CVN-73',  'USS George Washington'),
  ('00000000-0000-0000-0000-000000000071', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000c0068', 'CVN-71',  'USS Theodore Roosevelt'),
  ('00000000-0000-0000-0000-000000000075', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000c0068', 'CVN-75',  'USS Harry S. Truman'),
  ('00000000-0000-0000-0000-00000000dd13', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000c0051', 'DDG-113', 'USS John Finn'),
  ('00000000-0000-0000-0000-000000001d28', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-0000000c0017', 'LPD-28',  'USS Fort Lauderdale'),
  -- The navy tenant's hull. The yard must never see this row.
  ('00000000-0000-0000-0000-000000000068', '00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-0000000c9068', 'CVN-68',  'USS Nimitz')
ON CONFLICT (vessel_id) DO NOTHING;

INSERT INTO availability (availability_id, vessel_id, code, kind, location, start_on, end_on) VALUES
  ('00000000-0000-0000-0000-00000000a073', '00000000-0000-0000-0000-000000000073', 'PIA-26',   'PIA',   'Graving Dry Dock 4', '2026-01-05', '2026-09-30'),
  ('00000000-0000-0000-0000-00000000a071', '00000000-0000-0000-0000-000000000071', 'SRA-26',   'SRA',   'Pier 3',             '2026-03-02', '2026-08-14'),
  ('00000000-0000-0000-0000-00000000a075', '00000000-0000-0000-0000-000000000075', 'DPIA-28',  'DPIA',  'Graving Dry Dock 8', '2028-01-10', '2029-02-28'),
  ('00000000-0000-0000-0000-00000000add1', '00000000-0000-0000-0000-00000000dd13', 'DSRA-26',  'DSRA',  'Pier 5',             '2026-02-01', '2026-07-01'),
  ('00000000-0000-0000-0000-00000000a1d2', '00000000-0000-0000-0000-000000001d28', 'PSA-26',   'PSA',   'Pier 7',             '2026-04-01', '2026-10-01'),
  ('00000000-0000-0000-0000-00000000a068', '00000000-0000-0000-0000-000000000068', 'INACT-26', 'INACT', 'Inactive Ships',     '2026-01-01', '2027-01-01')
ON CONFLICT (availability_id) DO NOTHING;

-- Compartment register, authored at CLASS level and inherited by every hull.
-- Category, not the usage letter, decides secure status and hazard defaults.
INSERT INTO class_compartment (class_comp_id, class_id, compartment_no, deck_id, frame_fwd, frame_aft, side, usage_code, category, name, zone) VALUES
  ('00000000-0000-0000-0000-00000000c101', '00000000-0000-0000-0000-0000000c0068', '1-136-0-Q', '00000000-0000-0000-0000-00000000d001', 132, 140, 'centreline', 'Q', 'Machinery / operational',  'Hangar Bay 2',                   'Z4'),
  ('00000000-0000-0000-0000-00000000c102', '00000000-0000-0000-0000-0000000c0068', '1-160-0-Q', '00000000-0000-0000-0000-00000000d001', 156, 164, 'centreline', 'Q', 'Machinery / operational',  'Hangar Bay 2 — riser',           'Z4'),
  ('00000000-0000-0000-0000-00000000c201', '00000000-0000-0000-0000-0000000c0068', '2-152-0-Q', '00000000-0000-0000-0000-00000000d002', 148, 156, 'centreline', 'Q', 'Machinery / operational',  'Scullery',                       'Z2'),
  ('00000000-0000-0000-0000-00000000c202', '00000000-0000-0000-0000-0000000c0068', '2-160-1-Q', '00000000-0000-0000-0000-00000000d002', 156, 164, 'starboard',  'Q', 'Machinery / operational',  'Mess Deck Forward',              'Z2'),
  ('00000000-0000-0000-0000-00000000c203', '00000000-0000-0000-0000-0000000c0068', '2-160-2-Q', '00000000-0000-0000-0000-00000000d002', 156, 164, 'port',       'Q', 'Machinery / operational',  'Berthing 2-160',                 'Z3'),
  ('00000000-0000-0000-0000-00000000c204', '00000000-0000-0000-0000-0000000c0068', '2-176-0-Q', '00000000-0000-0000-0000-00000000d002', 172, 180, 'centreline', 'Q', 'Living',                   'Wardroom',                       'Z7'),
  ('00000000-0000-0000-0000-00000000c301', '00000000-0000-0000-0000-0000000c0068', '3-140-0-Q', '00000000-0000-0000-0000-00000000d003', 136, 144, 'centreline', 'Q', 'Living',                   'Berthing 3-140',                 'Z3'),
  ('00000000-0000-0000-0000-00000000c302', '00000000-0000-0000-0000-0000000c0068', '3-148-0-L', '00000000-0000-0000-0000-00000000d003', 144, 152, 'centreline', 'L', 'Passage',                  'Passage 3-148',                  'Z3'),
  ('00000000-0000-0000-0000-00000000c303', '00000000-0000-0000-0000-0000000c0068', '3-148-2-E', '00000000-0000-0000-0000-00000000d003', 144, 152, 'port',       'E', 'Electrical',               'Switchgear Room No. 2',          'Z3'),
  ('00000000-0000-0000-0000-00000000c304', '00000000-0000-0000-0000-0000000c0068', '3-152-0-Q', '00000000-0000-0000-0000-00000000d003', 148, 156, 'centreline', 'Q', 'Stores',                   'Storeroom 3-152',                'Z3'),
  ('00000000-0000-0000-0000-00000000c305', '00000000-0000-0000-0000-0000000c0068', '3-156-2-Q', '00000000-0000-0000-0000-00000000d003', 152, 160, 'port',       'Q', 'Machinery / electrical',   'Pump Room No. 2',                'Z3'),
  ('00000000-0000-0000-0000-00000000c306', '00000000-0000-0000-0000-0000000c0068', '3-160-2-Q', '00000000-0000-0000-0000-00000000d003', 156, 164, 'port',       'Q', 'Machinery / electrical',   'Pump Room No. 3',                'Z3'),
  ('00000000-0000-0000-0000-00000000c307', '00000000-0000-0000-0000-0000000c0068', '3-164-2-Q', '00000000-0000-0000-0000-00000000d003', 160, 168, 'port',       'Q', 'Machinery / electrical',   'Fan Room 3-164',                 'Z3'),
  ('00000000-0000-0000-0000-00000000c308', '00000000-0000-0000-0000-0000000c0068', '3-172-0-M', '00000000-0000-0000-0000-00000000d003', 168, 176, 'centreline', 'M', 'Machinery / electrical',   'AC Plant No. 2',                 'Z7'),
  ('00000000-0000-0000-0000-00000000c309', '00000000-0000-0000-0000-0000000c0068', '3-184-0-Q', '00000000-0000-0000-0000-00000000d003', 180, 188, 'centreline', 'Q', 'Machinery / electrical',   'Auxiliary Machinery 2',          'Z7'),
  ('00000000-0000-0000-0000-00000000c310', '00000000-0000-0000-0000-0000000c0068', '3-185-0-L', '00000000-0000-0000-0000-00000000d003', 182, 188, 'centreline', 'L', 'Living',                   'CPO Living Space',               'Z7'),
  ('00000000-0000-0000-0000-00000000c311', '00000000-0000-0000-0000-0000000c0068', '3-192-2-E', '00000000-0000-0000-0000-00000000d003', 188, 196, 'port',       'E', 'Command & surveillance',   'IC Room',                        'Z7'),
  ('00000000-0000-0000-0000-00000000c401', '00000000-0000-0000-0000-0000000c0068', '4-102-2-E', '00000000-0000-0000-0000-00000000d004', 100, 104, 'port',       'E', 'Electrical',               'Switchboard Room No. 1',         'Z2'),
  ('00000000-0000-0000-0000-00000000c402', '00000000-0000-0000-0000-0000000c0068', '4-110-2-W', '00000000-0000-0000-0000-00000000d004', 108, 114, 'port',       'W', 'Tanks & voids',            'Reserve Feed Water Tank',        'Z3'),
  ('00000000-0000-0000-0000-00000000c403', '00000000-0000-0000-0000-0000000c0068', '4-120-4-Q', '00000000-0000-0000-0000-00000000d004', 118, 124, 'port',       'Q', 'Machinery / electrical',   'Fan Room',                       'Z3'),
  ('00000000-0000-0000-0000-00000000c404', '00000000-0000-0000-0000-0000000c0068', '4-141-0-C', '00000000-0000-0000-0000-00000000d004', 138, 144, 'centreline', 'C', 'Command & surveillance',   'Aft IC & Gyro Room',             'Z5'),
  ('00000000-0000-0000-0000-00000000c405', '00000000-0000-0000-0000-0000000c0068', '4-149-2-Q', '00000000-0000-0000-0000-00000000d004', 146, 152, 'port',       'Q', 'Machinery / electrical',   'Forced Draft Blower Room No. 3', 'Z5'),
  ('00000000-0000-0000-0000-00000000c406', '00000000-0000-0000-0000-0000000c0068', '4-160-2-Q', '00000000-0000-0000-0000-00000000d004', 156, 164, 'port',       'Q', 'Machinery / electrical',   'Pump Room No. 4',                'Z3'),
  ('00000000-0000-0000-0000-00000000c407', '00000000-0000-0000-0000-0000000c0068', '4-164-2-Q', '00000000-0000-0000-0000-00000000d004', 160, 168, 'port',       'Q', 'Machinery / electrical',   'Fan Room 4-164',                 'Z3')
ON CONFLICT (class_comp_id) DO NOTHING;

-- People and assignment. Assignment is per person PER VESSEL, and it is the RBAC
-- spine: the demo planner is assigned to three of the yard's five hulls, so the
-- other two must be unreachable by any path.
INSERT INTO persona (persona_id, org_id, code, label, description) VALUES
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-000000000001', 'planner', 'Planner', 'Conflicts & sequence'),
  ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-000000000002', 'qa',      'QA',      'Inspection and dispositions')
ON CONFLICT (persona_id) DO NOTHING;

INSERT INTO persona_capability (persona_id, capability) VALUES
  ('00000000-0000-0000-0000-00000000e001', 'raise_permit'),
  ('00000000-0000-0000-0000-00000000e001', 'set_priority'),
  ('00000000-0000-0000-0000-00000000e001', 'stop_work'),
  ('00000000-0000-0000-0000-00000000e002', 'disposition_hold_point')
ON CONFLICT DO NOTHING;

INSERT INTO person (person_id, org_id, full_name, badge_no, department, phone_ext) VALUES
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-000000000001', 'Demo Planner',  'Y-1001', 'Code 300', '5-2100'),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-000000000002', 'Navy Inspector','N-2001', 'SUPSHIP',  '5-9000')
ON CONFLICT (person_id) DO NOTHING;

INSERT INTO person_assignment (person_id, vessel_id, persona_id, effective_from) VALUES
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-000000000073', '00000000-0000-0000-0000-00000000e001', '2026-01-01'),
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-000000000071', '00000000-0000-0000-0000-00000000e001', '2026-01-01'),
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-000000000075', '00000000-0000-0000-0000-00000000e001', '2026-01-01'),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-000000000068', '00000000-0000-0000-0000-00000000e002', '2026-01-01')
ON CONFLICT DO NOTHING;

-- Provenance for everything above: it was seeded, and it says so (invariant 2).
INSERT INTO ingest_run (run_id, org_id, source_system, source_file, row_count, reject_count, notes) VALUES
  ('00000000-0000-0000-0000-000000009001', '00000000-0000-0000-0000-000000000001', 'seed', 'crates/wadl-store/src/pg_seed.sql', NULL, 0,
   'Illustrative / notional demo world. Not customer data.')
ON CONFLICT (run_id) DO NOTHING;

-- =============================================================================
-- Work, packages, topology, and live conditions (POAM-2 closure).
--
-- Mirrors InMemoryStore::demo(), with ONE declared difference: the in-memory
-- demo re-anchors its story on the clock at every boot, while a database's
-- rows are durable facts, so this seed anchors the story on a fixed instant —
-- ANCHOR = 2026-08-10 00:00Z (the sample XER's data date). Windows below are
-- day offsets from that anchor, written as intervals so the offsets stay
-- readable against memory.rs. The demo rule set is NOT here: `wadl seed`
-- writes it programmatically from `RuleSet::seed_usn_hot_work()` so the stored
-- payload round-trips the engine's own serde byte-for-byte (see 0011).
-- =============================================================================

-- The PIA-26 availability must reach past the furthest seeded window (day 130).
UPDATE availability SET end_on = '2027-01-31'
 WHERE availability_id = '00000000-0000-0000-0000-00000000a073';

-- Ordinary work orders: one segment ('S1'), one space carrying the hours.
INSERT INTO work_order (work_order_id, availability_id, code, title, system, trade, is_distributed, source_ref, source_verified, planned_start, planned_finish) VALUES
  ('00000000-0000-0000-0000-000000003318', '00000000-0000-0000-0000-00000000a073', 'WI-3318', 'Reserve feed water tank preservation',    '506 Tanks & Voids',          'Preservation', false, 'AWR 73-26-3318', true,  timestamptz '2026-08-10 00:00Z' + interval '-9 days',  timestamptz '2026-08-10 00:00Z' + interval '4 days'),
  ('00000000-0000-0000-0000-000000003402', '00000000-0000-0000-0000-00000000a073', 'WI-3402', 'Sounding & vent piping modification',     '529 Drainage & Tank Level',  'Mechanical',   false, 'AWR 73-26-3402', true,  timestamptz '2026-08-10 00:00Z' + interval '5 days',   timestamptz '2026-08-10 00:00Z' + interval '12 days'),
  ('00000000-0000-0000-0000-000000004471', '00000000-0000-0000-0000-00000000a073', 'WI-4471', 'Hangar Bay 2 structural hot work',        '130 Hull Decks',             'Welding',      false, 'AWR 73-26-4471', true,  timestamptz '2026-08-10 00:00Z' + interval '7 days',   timestamptz '2026-08-10 00:00Z' + interval '95 days'),
  ('00000000-0000-0000-0000-000000003905', '00000000-0000-0000-0000-00000000a073', 'WI-3905', 'Aft IC preservation & cableway closure',  '431 Interior Comm',          'Electrical',   false, 'AWR 73-26-3905', false, timestamptz '2026-08-10 00:00Z' + interval '2 days',   timestamptz '2026-08-10 00:00Z' + interval '11 days'),
  ('00000000-0000-0000-0000-000000001905', '00000000-0000-0000-0000-00000000a073', 'WI-1905', 'Switchboard No. 1 rip-out',               '322 Power Distribution',     'Electrical',   false, 'AWR 73-26-1905', false, timestamptz '2026-08-10 00:00Z' + interval '40 days',  timestamptz '2026-08-10 00:00Z' + interval '74 days'),
  ('00000000-0000-0000-0000-000000005571', '00000000-0000-0000-0000-00000000a073', 'WI-5571', 'Fan room duct insulation',                '512 Ventilation & Uptakes',  'Preservation', false, 'AWR 73-26-5571', true,  timestamptz '2026-08-10 00:00Z' + interval '96 days',  timestamptz '2026-08-10 00:00Z' + interval '130 days')
ON CONFLICT (work_order_id) DO NOTHING;

INSERT INTO work_segment (segment_id, work_order_id, code, kind, upstream_id, label) VALUES
  ('00000000-0000-0000-0000-000033180001', '00000000-0000-0000-0000-000000003318', 'S1', 'scope', NULL, NULL),
  ('00000000-0000-0000-0000-000034020001', '00000000-0000-0000-0000-000000003402', 'S1', 'scope', NULL, NULL),
  ('00000000-0000-0000-0000-000044710001', '00000000-0000-0000-0000-000000004471', 'S1', 'scope', NULL, NULL),
  ('00000000-0000-0000-0000-000039050001', '00000000-0000-0000-0000-000000003905', 'S1', 'scope', NULL, NULL),
  ('00000000-0000-0000-0000-000019050001', '00000000-0000-0000-0000-000000001905', 'S1', 'scope', NULL, NULL),
  ('00000000-0000-0000-0000-000055710001', '00000000-0000-0000-0000-000000005571', 'S1', 'scope', NULL, NULL)
ON CONFLICT (segment_id) DO NOTHING;

INSERT INTO work_segment_space (segment_id, compartment_no, budget_hours, earned_hours) VALUES
  ('00000000-0000-0000-0000-000033180001', '4-110-2-W', 680, 512),
  ('00000000-0000-0000-0000-000034020001', '4-110-2-W', 240, 0),
  ('00000000-0000-0000-0000-000044710001', '1-136-0-Q', 410, 12),
  ('00000000-0000-0000-0000-000039050001', '4-141-0-C', 340, 0),
  ('00000000-0000-0000-0000-000019050001', '4-102-2-E', 160, 0),
  ('00000000-0000-0000-0000-000055710001', '4-120-4-Q', 140, 0)
ON CONFLICT (segment_id, compartment_no) DO NOTHING;

-- The two distributed packages, their segment topology, and the per-space work.
INSERT INTO work_order (work_order_id, availability_id, code, title, system, trade, is_distributed, source_ref, source_verified, test_verb) VALUES
  ('00000000-0000-0000-0000-000000002201', '00000000-0000-0000-0000-00000000a073', 'WI-2201', 'AC Plant No. 2 — supply & return distribution',  'Ventilation & air conditioning · Zone 3 forward and aft',   'Sheet Metal', true, 'AWR 73-26-2201', true, 'leak-tested'),
  ('00000000-0000-0000-0000-000000003310', '00000000-0000-0000-0000-00000000a073', 'WI-3310', 'Zone 3 overhead cableway — power and IC pulls',  'Electrical distribution and interior communications',       'Electrical',  true, 'AWR 73-26-3310', true, 'continuity- and megger-tested')
ON CONFLICT (work_order_id) DO NOTHING;

INSERT INTO work_segment (segment_id, work_order_id, code, kind, upstream_id, label) VALUES
  ('00000000-0000-0000-0000-000022010001', '00000000-0000-0000-0000-000000002201', 'T1', 'Trunk',  NULL, 'Main supply trunk — AC-2 to Fr 148'),
  ('00000000-0000-0000-0000-000022010002', '00000000-0000-0000-0000-000000002201', 'B1', 'Branch', '00000000-0000-0000-0000-000022010001', 'Branch 1 — Zone 3 upper, mess and scullery'),
  ('00000000-0000-0000-0000-000022010003', '00000000-0000-0000-0000-000000002201', 'B2', 'Branch', '00000000-0000-0000-0000-000022010001', 'Branch 2 — switchgear and berthing'),
  ('00000000-0000-0000-0000-000022010004', '00000000-0000-0000-0000-000000002201', 'T2', 'Trunk',  '00000000-0000-0000-0000-000022010001', 'Aft supply trunk — Fr 176 to Fr 192'),
  ('00000000-0000-0000-0000-000022010005', '00000000-0000-0000-0000-000000002201', 'B3', 'Branch', '00000000-0000-0000-0000-000022010004', 'Branch 3 — wardroom terminal'),
  ('00000000-0000-0000-0000-000022010006', '00000000-0000-0000-0000-000000002201', 'R1', 'Riser',  '00000000-0000-0000-0000-000022010004', 'Riser — Hangar Bay 2 supply'),
  ('00000000-0000-0000-0000-000033100001', '00000000-0000-0000-0000-000000003310', 'C1', 'Run',    NULL, 'Main run — Fr 140 to Fr 160, overhead 3rd deck'),
  ('00000000-0000-0000-0000-000033100002', '00000000-0000-0000-0000-000000003310', 'C2', 'Run',    '00000000-0000-0000-0000-000033100001', 'Berthing overhead — Fr 140'),
  ('00000000-0000-0000-0000-000033100003', '00000000-0000-0000-0000-000000003310', 'C3', 'Run',    '00000000-0000-0000-0000-000033100001', 'Switchgear terminations')
ON CONFLICT (segment_id) DO NOTHING;

-- Segment membership and hours per compartment, windows as day offsets from the
-- anchor — completed spaces in the past, in-progress straddling, unstarted
-- ahead, exactly the story memory.rs tells.
INSERT INTO work_segment_space (segment_id, compartment_no, budget_hours, earned_hours, planned_start, planned_finish) VALUES
  -- WI-2201 · T1
  ('00000000-0000-0000-0000-000022010001', '3-172-0-M', 620, 620, timestamptz '2026-08-10 00:00Z' + interval '-12 days', timestamptz '2026-08-10 00:00Z' + interval '-6 days'),
  ('00000000-0000-0000-0000-000022010001', '3-160-2-Q', 380, 300, timestamptz '2026-08-10 00:00Z' + interval '-2 days',  timestamptz '2026-08-10 00:00Z' + interval '3 days'),
  ('00000000-0000-0000-0000-000022010001', '3-148-0-L', 240, 240, timestamptz '2026-08-10 00:00Z' + interval '-6 days',  timestamptz '2026-08-10 00:00Z' + interval '-2 days'),
  -- WI-2201 · B1
  ('00000000-0000-0000-0000-000022010002', '2-160-1-Q', 560, 410, timestamptz '2026-08-10 00:00Z' + interval '-1 days',  timestamptz '2026-08-10 00:00Z' + interval '5 days'),
  ('00000000-0000-0000-0000-000022010002', '2-152-0-Q', 400, 180, timestamptz '2026-08-10 00:00Z' + interval '-1 days',  timestamptz '2026-08-10 00:00Z' + interval '8 days'),
  -- WI-2201 · B2
  ('00000000-0000-0000-0000-000022010003', '3-148-2-E', 320, 96,  timestamptz '2026-08-10 00:00Z',                        timestamptz '2026-08-10 00:00Z' + interval '6 days'),
  ('00000000-0000-0000-0000-000022010003', '3-140-0-Q', 480, 0,   timestamptz '2026-08-10 00:00Z' + interval '6 days',   timestamptz '2026-08-10 00:00Z' + interval '30 days'),
  -- WI-2201 · T2
  ('00000000-0000-0000-0000-000022010004', '3-184-0-Q', 340, 300, timestamptz '2026-08-10 00:00Z' + interval '-8 days',  timestamptz '2026-08-10 00:00Z' + interval '-1 days'),
  ('00000000-0000-0000-0000-000022010004', '3-192-2-E', 210, 210, timestamptz '2026-08-10 00:00Z' + interval '-10 days', timestamptz '2026-08-10 00:00Z' + interval '-4 days'),
  -- WI-2201 · B3
  ('00000000-0000-0000-0000-000022010005', '2-176-0-Q', 300, 165, timestamptz '2026-08-10 00:00Z' + interval '-2 days',  timestamptz '2026-08-10 00:00Z' + interval '9 days'),
  -- WI-2201 · R1
  ('00000000-0000-0000-0000-000022010006', '1-160-0-Q', 300, 60,  timestamptz '2026-08-10 00:00Z' + interval '-3 days',  timestamptz '2026-08-10 00:00Z' + interval '62 days'),
  -- WI-3310 · C1
  ('00000000-0000-0000-0000-000033100001', '3-148-0-L', 410, 410, timestamptz '2026-08-10 00:00Z' + interval '-9 days',  timestamptz '2026-08-10 00:00Z' + interval '-3 days'),
  ('00000000-0000-0000-0000-000033100001', '3-152-0-Q', 260, 240, timestamptz '2026-08-10 00:00Z' + interval '-3 days',  timestamptz '2026-08-10 00:00Z' + interval '2 days'),
  -- WI-3310 · C2
  ('00000000-0000-0000-0000-000033100002', '3-140-0-Q', 520, 310, timestamptz '2026-08-10 00:00Z' + interval '-4 days',  timestamptz '2026-08-10 00:00Z' + interval '26 days'),
  -- WI-3310 · C3
  ('00000000-0000-0000-0000-000033100003', '3-148-2-E', 300, 40,  timestamptz '2026-08-10 00:00Z',                        timestamptz '2026-08-10 00:00Z' + interval '7 days')
ON CONFLICT (segment_id, compartment_no) DO NOTHING;

-- Coupling semantics and the CVN-73 aft-third neighbourhood. Type ids mirror
-- the in-memory seed so a decision trace is comparable across stores.
INSERT INTO coupling_type (coupling_type_id, org_id, code, label, directional, propagates, default_max_hops) VALUES
  ('00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'deck_penetration', 'Deck penetration', true,  '{heat,vapour}', 1),
  ('00000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'shared_bulkhead',  'Shared bulkhead',  false, '{heat,vapour}', 2),
  ('00000000-0000-0000-0000-000000000003', '00000000-0000-0000-0000-000000000001', 'exhaust_trunk',    'Exhaust trunk',    true,  '{vapour}',      3)
ON CONFLICT (coupling_type_id) DO NOTHING;

-- Directed rows; the symmetric bulkheads appear in both directions, as the
-- schema requires.
INSERT INTO class_coupling (class_coupling_id, class_id, from_comp_id, to_comp_id, coupling_type_id) VALUES
  ('00000000-0000-0000-0000-00000000ed01', '00000000-0000-0000-0000-0000000c0068', '00000000-0000-0000-0000-00000000c306', '00000000-0000-0000-0000-00000000c203', '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-00000000ed02', '00000000-0000-0000-0000-0000000c0068', '00000000-0000-0000-0000-00000000c306', '00000000-0000-0000-0000-00000000c406', '00000000-0000-0000-0000-000000000001'),
  ('00000000-0000-0000-0000-00000000ed03', '00000000-0000-0000-0000-0000000c0068', '00000000-0000-0000-0000-00000000c306', '00000000-0000-0000-0000-00000000c305', '00000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-00000000ed04', '00000000-0000-0000-0000-0000000c0068', '00000000-0000-0000-0000-00000000c305', '00000000-0000-0000-0000-00000000c306', '00000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-00000000ed05', '00000000-0000-0000-0000-0000000c0068', '00000000-0000-0000-0000-00000000c306', '00000000-0000-0000-0000-00000000c307', '00000000-0000-0000-0000-000000000003'),
  ('00000000-0000-0000-0000-00000000ed06', '00000000-0000-0000-0000-0000000c0068', '00000000-0000-0000-0000-00000000c307', '00000000-0000-0000-0000-00000000c407', '00000000-0000-0000-0000-000000000003'),
  ('00000000-0000-0000-0000-00000000ed07', '00000000-0000-0000-0000-0000000c0068', '00000000-0000-0000-0000-00000000c402', '00000000-0000-0000-0000-00000000c403', '00000000-0000-0000-0000-000000000002'),
  ('00000000-0000-0000-0000-00000000ed08', '00000000-0000-0000-0000-0000000c0068', '00000000-0000-0000-0000-00000000c403', '00000000-0000-0000-0000-00000000c402', '00000000-0000-0000-0000-000000000002')
ON CONFLICT (class_coupling_id) DO NOTHING;

-- Live conditions on CVN-73: the curing coat (a timed hold — scrub past the
-- cure and it releases) and the energised bus (clears only on a verified
-- zero-energy state — no amount of scrubbing discharges it). Raised relative
-- to seed time — the one place this seed reads the clock — because a hazard
-- row records when it was raised, and this demo's story is that the coat is
-- three hours into its cure WHEN THE WORLD IS CREATED, exactly as
-- InMemoryStore::demo_at anchors it.
INSERT INTO hazard (hazard_id, org_id, vessel_id, compartment_no, kind, raised_at, label) VALUES
  ('00000000-0000-0000-0000-00000000ba01', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000073', '3-160-2-Q', 'coating_open',  now() - interval '3 hours', 'CT-3160-4 · final coat, curing'),
  ('00000000-0000-0000-0000-00000000ba02', '00000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000073', '3-148-2-E', 'energised_bus', now() - interval '2 days', 'Bus 3-SG-2 energised — no verified zero-energy state')
ON CONFLICT (hazard_id) DO NOTHING;

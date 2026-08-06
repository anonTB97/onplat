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
  ('00000000-0000-0000-0000-00000000c204', '00000000-0000-0000-0000-0000000c0068', '2-176-0-Q', '00000000-0000-0000-0000-00000000d002', 172, 180, 'centreline', 'Q', 'Living',                   'Wardroom',                       'Z5'),
  ('00000000-0000-0000-0000-00000000c301', '00000000-0000-0000-0000-0000000c0068', '3-140-0-Q', '00000000-0000-0000-0000-00000000d003', 136, 144, 'centreline', 'Q', 'Living',                   'Berthing 3-140',                 'Z3'),
  ('00000000-0000-0000-0000-00000000c302', '00000000-0000-0000-0000-0000000c0068', '3-148-0-L', '00000000-0000-0000-0000-00000000d003', 144, 152, 'centreline', 'L', 'Passage',                  'Passage 3-148',                  'Z3'),
  ('00000000-0000-0000-0000-00000000c303', '00000000-0000-0000-0000-0000000c0068', '3-148-2-E', '00000000-0000-0000-0000-00000000d003', 144, 152, 'port',       'E', 'Electrical',               'Switchgear Room No. 2',          'Z3'),
  ('00000000-0000-0000-0000-00000000c304', '00000000-0000-0000-0000-0000000c0068', '3-152-0-Q', '00000000-0000-0000-0000-00000000d003', 148, 156, 'centreline', 'Q', 'Stores',                   'Storeroom 3-152',                'Z3'),
  ('00000000-0000-0000-0000-00000000c305', '00000000-0000-0000-0000-0000000c0068', '3-156-2-Q', '00000000-0000-0000-0000-00000000d003', 152, 160, 'port',       'Q', 'Machinery / electrical',   'Pump Room No. 2',                'Z3'),
  ('00000000-0000-0000-0000-00000000c306', '00000000-0000-0000-0000-0000000c0068', '3-160-2-Q', '00000000-0000-0000-0000-00000000d003', 156, 164, 'port',       'Q', 'Machinery / electrical',   'Pump Room No. 3',                'Z3'),
  ('00000000-0000-0000-0000-00000000c307', '00000000-0000-0000-0000-0000000c0068', '3-164-2-Q', '00000000-0000-0000-0000-00000000d003', 160, 168, 'port',       'Q', 'Machinery / electrical',   'Fan Room 3-164',                 'Z3'),
  ('00000000-0000-0000-0000-00000000c308', '00000000-0000-0000-0000-0000000c0068', '3-172-0-M', '00000000-0000-0000-0000-00000000d003', 168, 176, 'centreline', 'M', 'Machinery / electrical',   'AC Plant No. 2',                 'Z4'),
  ('00000000-0000-0000-0000-00000000c309', '00000000-0000-0000-0000-0000000c0068', '3-184-0-Q', '00000000-0000-0000-0000-00000000d003', 180, 188, 'centreline', 'Q', 'Machinery / electrical',   'Auxiliary Machinery 2',          'Z5'),
  ('00000000-0000-0000-0000-00000000c310', '00000000-0000-0000-0000-0000000c0068', '3-185-0-L', '00000000-0000-0000-0000-00000000d003', 182, 188, 'centreline', 'L', 'Living',                   'CPO Living Space',               'Z5'),
  ('00000000-0000-0000-0000-00000000c311', '00000000-0000-0000-0000-0000000c0068', '3-192-2-E', '00000000-0000-0000-0000-00000000d003', 188, 196, 'port',       'E', 'Command & surveillance',   'IC Room',                        'Z5'),
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

# Council 6 — Product/Domain Owner: one source of truth for four teams

Reviewed on `claude/kickoff-from-docs-arhiib` at `9be0cd7` (clean tree).
Nothing was implemented; the counts in §1.4 were taken with `grep` over the
tree at this head. Earlier council documents read: 1 (platform), 2 (ATO),
3 (data/performance), 4 (UX), 5 (reliability), 7 (hull grid); tensions in §4.

The premise under review: planning, hot-work/fire-watch, NDT/QA and
deck-plate supervision read *one* hull and act on *one* record. That is a
governance question before it is a technical one — which team's system feeds
which field, what happens when two feeds disagree, who may write what, and
whether every change to a shared record says who, what, when and *what it
replaced*. The build is honest about most of this and silent about the rest.

## 1. Current state

### 1.1 Solid — the ownership shape is already right where it exists

- **Documents through doors is the correct ownership primitive.** One row per
  (hull, kind) (`migrations/0011:69-78`), replaced or reverted whole,
  previewed by dry run, every commit and revert ledgered with one shape
  `{kind, label, counts, via, by_org, at_ms}` (`documents.rs:487-506`). The
  served hull *is* the documents; the seed only stands in where a document
  is absent (`serve.rs:99-102`; `pg_repo.rs:874-880`). Nine kinds are in
  force (`0018:39-42`, `0019`), each with an obvious external owner (§2 table).
- **P6 stays the scheduler of record, and the loop back is closed honestly.**
  Runs are history, not overwrite (`ingest_run`, `0018:18-33`; `seq` under a
  per-hull lock); the quarantine is served per row with line, table and reason
  and never silently dropped (`docs/execution-plan.md:53`); proposals are ledger
  rows whose status is *derived on every read* against the served schedule
  (`handlers.rs:3700-3725`, `status_basis`), the change request leaves as P6's
  own import layout (`Proposals.tsx:61-107`), and the next import says which
  proposals P6 reflected. Nothing in the tree writes a date. This is the model
  every other feed should copy.
- **The engine's verdicts are never stored, only served** (`handlers.rs:1600-1605`,
  "ending the fact IS the cascade"), the shell refuses to re-derive zone
  membership (`zones.ts:24-29`) or who-may (`identity.ts` reads `capabilities`
  from `whoami`), and a decision records the *server's* copy of the option, not
  the client's (`handlers.rs:1100-1142`). Server computes, shell renders holds.
- **Hazards are recorded facts with an owner in the data model**
  (`0011:16-32` states the decision; `cleared_basis` `0012`), raised only
  against a registered space (`handlers.rs:1530-1535`), one fact once
  (`:1548-1557`), cleared only with a basis (`:1624-1631`), visible at the
  instants before clearance (execution-plan slice 2).
- **The safety authority's table is a signed document**: commit clears the
  signature, the signature is of a content hash, the hash and every version
  are on the `RULE_TABLE_SIGNED` row (`rule_table.rs:1205-1255`).
- **Identity is the proxy's and nothing else's** — no person row is written,
  the actor is hashed into every row (`0017`), and the contract says so
  (`identity-proxy-contract.md` §1, §9).
- **Every derived figure names its layer** on the sheets (`reports.ts:8-11`,
  `ReportCut`); the readiness rollup says whether hours came from the
  schedule or the seed (`handlers.rs:869` `hours_source`).

### 1.2 Missing — with evidence

**Ownership is nowhere written down.** No document maps document kind →
system of record → owning role → signer. `docs/pilot-playbook.md:30-44` (Y1–Y15)
lists what the yard hands over and the format, not who owns the field
afterwards or who adjudicates a disagreement. `0002:4-6` ("class holds the
template, hull holds the truth") is the only ownership sentence in the tree.
An AC-21/CM-8 reviewer asks for the data-flow-and-owner table first.

**The capability matrix does not follow ownership.** `commit_document` is one
capability over every document kind (`roles.rs:296-442`: register, couplings,
zones, geometry, schedule, manning, budget, field map, yard clock, rule table
all under `Capability::CommitDocument`), and only Planner holds it
(`roles.rs:190-199`). Consequences: (a) the safety authority cannot commit its
own rule table — Safety holds `SignRuleTable` but not `CommitDocument`
(`:210-217`), so a Planner must commit the safety authority's document and the
authority may only countersign; (b) the same Planner may replace the hull's
register, the zone chart and the yard clock, none of which planning owns;
(c) the scheduler (the P6 owner, a distinct person at the XER door in
`pilot-playbook.md:180`) has no role and must be a Planner.

**The clearing authority the rule names is not the authority the gate
checks.** The rule table binds each cascade to a `clearing_authority`
(`wadl-engine/src/rules.rs:129`; seed values `marine_chemist`, `fire_marshal`,
`isolation_authority`, `issuing_authority`, `:282-473`), and the trace tells
the reader who has to act. The gate checks `clear_hazard`, held by Ship Super
and Safety only (`roles.rs:200-217`). So the person the rule names cannot
record the clearance, and the Ship Super may record a clearance of an
energised bus the isolation authority never verified. One act, two
vocabularies, and the wrong one enforced.

**Roles missing against the teams the mandate names** (`roles.rs:107-124`,
eight codes): fire watch and fire marshal (hot-work team), QA/NDT
(inspection work type exists on the register, `execution-plan.md:56`; no
role), ship's force / isolation authority (tag-outs), marine chemist /
gas-free engineer, permit issuing authority, the scheduler, and the
implementer/data steward who loads the grid and register on data-load day
(council 7 §2.1). Deck-plate supervision is covered (Foreman, Production
Super, Zone Manager). Council 4 §1.2 reached the first two from the UX side.

**A hazard row does not say who raised it.** `hazard` columns are origin,
kind, raised_at, label, cleared_at, cleared_basis (`0011:34-45`, `0012`);
`raise_hazard` takes no actor (`repo.rs:616-624`); the served `Hazard` has
none (`evaluate.rs:35-50`). The raiser exists only in the `HAZARD_RAISED`
ledger row's `actor_id`. A fire watch reading the field-condition register
cannot see whose permit a `hot_work_live` is, and council 4 U10's
`close_own_permit` has nothing to compare against.

**Previous value is absent from every replace, and the previous document is
destroyed.** `DOCUMENT_REPLACED` carries counts of the *new* document only
(`documents.rs:494-501`); no content hash except the rule table's
(`rule_table.rs:1124-1131`); no label, hash or ledger seq of what it
replaced. `upsert_document` is `ON CONFLICT DO UPDATE` (`pg_repo.rs:475-480`),
revert is `delete_document` (`:1529-1537`), and a revert returns to the *seed
or nothing* (`revert_zones` "return to inferred bands", `handlers.rs:2774`;
`revert_budgets` "returns to the seeded work items", `:2361`), never to the
previous document. Only the schedule keeps history (runs) and names what it
replaced (`delta`, `from_run`; `schedule_door.rs:396-413`). `HAZARD_CLEARED`
names what was cleared by label (`handlers.rs:1647-1654`) but not the
`HAZARD_RAISED` seq, the raise instant or the raiser. `MITIGATION_*` and
`ISSUE_ACKNOWLEDGED` do not name the decision they supersede
(`:1144-1151`, `:1436-1442`); the newest silently wins on read
(`:1281-1301`). `DOCUMENT_*` rows carry `subject_ref: None`
(`documents.rs:504`), so the ledger cannot be asked "every change to the
register".

**No concurrency control on shared documents.** Two Planners committing the
register in the same minute: last write wins, no `replaces` precondition, no
409, and the loser's document is gone (above). Council 5 measured the
two-transaction inversion (§1.2); this is the governance half of it.

**Local copies and vendor defaults standing in for owned data.**
1. The engine's seed rule set is served as *in force* whenever no table is
   stored (`rule_table.rs:405` `seed_table`; the card reads `SEED`,
   `RuleTableCard.tsx`). On a real hull the safety authority's table would
   default to the vendor's, unsigned, and every verdict would still be green.
2. The 24-space seed stands in per document kind: `booked_orders` falls to
   seeded work orders when no schedule is served (`handlers.rs:624-629`,
   `hours_source: seeded_work_orders`); `pg_list_compartments` falls to
   `vessel_compartment` (`pg_repo.rs:876-880`); `pg_seed.sql:85-102` writes
   `persona`, `person`, `person_assignment` rows nothing reads.
3. Zone names and owners live only in the generator (`tools/gen_cvn73_hull.py:63-70`,
   council 7 §1.2); the deck placard-digit map likewise (`:32-47`).
4. The deck plates are another ship, unscoped (`deckSheets.ts:1-11`;
   `shell-web/public/decks`; council 7 HG-4, council 2 R11).
5. `ROLE_WORDS` duplicates `Role::yard_word` in the shell (`identity.ts:51`
   vs `roles.rs:156-167`); the matrix is served, the words are copied.
6. `localStorage`: the role (`Chrome.tsx:166-186`) and the first-run flag
   (`FirstRun.tsx:18-26`). Both per-viewer conveniences; the role is a landing
   preference, never identity — but `loadRole()` is read in proxy mode too
   and the persona's `code` is what the demo shim asserts (`demo.ts:29-38`).
7. Exports: `Reports.tsx:49-57`, `Proposals.tsx:49-57, 163`,
   `RuleTableCard.tsx:143-151`, the Sequence Board CSV. Each carries its cut
   header; none is ledgered — the server does not know a change request left
   — and none carries the handling marking in the file.
8. `DEFAULT_MARKINGS` (council 4 U1).
9. The shell's headline five (`Chrome.tsx:966-969`) are client sums over
   served rows; `keyEvents.ts` walks *every* edge to decide `MISSES THE EVENT`
   (`:50-60` and the tiers); `tomorrow.ts` and `windowLoad.ts` pro-rate hours.
   Correct today because the shell holds the whole register; wrong the day
   council 3 D8 pages it.

**A second, dead data model in the schema.** 33 of 55 tables have no writer
outside tests (§1.4): `permit`, `permit_approval`, `decision_event`,
`space_certificate`, `credential`, `inspection_*`, `oqe_item`, `disposition`,
`second_attest`, `deviation`, `deferred_work`, `drawing_*`, `standard*`,
`p6_activity`, `p6_relationship`, `vessel_grant`… `persona_capability`
carries a capability vocabulary (`0001:92-99`: `raise_permit, approve_gf,
approve_fm, stop_work …`) that is not `roles.rs`'s. Every one has RLS and a
policy; none has an owner. An assessor reading the migrations will ask who
feeds `permit` and be told nothing does.

**The hull grid** (council 7) is the one spatial document that must be
authored once per programme per vessel and does not exist; today the frame
axis is a bootstrap-statement field nothing reads (`model.rs:713-718`) and a
constant five times in the shell (`deckGeometry.ts:20` and four more).

### 1.3 Disqualifying

1. **The vendor's rule set can be the rules in force on a real hull**
   (§1.2 item 1). The safety authority's system of record has a
   code-resident default that serves ALLOW/SUSPEND verdicts unsigned. For a
   work-authorization decision-support product this is a governance failure
   an AO will read as "the vendor decides the safety rules until the yard
   notices". Fix is small (P2): without a stored *and signed* table on a
   non-demo hull, every verdict is `unassessable` with the sentence.
2. **Least privilege does not follow ownership** (AC-6 as the assessor reads
   it against the data-flow table): one Planner capability commits every
   team's document, the safety authority cannot commit its own, and the rule's
   clearing authority is not the gate's. Not a rewrite — `roles.rs` is the one
   place, by design (`:1-11`) — but the matrix must be re-cut before a second
   team is on the system (P6, P7).
3. **Shared records can be replaced with no previous value, no history and
   no conflict detection** for eight of nine document kinds (§1.2). AU-3
   "what changed" is unanswerable for the register; a revert is a *delete*.
   The schedule's run model already exists and is the fix (P3, P8).
4. **For carrier-scale concurrent use**: the shell derives schedule-integrity
   judgements (`MISSES THE EVENT`, the strip's five numbers) client-side over
   the whole register. Council 3's paging (D8) is mandatory at 45k rows and
   makes every such sum a page sum. These must move server-side first (P9), or
   D8 silently breaks the "same five numbers on every screen" promise.

Nothing here is architectural. The door, the run history, the ledger, the
matrix and the sign-off are the right primitives; they have to be applied to
every kind, not one.

### 1.4 Measurements (grep over the tree at `9be0cd7`)

| What | Value |
|---|---|
| Document kinds in force / with history / naming what they replaced | 9 (`0018:39-42` + `rule_table`) / 1 (schedule runs) / 1 |
| Ledger action kinds | 13 (`HAZARD_RAISED/CLEARED/LOG_IMPORTED`, `DOCUMENT_REPLACED/REVERTED`, `SCHEDULE_REPLACED`, `SCHEDULE_CHANGE_PROPOSED/WITHDRAWN`, `MITIGATION_ACCEPTED/REJECTED`, `ISSUE_ACKNOWLEDGED`, `RULE_TABLE_SIGNED`, `HULL_BOOTSTRAPPED`) |
| Action kinds whose detail names a previous value or superseded row | 2 (`SCHEDULE_REPLACED` delta/`from_run`; `SCHEDULE_CHANGE_WITHDRAWN` `seq`) |
| Roles / capabilities / roles holding `commit_document` / holding `clear_hazard` | 8 / 7 / 1 (Planner) / 2 (Ship Super, Safety) |
| Clearing authorities the engine names / that exist as roles | 4 / 0 |
| Tables created / with no non-test writer | 55 / 33 |
| Hazard columns naming the raiser | 0 |
| `localStorage` sites / CSV download sites / shell-side sums feeding the strip | 2 / 4 / 4 (`Chrome.tsx:966-969`) |

## 2. Prioritised actions

Class: **ato** (governance an assessor will fail), **crash_perf** (data
loss or a wrong figure under real load), **ux_polish**. Effort in
agent-hours including tests and docs.

| id | action | class | effort | depends on |
|---|---|---|---|---|
| P1 | `docs/data-ownership.md`: the ownership matrix (§3 outline) — kind → system of record → owning role → signer → disagreement path → retention; linked from the ATO package and the playbook; CI drift check that every kind in the `ingested_document` CHECK and every `roles.rs` capability appears in it | ato | 3 | — |
| P2 | Seed fences: `organization.demo boolean` (0020) set only by `wadl seed`; on a non-demo org the rule-table seed is never in force (verdicts `unassessable`, sentence *no signed rule table is stored for this hull*), `hours_source` never `seeded_work_orders`, `pg_list_compartments` never falls to `vessel_compartment`; the strip wears `RULES: NONE` red | ato | 4 | — |
| P3 | Document versions: `document_version` (0021) — every commit appends `(vessel, kind, seq, label, doc, content_hash, ledger_seq)`, `ingested_document` points at the served version; revert = *serve version N*, ledgered with both; `GET /documents/:kind/versions`; the schedule's run table stays as the specialised case | ato | 10 | council 1 A3 (same transaction) |
| P4 | Ledger previous-value detail: `DOCUMENT_REPLACED {replaced: {label, content_hash, version_seq, ledger_seq} \| null, content_hash}`; `DOCUMENT_REVERTED {from: {…}, to: {version \| "none"}}`; `HAZARD_CLEARED {raised_seq, raised_at_ms, raised_by}`; `MITIGATION_*`/`ISSUE_ACKNOWLEDGED {supersedes: seq \| null}`; `subject_ref = kind` on document rows; `list_audit(subject)` then answers "every change to the register" | ato | 4 | P3, P5 |
| P5 | `hazard.raised_by text` (0020) + `raised_seq`; `raise_hazard` takes the actor; served on every hazard read and the field-condition register | ato | 2 | — |
| P6 | Matrix re-cut by ownership: capabilities `commit_hull_document` (grid, register, zones, exceptions, geometry, couplings), `commit_schedule` (SoR, field map, runs/serve), `commit_yard_document` (clock, manning, budget), `commit_rule_table` (Safety), `commit_handling` (with council 2 R10a); roles `scheduler`, `data_steward`, `fire_watch`, `fire_marshal`, `qa_ndt`, `ships_force`, `marine_chemist`; `whoami` serves `role_words` and `authorities` | ato | 8 | §5 Q2 |
| P7 | Authority-scoped clearance: roles carry authority codes (`fire_marshal`, `isolation_authority`, `issuing_authority`, `marine_chemist`); `POST hazards/clear` passes the matrix on `clear_hazard` and then the handler refuses unless the caller holds the authority the rule in force names for that kind — or the body carries `override_basis` and the caller is Safety, ledgered `HAZARD_CLEARED {authority, override: true}`; `close_own_permit` (council 4 U10) as the raiser ending their own `hot_work_live` | ato | 5 | P5, P6 |
| P8 | Optimistic concurrency at the doors: commit body carries `replaces_hash` (the hash the dry run served); mismatch → 409 with the current label, hash and the person who committed it; the shell re-runs the dry run | crash_perf | 3 | P3 |
| P9 | Server-served figures before paging: `GET /summary` (the strip's five, from the readiness rollup and issues), `GET /key-events` (council 4's tiers, `gatingSet` moved to `wadl-plan`), Tomorrow's sections served; the shell sums nothing that spans the register | crash_perf | 8 | before council 3 D8 |
| P10 | Exports ledgered and marked: `POST /exports {kind, seqs \| cut}` returns the CSV and writes `EXPORT_TAKEN {kind, rows, content_hash, marking}`; every CSV and print header carries `whoami.markings`; the P6 change request is this export | ato | 3 | — |
| P11 | The 33 reserved tables: 0022 `COMMENT ON TABLE … 'reserved — no writer; system of record: <name>; owner: <role>'` from P1's matrix, or drop-listed for the next major; `persona_capability` vocabulary removed; SSP CM-8 lists them as reserved | ato | 2 | P1 |
| P12 | Hull grid, chart v2 with owners, exceptions (council 7 HG-1..3) under `commit_hull_document`; the zone owner is a role code or person id per §5 Q6 | ux_polish | in HG | P6 |
| P13 | Document sign-off generalised: `POST /documents/:kind/sign` (`DOCUMENT_SIGNED {kind, content_hash, statement, signer}`) with the signing authority per kind from P1 (grid: naval architect; register: ship register owner; rule table: Safety — unchanged) | ux_polish | 4 | P3 |
| P14 | Contract §3 and the playbook rewritten from P6: the new roles' directory groups, the data-load-day table gains *owner* and *signer* columns, every Y-row names the disagreement path | ato | 2 | P6 |
| P15 | Shell: drop `ROLE_WORDS` for `whoami.role_words`; `loadRole()` only in dev-headers mode, the proxy's first role otherwise; the role menu says *landing preference, not identity* | ux_polish | 1 | P6 |

Order: P1, P2, P5 first (paper and two small fences that change what a real
hull would serve); P6 + P7 + P14 as one sitting before any second team is
onboarded; P3 + P4 + P8 with council 1 A3 (one transaction anyway); P9 before
council 3 D8; P10, P11, P13, P15 alongside.

## 3. Concrete changes

### 3.1 `docs/data-ownership.md` — outline (P1)

```
1  Principle: WADL owns decisions, acknowledgements, proposals, signatures
   and the ledger — nothing else. Every other record is a served copy of a
   named system of record, replaced whole through a door, never edited.
2  The matrix (one row per kind):
   kind | system of record | feed | owning role (commit) | signer | who
   reads | disagreement path | retention of superseded versions | marking
   hull_grid          yard naval architecture (BGP / C&A)   csv door   data_steward   naval architect  all   grid refuses; register/chart audited against it   all versions   per Q7
   compartment_register  ship register / C&A               csv door   data_steward   ship register owner  all   out_of_bounds finding → zone_exceptions or a re-export   all versions   per Q7
   zone_register (+exceptions)  production zone management  csv door   data_steward   zone managers    all   partition refusal; exception rows are the adjudication   all   —
   geometry_register  survey / C&A                          csv door   data_steward   —                map   findings on every read   all   per Q7
   coupling_register  ship systems drawings (elec, vent, structure)  csv door  data_steward  engineering  engine  derived penetrations never authored  all  per Q7
   schedule_of_record + p6_field_map  P6 (the scheduler)   XER door   scheduler      —   all   quarantine → fixed in P6, re-exported; proposals → P6 decides   runs (exists)   —
   budget_book        cost/estimating system                 csv door   scheduler or PM  —  readiness  mismatch findings   all   —
   manning_book       labour/manning system                  csv door   production_super —  readiness  findings   all   —
   yard_clock         production control                     csv door   data_steward   —   all   clock findings; re-import warning   all   —
   rule_table         the safety authority                   csv door   safety (commit + sign)  safety  engine  a table that does not compile is refused whole; the seed is never in force on a real hull   all   —
   handling_register  security / NNPI authority (council 2 R10a)  csv door  security  security  all  a register row cannot change handling   all   —
   hazard             the daily logs (tag-out: ship's force; permits: issuing authority/fire marshal; coatings: paint shop; stop-work: anyone)  log door / raise  raiser's role  clearing authority per rule  all  one fact once; clear with basis by the named authority  rows never deleted  —
   people, roles, hulls, authorities  the directory via the proxy  headers  —  —  —  whoami is the resolved truth; no person row  —  —
   decisions, acks, proposals, signatures, exports  WADL (the ledger)  routes  per capability  —  all  supersedes/409 rule (council 5 Q7)  forever  —
   verdicts, findings, alternatives, adjacency, placement  derived, never stored  —  —  —  —  recomputed per read  none  —
3  Disagreement: the source system is always right about its own field;
   WADL records the disagreement as a finding, an exception row or a
   proposal, never a correction. Who adjudicates each (from Q5).
4  Write access: the matrix in roles.rs, reproduced by `xtask gen-ssp`.
5  Audit: per action kind, the fields, and where the previous value is.
6  Local copies permitted (with label): localStorage role/first-run;
   exports (ledgered, marked); reference/ (invented hull only); the
   memory store (tests and demo only). Everything else is a live read.
7  Reserved tables and their intended owners (P11).
```

### 3.2 Code and docs

| file | change | why |
|---|---|---|
| `crates/wadl-api/src/roles.rs` | `Capability` gains `CommitHullDocument`, `CommitSchedule`, `CommitYardDocument`, `CommitRuleTable`, `CommitHandling`, `CloseOwnPermit`; `CommitDocument` removed; `Role` gains `Scheduler`, `DataSteward`, `FireWatch`, `FireMarshal`, `QaNdt`, `ShipsForce`, `MarineChemist`; `MATRIX`: Planner {RaiseHazard, Propose, Decide}; Scheduler {CommitSchedule, Propose}; DataSteward {CommitHullDocument, CommitYardDocument}; Safety {RaiseHazard, ClearHazard, Decide, CommitRuleTable, SignRuleTable}; FireWatch {RaiseHazard, CloseOwnPermit}; FireMarshal {RaiseHazard, ClearHazard}; QaNdt {RaiseHazard}; ShipsForce {RaiseHazard, ClearHazard}; MarineChemist {ClearHazard}; `GATED` regrouped per kind; `pub fn authorities(role) -> &[&str]` (`fire_marshal`→`fire_marshal`, `ships_force`→`isolation_authority`, `safety`→`issuing_authority`, `marine_chemist`→`marine_chemist`); `whoami` serves `authorities`, `role_words`; test: no role commits a document it does not own per `docs/data-ownership.md` (the test reads the matrix from the doc's table) | AC-6 follows ownership; the safety authority commits its own table; the doc and the code cannot drift |
| `crates/wadl-api/src/handlers.rs` (`clear_hazard`) | After the store confirms the live hazard: `rules_in_force` → the entries bound to `body.kind` → their `clearing_authority` set; refuse 403 `problem+json {"authority": "isolation_authority"}` unless `caller.authorities` intersects, or `body.override_basis` is non-empty and the caller is Safety; detail gains `authority`, `override`, `raised_seq`, `raised_at_ms`, `raised_by` | The person the rule names records the clearance; an override is a loud, ledgered exception |
| `crates/wadl-api/src/handlers.rs` (`raise_hazard`, `raise_logged_row`) | `store.raise_hazard(.., &scope.actor)`; `HAZARD_RAISED` detail gains `raised_by` (already `actor_id` on the row — kept in detail so the hazard row and the ledger agree) | Who raised it is a fact on the fact |
| `crates/wadl-store/src/repo.rs`, `memory.rs`, `pg_repo.rs`, `model.rs`, `migrations/0020_hazard_raiser_and_demo_flag.sql` | `hazard.raised_by text`, `raised_seq bigint`; `organization.demo boolean NOT NULL DEFAULT false`; `wadl seed` sets `demo = true`; `Hazard`/served hazard rows carry `raised_by`; `TenantScope` learns `demo` from the org row at `with_tenant` (memory: always demo) | The fences in P2 need one bit the store can answer |
| `crates/wadl-api/src/rule_table.rs` (`engine_inputs`, `seed_table`) | When `!scope.demo` and no stored, signed table: `rules_in_force` is empty and `EngineInputs` carries `rules: { source: "none", signed: false }`; every verdict serialises `unassessable` with `reason: "no signed rule table is stored for this hull"`; `/health` lists hulls in that state | The vendor's rules are never in force on a real hull |
| `crates/wadl-api/src/handlers.rs` (`booked_orders`, `list_compartments` path), `pg_repo.rs:876-880` | `!scope.demo` → no fall-through to seeded work orders or `vessel_compartment`; `hours_source: "none"` and a `readiness` finding *no schedule of record is served* | The seed never stands in for a yard's data |
| `migrations/0021_document_versions.sql`, `pg_repo.rs` (`upsert_document`, `delete_document`), `memory.rs` | `document_version (org_id, vessel_id, kind, seq, label, doc jsonb, content_hash bytea, committed_by text, ledger_seq bigint, committed_at)`, RLS as `ingested_document`, INSERT-only for `wadl_app`; `upsert_document` inserts a version then points `ingested_document.version_seq`; revert = serve a named version (default: the previous) — `delete_document` becomes "serve none"; trait `document_versions(scope, vessel, kind)`, `serve_document_version(.., seq)`; memory keeps the newest 12 like `MAX_RUN_DOCS` | Previous value exists; revert restores it; the run model generalised |
| `crates/wadl-api/src/documents.rs` (`DocumentLedgerLine`, `ledger_document_on`) | Add `content_hash: String`, `replaced: Option<Replaced { label, content_hash, version_seq, ledger_seq }>`; `subject_ref = Some(kind)`; every door passes the hash the dry run served and the served version's summary | AU-3 what-changed on every document row |
| `crates/wadl-api/src/handlers.rs` (`record_decision`, `acknowledge_issue`) | With council 5 Q7: detail gains `supersedes: <seq \| null>` (the previous `MITIGATION_*`/ack on the subject); the read at `:1281-1301` serves `supersedes` chain, so the board can show *revised from #n* | Which decision stands is written, not inferred |
| Every door handler (`handlers.rs` register/couplings/zones/geometry/manning/budget, `schedule_door.rs`, `yard_clock.rs`, `rule_table.rs`) | Body gains `replaces_hash: Option<String>`; when present and ≠ the served version's hash → 409 `{"title":"replaced since your preview","served":{label,hash,by,at}}`; dry-run responses carry `content_hash` and `served: {…}`; `ingest.ts`/`SourcesBoard.tsx` send it and re-run the dry run on 409 | Two teams cannot silently overwrite each other |
| `crates/wadl-api/src/handlers.rs` (new `summary`, `key_events`), `crates/wadl-plan/src/` (gating set), `routes.rs`, `shell-web/src/Chrome.tsx:957-1012`, `keyEvents.ts`, `App.tsx` | `GET /summary` `{held_spaces, standing_by_mh, not_executable, open_issues, at_risk_mh, as_of, epoch}` from the readiness rollup and `derived_issues`; `GET /key-events?event=` serves council 4's tiers with `gatingSet` in `wadl-plan` (pure, wasm-safe); the strip and Week Ahead render the served rows; `keyEvents.ts` keeps only wording | The same numbers on every screen stay the same when the register is paged |
| `crates/wadl-api/src/handlers.rs` (`export`), `routes.rs`, `roles.rs` (`FREE_POSTS` stays empty — gated on `Read`? no: add `Capability::Export` held by every role but Reader), `shell-web/src/Reports.tsx`, `Proposals.tsx`, `RuleTableCard.tsx` | `POST /exports {kind: "shift" \| "proposals" \| "rule_table" \| …, cut}` → the CSV bytes, `EXPORT_TAKEN {kind, rows, content_hash, marking}` ledgered; header line 1 is `whoami.markings`; the shell's `downloadText`/`downloadCsv` call it instead of building blobs from state | A copy that leaves is a copy the ledger knows about, marked |
| `migrations/0022_reserved_tables.sql` | `COMMENT ON TABLE permit IS 'reserved — no writer; system of record: the permit system; owner: issuing_authority'` … for all 33; `DROP TABLE persona_capability` is *not* done (forward-only) — commented `'superseded by roles.rs MATRIX; never written'`; `xtask gen-ssp` reads the comments into a CM-8 "reserved" list | The schema stops claiming a model the product does not have |
| `crates/wadl-api/src/rule_table.rs` (new `sign_document`), `documents.rs`, `routes.rs` | Generalise `sign_rule_table` to `POST /documents/:kind/sign` with `SIGNERS: &[(kind, Capability)]` from P1; `DOCUMENT_SIGNED {kind, content_hash, statement, signer}`; the rule-table route stays as an alias | The grid and the register get the sign-off council 7 §2.1 needs, the same way |
| `shell-web/src/identity.ts`, `Chrome.tsx:166-186` | Delete `ROLE_WORDS`, read `whoami.role_words`; `loadRole()` used only when `identity_mode === "dev-headers"`; behind the proxy the landing is the first asserted role's persona; the menu title reads *Landing (your roles are the proxy's)* | One vocabulary; a browser preference never looks like an identity |
| `docs/identity-proxy-contract.md` §3, `docs/pilot-playbook.md` §Y1–Y15 and the data-load-day table, `docs/ato-package.md`, `xtask/src/ssp_template.md` | Roles and capabilities regenerated from `roles.rs`; each Y-row gains *system of record*, *owner*, *signer*, *disagreement path*; ATO package §2 cites `docs/data-ownership.md` for AC-21/CM-8; SSP AC-6 statement re-worded "capabilities follow document ownership" | The paperwork says what the matrix enforces |
| `docs/poam.md` | POAM-18 vendor rule set in force by default (closed by P2); POAM-19 no previous value / no history on eight kinds (P3/P4); POAM-20 clearing authority not enforced (P7); POAM-21 reserved tables (P11) | Open until closed, versioned with the code |

## 4. Tensions with earlier personas and proposed resolutions

1. **Council 3 D8 (register paging) vs the shell's sums.** D8 is right and
   unavoidable at 45k rows; today's strip, `keyEvents.ts` and the sheets sum
   over the whole register the shell holds. Resolution: P9 lands *before* D8 —
   the figures and the tiers are served, the shell sums nothing that spans
   the register. Council 3's "server computes each time-invariant thing once
   per (hull, epoch)" already implies it; this names the rows.
2. **Council 4 U10 (`fire_watch` with `close_own_permit`) and U11 (`qa_ndt`
   raising `stop_work` only) vs the rule's `clearing_authority`.** Agreed on
   both roles. Resolution: `close_own_permit` is the *raiser ending their own
   fact* (needs P5's `raised_by`), while a clearance of any other hazard is
   authority-scoped (P7). Kind-scoping stays in the handler, as U10 proposed;
   the matrix stays the only place a capability is granted.
3. **Council 2 R10a (handling as a register column).** Agreed as transport,
   contested as ownership: the register's owner (planning) must not be able
   to change a marking. Resolution: `handling_register` is its own kind under
   `commit_handling` (security), and the register door refuses a row whose
   `handling` differs from it. R10b's segments then split on that document.
4. **Council 7 §5 (grid per hull, class table later; zone owner as a code).**
   Agreed on both. Resolution: the grid, chart v2 and exceptions sit under
   `commit_hull_document` (data steward) and are signed through P13 by the
   yard's naval architect (Q3 there); the zone `owner` is a role code or a
   person id per §5 Q6 here, never free text.
5. **Council 5 Q7 (decision idempotency, 409 on a conflicting disposition).**
   Agreed. Added: the winning rule is written on the row (`supersedes`), so a
   revised decision is a chain a reader can follow, not a newest-wins read.
6. **Council 1 A3 / council 3 D4 (ledgered commit and `hull_epoch` in one
   transaction).** Agreed; P3's version insert rides the same transaction, and
   P8's 409 is checked inside it under the per-hull lock, so the conflict
   window council 5 measured closes with it.
7. **Council 4 U13 ("NNPI never lands on disk"; the printed sheet is the
   offline mode) vs exports.** Both stand only if exports are governed:
   P10 ledgers and marks every CSV and print; whether they may exist at all
   on an NNPI hull is §5 Q7 (council 2 Q1 decides the hull).
8. **Council 2 §1.2 (`person` table unused; AC-2 inherited).** Agreed, and
   extended: the whole identity-and-permit half of 0001/0005/0006 is dead
   (P11). The directory stays the system of record for people; no person row
   is written until a directory exists — the contract §9 already says so.

## 5. Questions only the customer can answer

1. **The owner of each document**, by system name and by the person who signs
   it on data-load day: P6 (which scheduler), the ship register / C&A
   drawings (yard or NAVSEA), the grid (naval architect), couplings
   (engineering), clock/manning/budget (production control?), the rule table
   (which safety authority — and does the authority *commit* or only sign?).
2. **Which of the missing roles have directory groups and CAC sessions**:
   fire watch, fire marshal, marine chemist / gas-free engineer, ship's force
   (isolation authority), QA/NDT, the scheduler, the data steward. A role
   with no group is a role the proxy cannot assert.
3. **The clearance rule.** May a Ship Super record the clearance of an
   energised bus the isolation authority verified, or only the authority
   itself? Is a fire watch closing its own permit a clearance, or a permit
   event the fire marshal then clears? What is the override path, and who
   holds it?
4. **The daily logs as systems.** Are tag-outs, permits, coatings and
   stop-works in a permit/tag-out system with an export, or on paper? Who
   owns the column map from those logs to the five hazard kinds
   (`pilot-playbook.md:34`), and at what cadence is the log door fed?
5. **Adjudication.** When the register and the schedule disagree about a
   location, or a typed zone and the chart disagree, who decides, and is
   the decision recorded in WADL (an exception row) or in the source system
   (a re-export)? Same for two decisions on one option (council 5 Q3).
6. **Zone ownership**: a person id, a directory group, or the yard's own
   zone-manager code (council 7 Q5)?
7. **Retention and marking of superseded versions.** How long must a
   replaced register or schedule be kept, must superseded NNPI versions be
   purged on a schedule, and may CSV/print exports exist on an NNPI hull at
   all — and if so, per person, ledgered?
8. **Is the vendor seed rule set ever acceptable as the rules in force** on a
   yard's hull (the expected answer is no; P2 assumes it)?

# Pilot playbook — eight weeks at one yard

How the pilot is run: what the yard hands over before it starts and in what
shape, how the hull is loaded through the doors on the day, who opens which
screen in the first week, the weekly loop that turns what people say into a
document change or a backlog row, the success measures as statements a person
can check, the exit review, and the go/no-go rubric. It is the operating
half of `docs/programme/charter.md` ("pilot-ready" and the human-team plan);
the technical contracts it relies on are the slice packets in
`docs/programme/` and the deployment shape in `deploy/README.md`. Where a
slice this playbook depends on has not landed, the text says so and gives the
default in force meanwhile. Nothing here names a person or a date; the pilot
record (§2.5) is where those go.

Sections: 1 pre-pilot checklist · 2 data-load day · 3 first week · 4 weekly
loop · 5 success metrics · 6 exit review · 7 go/no-go rubric · 8 defaults in
force while slices land.

## 1. Pre-pilot checklist — what the yard supplies

Each item has the exact shape the door accepts, the file in
`reference/cvn73` that is the filled template, and the acceptance test. The
acceptance test is always the door's own dry run: the findings list is the
yard's review document, not ours. A row that cannot be carried refuses the
file and names the line (`crates/wadl-api/src/documents.rs`); blank lines
and `#` comments are skipped in every shape.

| # | Item | Shape | Template | Accepted when |
|---|---|---|---|---|
| Y1 | Compartment register | `deck,<code>,<label>,<ordinal>` rows, then `space,<compartment_no>,<name>,<deck_code>,<zone>,<category>[,<frame>,<side>]`; `side` ∈ `port` / `starboard` / `centreline`; ordinals above the main deck are negative | `reference/cvn73/CVN73-register.csv` (476 spaces, twelve decks) | Register door dry run: zero rejections; every finding ("would lose its space") read and accepted or fixed |
| Y2 | Coupling register | `from,to,code[,symmetric]`; codes the engine's seed binds today: `shared_bulkhead`, `electrical_bus`, `exhaust_trunk`; `deck_penetration` is **derived** by the door from deck order and frame overlap and must not be authored | `reference/cvn73/CVN73-couplings.csv` | Coupling door dry run: derived edges listed as `derived`; the yard's ventilation branches present as `exhaust_trunk` rows (the reference hull carries only two, which is why R09/R13 fire almost nowhere on it) |
| Y3 | Zone chart | `zone,lo_frame,hi_frame,top_deck,bottom_deck` (frames inclusive, decks by register code); the blocks of all zones partition every deck | `reference/cvn73/CVN73-zones.csv`; rule in `docs/zone-scheme.md` | Zones door dry run: every space falls in exactly one block; the zone managers agree the adjacency rule ("across the frame boundary, deck above or below, or coupled in") |
| Y4 | Geometry register | `deck,<deck_code>,<lo_frame>,<hi_frame>` and `space,<compartment_no>,<fwd_frame>,<aft_frame>` | `reference/cvn73/CVN73-geometry.csv` | Geometry door dry run: no space outside its deck band; GA drawings are **not** loaded through a door (H8, out of scope) — the reference plates draw the hull until then, and the Deck Explorer says so |
| Y5 | Field-condition log (one day) | `compartment,kind,label[,since]`; kinds: `hot_work_live`, `coating_open`, `energised_bus`, `flammable_stow`, `stop_work`; `since` is a wall-clock instant in the yard clock | `reference/cvn73/CVN73-hazards.csv` | Hazard-log door dry run: rows already live are skipped and say so; the mapping from the yard's tag-out, permit and coating logs to these five kinds is written down as a column map (a document), never as code |
| Y6 | Yard clock (S10) | `zone,<IANA>,<±HH:MM>` · `daylight,<±HH:MM>,<m>,<week>,<weekday>,<HH:MM>,<m>,<week>,<weekday>,<HH:MM>` · `watch,<minutes>` · `shift,<name>,<start>,<end>` (one record kind per line; a shift whose end precedes its start crosses midnight) | `reference/cvn73/CVN73-clock.csv` once S10 lands; the Norfolk default is in `docs/programme/s10-yard-clock.md` | Clock door dry run: the preview's `shifts_today` read as the yard names its shifts; the transitions match the yard's calendar |
| Y7 | P6 export | The XER as P6 writes it on the yard's server (Windows-1252 assumed; UTF-16 is not decoded), plus the WBS dictionary and the activity-code dictionary | `reference/p6-sample/CVN73-PIA26-full.xer` (5,706 activities) | XER door dry run **under the field map** (Y8): the quarantine list is read line by line by the scheduler and agreed; `located_authored` is the number the scheduler expects |
| Y8 | P6 field map (S13) | JSON `{ compartment: {source,name}, work_item: {source,name}, work_type: {source,name}, trade: {source}, projects: [...], placards_from_names: bool }`; `source` ∈ `udf` / `activity_code` / `resource` / `none` | `reference/cvn73/CVN73-fieldmap.json` once S13 lands; the questions are `handoff/03-p6-field-crosswalk.csv` | The map is chosen on the Sources card from the fields the export actually carries (`fields_seen`), not typed from memory |
| Y9 | Budget book | `code,title,trade,budget_mh,earned_mh` per work item | `reference/budgets/CVN73-budgets.csv` | Budget door dry run: findings name every work item the schedule carries and the book does not, and the reverse |
| Y10 | Manning book | `trade,headcount` per watch (the shell's `parseManningCsv`; the door body is `{ label, crews: [{ trade, headcount }] }`) | none committed; the door test `crates/wadl-api/tests/manning.rs` shows the body | Manning door dry run: `register_trades_with_no_manning_line` is empty or accepted |
| Y11 | Rule table | The safety authority's rows, through the rule door (S14) after the sitting; until then the seed | `handoff/01-rule-table.csv`; brief in `docs/briefs/safety-authority-sitting.md` | Every row in force has a signed golden trace, or the signed hot-work-only fallback is on file |
| Y12 | Identity-proxy contract | The header contract, signed by the proxy owner | `docs/briefs/proxy-owner-contract.md` | The staging test in that brief passes: `whoami` reports `proxy-asserted` and (after S12) a person |
| Y13 | PostgreSQL host | Version 16, a DBA, a backup policy, who applies migrations, who owns `wadl_app` | `deploy/README.md`; runbook and restore drill are S15 | `wadl migrate` applied by the DBA; a restore drilled from a backup before data-load day |
| Y14 | ATO vehicle | In writing from the ISSO or AO: IATT, or a change to the enclave's ATO, and the FIPS 199 level and marking | `docs/ato-package.md` | The vehicle names the pilot; the marking string is set as `WADL_MARKINGS` (S12) |
| Y15 | Named users, devices, the room | The 5–15 people by role (the eight role codes in `docs/programme/s12-person-in-the-ledger.md`), the tablets, the wall display, and the spreadsheet the morning meeting runs off today | the role cards (S20) | Every named person has logged in through the proxy once before week 1 |

Two items the checklist cannot make honest by itself:

- **The hull row.** No door and no route creates the organisation, class,
  vessel or availability rows on PostgreSQL; only `crates/wadl-store/src/pg_seed.sql`
  (the demo world, applied by `wadl seed`) does. The pilot hull is bootstrapped
  by the DBA from a written statement (org uuid, class, hull number, name,
  availability code and bounds) that is filed with the data-load record and
  read back through `GET /api/vessels` before any door is opened. This is the
  one write on data-load day that is not a door; it is recorded as such, and
  it is the reason S15/S16 should add a `load-docs`-shaped bootstrap. Until
  they do, this paragraph is the procedure.
- **The survey the yard mails back.** The charter asks the yard to run an
  `ingest-xer` survey on its own export and return UDF names, encoding and
  counts with no schedule content. Today's `wadl ingest-xer --input` prints
  the graded report, which lists activity codes; the content-free survey is
  S13's `--survey`. Until it lands, the yard answers Y8's questions from P6's
  own UDF and activity-code dictionaries, and the export is opened only on the
  yard's host.

## 2. Data-load day

One engineer at the keyboard, the yard's scheduler beside them, the yard's
safety authority or their delegate reachable, the DBA on call. The instance
is the yard's PostgreSQL behind the proxy, `WADL_PROXY_KEY` set,
`/api/whoami` answering `proxy-asserted`. Nothing is loaded through the dev
shim.

### 2.1 Before the first door

1. `GET /health` reports the store reachable and the expected migration
   count; `GET /api/vessels` lists the pilot hull and nothing else.
2. `scripts/self-assessment.sh` against the instance (through the proxy):
   no FAIL; the only WARN permitted is none. WADL-SA-05 must read
   `proxy-asserted`.
3. `GET /api/vessels/:id/ledger` reads `verified: true` on an empty or
   bootstrap-only chain.
4. The data-load record (§2.5) is open with the hull-row statement filed.

### 2.2 The order of the doors

The order is the dependency order, and it is the same order the boot loader
uses for the reference hull:

| Step | Door | Depends on | What the findings must say before commit |
|---|---|---|---|
| 1 | Yard clock (Y6) | — | shifts named the yard's way; no uncovered hours the yard did not intend |
| 2 | Compartment register (Y1) | — | zero rejections; every "would lose its space" finding accepted by the scheduler |
| 3 | Geometry (Y4) | 2 | every space inside its deck band |
| 4 | Zone chart (Y3) | 2 | every space in one zone; zone managers' names against their zones on the record |
| 5 | Couplings (Y2) | 2, 3 | derived deck penetrations counted; ventilation branches present |
| 6 | Field-condition log (Y5) | 2 | every row lands on a register space; kinds mapped by the column map |
| 7 | Budget book (Y9), manning book (Y10) | 2 | the coverage findings accepted |
| 8 | P6 field map (Y8) | 7's export in hand | chosen from `fields_seen`; the compartment source named |
| 9 | Schedule of record (Y7) | 1, 2, 8 | quarantine list agreed line by line; `located_authored` as expected; excluded LOE and WBS rows listed |
| 10 | Rule table (Y11) | sitting held | golden trace per row signed, or the fallback signed |

### 2.3 Per door — the procedure

For every door, without exception:

1. **Dry run.** `POST …?dry_run=true` from the Sources card (the card stages
   a dry run before every commit) or, once S16 lands, the CLI door over the
   same code path. Nothing is stored.
2. **Findings read.** The named yard person for that document reads every
   finding and every rejection aloud or on the wall display. A rejection is
   fixed in the file, never in the database. A finding is accepted (written
   on the record) or fixed in the file and the dry run repeated.
3. **Signed.** The dry-run response is saved as
   `dataload/<step>-<kind>-dryrun.json`; the signer's person id (the
   `x-wadl-person` value the proxy asserts for them) and the finding count
   are entered on the data-load record against that file.
4. **Commit under that person.** The commit is sent from the signer's own
   session, so the ledger row carries their person id (S12; until S12 lands
   the row reads `unattributed`, and the record carries the name instead —
   see §8). The card's status word flips to `INGESTED` with the label and
   provenance.
5. **Verify.** `GET …/ledger` shows the `DOCUMENT_REPLACED` (or
   `SCHEDULE_REPLACED`) row newest, `verified: true`; the row's `seq` is
   written on the record beside the signature.
6. **Revert is available and known.** The signer is shown the revert button
   once; a revert is also a ledger row under a person.

No hand SQL. The DBA's session is used for `wadl migrate` and the hull row
only, both before the first door; if anything else needs SQL on the day, the
day stops and the gap becomes a backlog row (§4.3) with the statement of what
the door could not do.

### 2.4 Rehearsal

The whole of §2.2 is rehearsed on the reference hull through the same doors
(`WADL_DEMO_DOCS=reference/cvn73` is that rehearsal run by the boot loader;
the manual rehearsal drives the cards) and once on a copy of the yard's files
on a staging instance, before the day. The rehearsal's timings go on the
record; a step that took longer than fifteen minutes in rehearsal is
rehearsed again.

### 2.5 The data-load record

One page, kept with the evidence bundle (`docs/ato-package.md` §5): the hull
row statement; a row per door with step, label, dry-run file, findings count,
accepted findings, signer person id, ledger `seq`, commit instant in the yard
clock; the `ledger` `verified` verdict at the end of the day; the
`self-assessment.sh` output before and after. It is the proof for
pilot-ready item 1 in the charter.

## 3. First week — who opens which screen when

The roles and landing screens are `docs/demo-script.md`'s; the capability
each role holds is S12's matrix. Times are in the yard clock's shift names.

| When | Who | Screen | What they do | What we watch |
|---|---|---|---|---|
| Start of Days shift, before the morning meeting | Foreman (one per trade in the pilot) | **Daily Ops** | reads their column: what the crew may start, what is held and by whom; prints the *Shift sheet* | whether the column is read without a tour guide; which rows they ask about |
| Same, thirty minutes before the meeting | Zone Manager (each pilot zone) | **Deck Explorer**, zone in focus | reads their zone worst first and the *Next door* strip; opens one held space and reads the trace | whether the trace reads in yard words; whether a "next door" row surprises them |
| Same | Safety | **Conflicts & Risk** | reads the issue list worst first, man-hours at risk; opens the cascade of the top action | whether the ranking matches their own |
| The morning meeting, on the wall display | Ship Super runs it | **Deck Explorer** at ship altitude, then **Daily Ops**, then **Conflicts & Risk** | decides the day's holds and clearances in front of the tool; every clearance recorded by Safety or the Ship Super with its basis | pilot-ready item 8 in practice; the baseline spreadsheet is on the table next to it in week 1 only |
| After the meeting | Planner | **Sequence Board** | *Not executable* filter; opens refusals; proposes to P6 where the engine found a window; downloads the change-request CSV | whether a proposal reaches P6 the same day |
| Mid-shift | Safety or Ship Super | **Deck Explorer** | records the clearances the meeting decided, each with its basis; scrubs back an hour once to see the hold that was there | every clearance has a basis and a person |
| End of Days | Foreman | **Reports** → *Zone day sheet* or *Shift sheet* for the next shift | hands the printed sheet to the Swing foreman | whether the hand-off uses the sheet or the old form |
| Once, day 1 and day 5 | Project Manager | **Portfolio** | reads the hull's confidence; tries the unassigned hull and sees the refusal | nothing else is expected of this role in the pilot |
| Weekly, first on day 5 | Scheduler | **Data Sources** → XER door | dry-runs the week's export under the stored field map; reads the delta and the quarantine; commits; the delta says which proposals P6 reflected | the quarantine list is agreed; run history (S13) shows the run |
| Daily, end of Days | The engineer | **Decisions Ledger**; `journalctl -u wadl` | chain verify reads clean; every row since data load names a person; refusals in the audit stream reviewed (401/403/404/413/422/503) | any 5xx is a defect; any `unattributed` row after S12 is a defect |

The engineer sits in the room for the first five meetings and does not touch
the keyboard during them.

## 4. The weekly loop

### 4.1 The ledger review (Safety, the engineer, thirty minutes)

Checked every week, written on the pilot record:

- `GET …/ledger` → `verified: true`; the count of rows since the last review.
- Every row names a person (`actor_id` not `system:unattributed`); the
  people named are pilot users.
- Every `HAZARD_CLEARED` row carries a basis; the clearing person holds
  `clear_hazard` in the matrix (a 403 in the audit stream for a clearance
  attempt is read as a finding about the matrix, not about the person).
- Every `DOCUMENT_REPLACED` and `SCHEDULE_REPLACED` row corresponds to a
  signed dry run on the data-load record or the week's scheduler run.
- Open proposals: which were reflected by the week's export, which are
  still open, which were withdrawn and why.
- The audit stream's refusals grouped by status; any 503 (shed or timeout)
  is a scale finding for `docs/stress-test.md`.

### 4.2 The feedback triage (the pilot's named yard lead, the engineer)

Everything people said during the week goes on one list, then each line is
placed in exactly one of three bins:

| Bin | Test | What happens |
|---|---|---|
| **Document change** | The yard's answer replaces a default the product already carries as data: shift names or hours (clock), a compartment source (field map), a zone boundary (chart), a coupling the crew disputes (couplings; rule R14's challenge is a coupling-register change, signed), a hazard-log column, a rule row or a clearing authority (rule table, through the sitting), the marking string, a role assignment | Dry run → findings → signed → commit, same procedure as §2.3, that week; no code changes |
| **Backlog row** | A behaviour the product does not have (an issue with an owner and due-by, a Tomorrow view, a drawing door) — the review's H items or something new | One row in `docs/BACKLOG.md` under "Other deferred work": what was asked, who asked (by role, not name), the screen, and the evidence (a screenshot or the ledger seq); built in flight only if it is on the charter's pilot list (H1, H3, H4, H5, H7) |
| **Defect** | The product did something its own docs or tests say it does not (a 5xx, an empty list where "unavailable" was due, a wrong figure against its provenance, a clock off by the offset) | A regression test that fails today, the fix, the gates green, a checkpoint push; the ledger seq or audit line that showed it is quoted in the commit message |

The rule that keeps the pilot honest: **a yard's answer never becomes a code
change**. If the only way to carry an answer is code, that is a backlog row
that says so, and the default stays in force until it is built.

### 4.3 What the week produces

- The ledger review lines (§4.1) and the triage list with bins, on the
  pilot record.
- Any document changes as ledger seqs.
- Any backlog rows as a commit to `docs/BACKLOG.md`.
- Any defects as commits with tests.
- The week's XER run: label, `seq`, quarantine count agreed.

## 5. Success metrics — checkable statements

Each is true or false at the exit review, with the evidence named.

| # | Statement | Evidence |
|---|---|---|
| M1 | The morning meeting ran off the tool on the wall display every working day of weeks 3–8; the baseline spreadsheet was not opened in the meeting after week 2 | the pilot record's daily line; the audit stream shows `/api/vessels/:id/deck-states` reads in the meeting window each day |
| M2 | At least one conflict per week from week 2 was found by the tool and adjudicated through it: an issue acknowledged or a clearance recorded with its basis, in the ledger, under a person | one ledger seq per week on the record |
| M3 | Every clearance in the pilot is a `HAZARD_CLEARED` row with a basis and a person id; no clearance was recorded anywhere else first | ledger export; the yard's own permit log reconciled weekly |
| M4 | The yard's XER re-imported every week through the door under the stored field map, and the quarantine list of each run was agreed by the scheduler | the runs table (S13); the record's weekly line with the scheduler's person id |
| M5 | The chain verified clean at every weekly review and at exit | `verified: true` on the record; `wadl verify-ledger --input <export>` at exit |
| M6 | Every ledger row since data load names a pilot user | the review lines; zero `unattributed` rows after S12 |
| M7 | No hand SQL after the hull row on data-load day | the DBA's statement; the record |
| M8 | Every clock on screen and on every printed sheet read yard-local with the zone shown once, and no user reported a time off by the offset | the defect list has no clock defect open at exit |
| M9 | `self-assessment.sh` against the instance had no FAIL and no WARN at data load and at exit | the two outputs on the record |
| M10 | Every pilot user completed their role's tasks (§3) unaided by week 2 | the training sign-off (S20 role cards) |
| M11 | A proposal made in the tool was reflected by a later P6 export and the delta said so | the `proposals_reflected` line of a run |
| M12 | A backup was taken weekly and a restore was drilled once during the pilot on the yard's PostgreSQL | the runbook's drill line (S15) |

## 6. The exit review

Held in week 8 with the yard lead, the scheduler, Safety, the ISSO's
representative and the engineer. The agenda is the evidence, in this order:

1. §5 read aloud, each statement marked true or false with its evidence on
   the table.
2. The ledger export at the release tag, `verify-ledger` run in the room.
3. The runs table: eight weekly imports, the quarantine counts, the field
   map as it ended (and every change to it as a ledger seq).
4. The triage list: every line binned; the document changes as seqs; the
   backlog rows; the defects with their tests.
5. `self-assessment.sh` run in the room against the instance.
6. The rule table in force and its golden traces, or the signed fallback,
   and the list of rule questions still open.
7. The ATO package status against `docs/ato-package.md` §2: which artifacts
   were handed to the ISSO, which are still marked missing.
8. What the yard would need before a second hull (the review's §6 items
   that the pilot actually hit).

The output is the pilot report: §5's table with verdicts, the four lists
above, and the go/no-go for continuation (§7.3). It is committed to
`docs/` at the release tag with the evidence bundle.

## 7. Go/no-go rubric

Three gates. Every line is a yes or a no; a no on a **hard** line is a
no-go; a no on a **soft** line is written down with its mitigation and the
gate proceeds.

### 7.1 Pilot start (the rehearsal in the room)

| Line | Hard/soft | Check |
|---|---|---|
| The yard's documents are loaded through the doors on the yard's PostgreSQL behind its proxy; the data-load record is complete | hard | §2.5 |
| `/api/whoami` through the proxy reports `proxy-asserted`; an empty key refuses to boot | hard | proxy brief test |
| Every ledger row since data load names a person (S12 landed) | hard after S12; soft before, with §8's compensating record | ledger read |
| `self-assessment.sh`: no FAIL, no WARN | hard | output on the record |
| Every clock yard-local; the shift names the yard's | hard | Daily Ops chips; a printed sheet |
| Rules in force are the authority's table with golden traces, or the signed hot-work-only fallback | hard | the sitting brief's sign-off table |
| Deck-states and issues answer inside one second on the yard's host at its register size | soft | `docs/stress-test.md` entry for the yard's host |
| A backup taken and a restore drilled; a release tagged; `/health` reports the version | hard | S15's runbook line |
| Every named user has logged in through the proxy and completed their role's tasks | hard | training sign-off |
| The ATO vehicle is in writing | hard | the ISSO's letter on file |
| The rehearsal walk (`docs/demo-script.md` on the yard's hull) passed in the room | hard | the rehearsal record |

### 7.2 Continuation at week 4

| Line | Hard/soft | Check |
|---|---|---|
| The meeting ran off the tool every day of weeks 3–4 | hard | pilot record |
| At least two conflicts adjudicated through it | hard | ledger seqs |
| The chain verifies; no `unattributed` rows | hard | review lines |
| Weekly XER runs agreed by the scheduler | hard | runs table |
| No open defect that made a board read good news it could not prove | hard | defect list |
| No open document change waiting more than one week | soft | triage list |

### 7.3 Exit (continuation beyond the pilot)

Go when M1–M9 are true and at most two of M10–M12 are false with a named
closure; no-go otherwise. A no-go is still a completed pilot: the report is
written and the package handed over.

## 8. Defaults in force while slices land

The pilot's calendar is set by the yard's inputs, and the programme's waves
(`docs/programme/programme.md`) may still be landing when this playbook is
first used. What is in force meanwhile, and the compensating record:

| Slice | If not landed | Compensating record |
|---|---|---|
| S10 yard clock | every clock is UTC; the shift chips read Days 0700–1530 Z | no-go for pilot start (7.1, hard); the pilot does not start on a UTC clock |
| S12 person | the ledger's `by_person` is NULL and the actor reads `unattributed`; whoami has no person | the data-load record and the pilot record carry the person against every ledger `seq`; hard line at 7.2 |
| S13 XER survival | a UDF not named `compartment` imports unlocated; one bad row refuses the file; UTF-8 only | the yard's export is converted to UTF-8 and the UDF renamed in a copy, and the copy is filed as a finding; the survey is answered from P6's dictionaries |
| S14 rules | the seed is in force and applies to every activity regardless of work type | the hot-work-only fallback signed at the sitting, and the sitting brief's default table |
| S15 run it | no runbook, no tagged release, no restore drill | no-go for pilot start (7.1, hard) |
| S16 PostgreSQL proof and CLI door | the API suite runs in-memory in CI; no CLI door | data load through the Sources cards only; the hull row per §1 |
| S17 proof | no Playwright walk, no evidence bundle | the rehearsal is driven by a person and screenshotted; the bundle is assembled by hand per `docs/ato-package.md` §5 |
| S20 words and cards | some labels are not yet yard words; no role cards | the training session uses `docs/demo-script.md` directly |

# Demo script — one morning on CVN-73, role by role

A scripted walk over the reference hull that `scripts/dev.sh` boots: the
generated USS George Washington (CVN-73) register in `reference/cvn73`, the
sample P6 export `CVN73-PIA26-full.xer` as the schedule of record, and a
morning's hazard log. Every name below is a real row in those documents, so
the walk can be rehearsed and it lands the same way each time. Times are
relative to the moment the API booted (the log is stamped "this morning"),
so read the clocks on screen rather than off this page.

Twenty-five minutes at a steady pace. The order follows the working day: the
crew's shift and the next one, the zone and its key event, the schedule,
the conflicts, the record.

Before starting: `scripts/dev.sh`, open <http://localhost:5173>, and pick
the hull **CVN-73 · PIA-26** in the hull dropdown if it is not already
selected — the dropdown is what `/api/whoami` served, plus two hulls marked
*not assigned · demo*. The hull is 476 spaces on twelve decks, 5,706
activities, six zones (`docs/zone-scheme.md`).

The role button wears an amber **DEMO MODE · dev identity** badge: the dev
shim is not a login. Every role you pick below is a demo person the shell
asserts (*Demo Foreman (Y-1006)*, *Demo Safety Officer (Y-1007)*, …), the
server resolves it, and the ledger names it — so switching role switches
what you may do. Open the role menu once and read the signed-in block: who
the server thinks you are, the roles, and *may: …* — the doors your role
opens. Behind the yard's proxy the same menu shows the person the CAC
session asserted, read-only (`docs/identity-proxy-contract.md`).

## 1. Foreman — "what is my crew doing at 0700, and what does the next shift walk into?" (5 min)

Role menu → **Foreman**. The front door is **Daily Ops**, the shift board;
the role button reads *Demo Foreman (Y-1006) · Foreman*.

- The status strip at the top carries the same four numbers on every screen:
  spaces that permit work, held, idle, latent. Open **Legend** once and say
  the four words in yard terms; that is the whole vocabulary of the product.
- The board is one column per trade, worst first. Columns fold at 25 rows
  with a "show all" foot, so the sheet-metal column reads as a column and not
  a scroll. Point at a held row: the hazard holding it and who clears it are
  on the row, not behind a click.
- The clocks are the yard's. The shift chips read `This instant · Days
  0700–1530 · Swing 1530–2400 · Mids 0000–0700` — the yard's own shifts from
  `CVN73-clock.csv`, on the local calendar day — and the slice line reads
  `Days 0700–1530 · 09/04` with no `Z` anywhere on the board; the time strip
  names the zone once, `America/New_York · UTC−04:00`, and the watch chips
  beside it read `00–04 … 20–24`. The export's `06:00` is Norfolk's 06:00
  (10:00Z in summer) because the schedule was read in the hull's clock,
  loaded at boot before the export — the banner says `parsed in
  America/New_York`. Scrub to the first Sunday in November and the `00–04`
  chip says it is five hours that night. In **Data Sources**, discard the
  Yard clock card: the strip turns amber `UTC · no yard clock loaded`, every
  time on every screen carries `Z` again, and the Decisions Ledger records
  `DOCUMENT_REVERTED · yard_clock` — the product says "no yard clock" rather
  than guess one. Restart the API to get the clock back.
- **Reports** → *Shift sheet* → print. The sheet carries hull, instant,
  schedule source and the producer, and each figure names its layer
  (schedule of record, engine, or shell estimate). A zone filter cuts it to a
  zone; the sheet is otherwise complete on purpose, because a print-out with
  rows missing is a print-out that lies.
- The fourth chip is **Tomorrow** — the next of the yard's shifts after the
  instant on the clock, named the yard's way (`Tomorrow · Mids 0000–0700 ·
  09/07`; it reads `Next shift · Days 0700–1530 · 09/06` when the next shift
  is still today). The board re-evaluates that shift's work against the
  engine *at the shift's start*, and the amber strip says so: `PROJECTED ·
  evaluated by the engine at 09/07 00:00 under the field conditions recorded
  as of 09/06 20:38 · overnight tag-outs are not on this board · NOT AN
  AUTHORIZATION`. Read the headline left to right — activities and MH on the
  shift · **clearable tonight** · **clears on its own** · **needs a plan** ·
  **sendable** — then the sections. *Clearable tonight* is one card per
  action: the clearing authority as the badge (`ISOLATION AUTHORITY`,
  `ISSUING AUTHORITY`), the hazard (*Bus live · Switchgear Room No. 1 — no
  verified zero-energy state*), the origin as a link to the plate, *frees 9
  spaces · 33 activities · 157 MH on the shift*, the trades, and `ASSUMES
  ATTENDANCE` — the platform re-evaluated the effect; whether the authority
  comes is not something it knows. On the reference hull this morning the
  three energised buses and the two weapons stop-works are the phone calls.
  *Clears on its own* lists the curing coats: `✓ CURED BEFORE THE SHIFT`
  with the time (their work is sendable), `⏳ CLEARS DURING THE SHIFT ·
  clears at 04:28 — send the crew after`. *Needs a plan* is the forward pump
  room and its like: no clock, no single action, `open the options panel`.
  *Sendable* is the shift board's own trade columns with no HELD word on
  them — nothing in that section is held at the start, which is the point.
  **⎙ Print sheet** cuts *Tomorrow's board*: the projection note first in
  the footer, a section per clearing action with its work, the two hold
  sections with their work codes, the trades, and each figure's layer. Kill
  the API and reopen the chip: one amber *Projection unavailable* block, no
  sections, no zero counts.

## 2. Zone Manager — "my zone, what is next door, and what is between us and the key event" (7 min)

Role menu → **Zone Manager**. The front door is **Deck Explorer** with the
role's zone in focus. Put **Z4** in focus if it is not (the focus bar above
the plate): the machinery block, 2nd deck to 2nd platform frames 96–191 and
hold to double bottom frames 116–175. Z4 has the most held spaces on the
hull this morning.

- Everything outside Z4 is ghosted on the plate and in the whole-ship
  section, and the register below shows only Z4 rows. That is the manager's
  ask: only my zone.
- The **Next door** strip lists the work the manager is *not* responsible for
  but must know about, each with the reason it is there: across the frame
  boundary, on the deck above or below, or coupled into the zone by a
  penetration. First row this morning: **2-91-2-L Crew berthing No. 9** in
  Z3, across the frame boundary, held by a curing deck coat. A blast in Z4
  at frame 96 needs to know that.
- Open **3-148-2-E Switchgear Room No. 2** (3rd deck, held). The decision
  trace reads in yard words: rule R07, the energised bus 3-SG-2 with no
  verified zero-energy state, cleared by the isolation authority. The
  priced options below it are the engine's, ranked by hours freed.
- **Record administrative clearance…** is grey for a Zone Manager, and its
  tooltip is the server's own sentence: *Zone Manager may not record a
  clearance — clear_hazard is held by Ship Super and Safety*. Switch role to
  **Safety**, come back to the space, and record the clearance with its
  basis. Every space the bus held re-derives on the plate. Scrub the clock
  back an hour (the clock control in the header): the hold is there again.
  The past does not change because somebody acted in the present; both
  stores keep it that way. Switch back to **Zone Manager** for the sheet.
- **Reports** → *Zone day sheet* for Z4, the same cut on paper.
- **Week Ahead**, with Z4 still in focus: *"What stands between us and
  Light-off assessment"* — the next key event the schedule's own logic ties
  Z4 work to (the Z1 and Z3 close-out reviews come first on the calendar
  but gate nothing in Z4; leave focus and the board keys to the Z1 review).
  The stats read the date and days away, the gating activities and MH left
  in them, **miss the event** in red, **slide and still make it**, **cannot
  be assessed**, **proposals open**. The picker lists every upcoming
  milestone; the production reviews, crew certification, fast cruise and
  end of availability are dimmed, and the line under the picker says why:
  *no logic ties work to them*. The seven-day strip counts starts and
  refusals per yard day over the gating set. The table is worst first: six
  Z4 activities `MISSES THE EVENT` — the megger test on lighting circuit 8A
  in the fan room and the overhead coating in Switchgear Room No. 3, each
  with the hold on the row (*R07 · Bus live · Switchgear Room No. 3 — no
  verified zero-energy state at 4-180-2-E · isolation authority · clears on
  verification*) and the margin the schedule of record has against the
  event; then `on plan · margin 109 d` rows in green. **Inspect →** opens
  the same inspector the Sequence Board uses; *Propose to P6* is grey for a
  Zone Manager with the server's sentence. As **Planner** the proposal lands
  in the ledger and the row's *Proposal* column reads `#n OPEN → …· makes
  it` or `misses it` against the event date; withdrawing on the Sequence
  Board's Proposals view turns it back to `—`. **⎙ Print sheet** is the
  key-event readiness sheet: the cut, the gating work with the hold and the
  why in one column, the seven days, the events without logic, and the
  layer of every figure.

## 3. Planner — "fix the schedule and tell P6" (5 min)

Role menu → **Planner**. The front door is the **Sequence Board**, the
activity register: 5,706 activities from the XER, located to spaces where the
export names one, and marked *unlocated* where it does not (milestones, for
example) rather than guessed.

- The chips under the headline are the register's own audit: *not
  executable* (the space refuses work during the planned window), *viable
  re-sequences* (the engine found a later window), *need verification*
  (no date can honestly be promised), *unlocated*, *from task names*. Tick
  **Not executable** in the filter row to cut the register to the refusals;
  the *Lanes* view draws the same rows on one calendar with the viable
  windows as green ghosts.
- Find **A51350 Blast / mechanical prep deck coating 2A — JP-5 service
  tank No. 3** in 6-216-1-J: suspended under R04 by hot work permit 2673 in
  shaft alley No. 3, the fire marshal's to clear — *clears on verification*
  until permit 2673 closes, then for the thirty-minute fire watch that runs
  from the close. Open it. The inspector
  shows the evidence and the engine's alternative: a viable window after the
  earliest clear, the delay in hours, and the one activity it pushes
  (A51360). The knock-on is computed, not estimated, and the basis says so.
- **Propose to P6**. The proposal is ledgered as a schedule change with the
  checked window and its knock-on. Switch to the **Proposals** view: status
  *open*, derived on every read. Download the **change-request CSV**; it is in
  P6's import layout, one row per activity, so the scheduler's side of the
  loop is a paste, not a transcription.
- Close the loop: **Data Sources** → the XER door → dry-run an export that
  carries the proposed days. The delta reports the proposal as *reflected*
  and lists any still open. Nothing in the product edits the schedule of
  record; P6 stays authoritative and the product proves whether P6 heard.

## 4. Safety — "what is worth doing first" (3 min)

Role menu → **Safety**. The front door is **Conflicts & Risk**.

- The board is the engine's issue list, worst first, with the man-hours at
  risk from the schedule of record. Top of the list this morning is a
  **stranding concentration at 3-160-2-Q** (a passage and trunk on the 3rd
  deck, coating curing, five downstream segments behind it) and the
  **Forward pump room 4-74-0-Q**, held with crews booked, about a thousand
  hours at risk, the isolation authority's to clear. The board renders fifty
  rows at a time and says so at the foot; the count is the whole list.
- **Deconfliction Cascade**: pick the top action (waiting out the curing
  coats frees the most hours this morning) and read the chain of what clears
  when it does, deck by deck; the origin is never re-emitted as its own
  effect.
- Back on **Conflicts & Risk**, **acknowledge** the pump-room issue. Then
  **Decisions Ledger**: the acknowledgement is the newest entry, stamped on
  the wall clock, its **By** column reads *Demo Safety Officer (Y-1007)*,
  the clearance from §2 is a few rows down under the same name, and the
  chain verify at the top reads clean with the chain format beside the
  count. (A row the binary wrote on its own account — a CLI load, say —
  reads *⚙ system:…*; a row from before people were asserted reads
  *— before format 2* and still verifies.) Every clearance,
  document commit, proposal and acknowledgement is in this one chain, and
  every row names who answered — the name a board of inquiry gets. Scroll
  to the bottom: the chain does not open empty. Its oldest rows are the
  boot itself — seven `DOCUMENT_REPLACED` rows (`yard_clock`,
  `p6_field_map`, `compartment_register`, `zone_register`,
  `geometry_register`, `coupling_register`, `hazard_log`) and the export's
  `SCHEDULE_REPLACED`, each `via: boot` under *⚙ system:boot* — the truth
  about where the served hull came from, written by the same loader
  `wadl load-docs` runs from the DBA's session on data-load day (then the
  rows read `via: cli`).
- **Safety signs the table after the clearance.** Still as Safety, open
  **Data Sources** and find the **Rule table** card. At boot it reads
  `SEED` — *10 entries in force from 10 rows*, *unsigned — the seed is in
  force; the safety authority signs a committed table*, and the work-type
  line in amber: *unbound: coating, electrical, inspection, insulation,
  mechanical, rigging — judged by the any-work rows only*. **Sign this
  table** is disabled with the reason (the seed is not signed here). Switch
  to **Planner**, **⭱ Upload rule table CSV** with
  `reference/cvn73/CVN73-rule-table.csv` — the seed in the handoff's own
  22 columns (Export CSV hands out the same file). The staged bar reads
  *10 entries in force from 10 rows · replaces seed_usn_hot_work (seed) ·
  0 spaces change state right now*, and the fold under the card lists every
  row — R03 BLOCK same space, hot_work, hold 480; R04 SUSPEND
  deck_penetration 1 hop, any work, *hold 30 min from the permit's close*,
  *fires on 8 spaces*; R09 twice, SUSPEND for hot work and WARN for the
  rest — each with the seed's version id. Confirm: the card reads
  `INGESTED`, *unsigned — committed, awaiting the safety authority's
  signature*, and the Sequence Board's **RULES** chip reads
  *CVN73-rule-table.csv unsigned* in amber. Planner's **Sign this table**
  is disabled: *Planner may not sign the rule table — sign_rule_table is
  held by Safety*. Switch to **Safety** and click it: the statement is
  written for them — *I, Demo Safety Officer (Y-1007), have read the 10
  entries in force of CVN73-rule-table.csv (…) against the golden traces
  and sign this as the table the hull runs* — edit it or not, then **Sign
  as Demo Safety Officer (Y-1007)**. The card reads `SIGNED` with *signed
  by Demo Safety Officer (Y-1007) · <stamp> · ledger #n*; the **Decisions
  Ledger**'s newest row is `RULE TABLE SIGNED` under the same name with the
  statement and the hash; the Sequence Board's chip reads *signed* in
  green. Upload the table again with R04's hold changed to 60 and Confirm:
  the card is `INGESTED` and *unsigned* again — the signature was of a
  hash. Discard brings the seed back.

## 5. Ship Super and Project Manager — "the hull, worst first" (2 min)

Role menu → **Ship Super**. The front door is the **Deck Explorer** at ship
altitude, all zones, worst first; the zone lanes show where the held spaces
concentrate (Z4, then Z5). **Week Ahead** with no zone in focus keys to the
Z1 close-out review on 12/19 — the earliest key event with logic — and the
picker flips to the Z4 review or the light-off assessment in one click; the
Ship Super's question is which key event the buses are about to cost. **Portfolio** for the Project Manager: every hull
the reader is assigned, class, availability and confidence (CVN-73 reads
*At Risk*), and the hull the reader is not assigned refuses with the
reason, which is the row-level security story in one click. The role menu
says the Project Manager *may: answer for an option or an issue* and
nothing else — on Data Sources every Confirm and Discard is grey with the
sentence, and the dry run still works.

## 6. Data Sources — "where every number came from" (2 min)

**Data Sources** is the home of the documents the hull *is*: the compartment
register, the coupling register (derived deck penetrations marked
*derived*), the zone chart, the geometry, the hazard log, the P6 field map,
the schedule of record. Each door has a dry run, a mapping report and a
revert, and each commit is a ledger entry under the person who committed
it. Committing needs a **Planner** (the card says *anyone may dry-run;
committing needs Planner* for any other role).

The line under the hull in the top bar reads *reading CVN73-PIA26-full.xer
· imported … by org …0001 (no person on record) · at boot* — whose export
every screen is on, and since when. The schedule card says the same with
*run #1*.

As Planner, upload `reference/p6-sample/CVN73-PIA26-yardshape.xer` on the
schedule card — an export shaped the way a yard's P6 actually writes one.
The staged panel reads *11 activities · 6 edges · 1 key events · projects
served: CVN73-PIA26, CVN73-DSRA27* and *0 of 10 authored*: this file
carries no UDF named `compartment`. The **Field map** panel says so and
offers what the file does carry — *UDF: COMPT — Location placard (8 rows)*,
*Activity code: LOC*. Pick COMPT: the dry run re-runs and the line moves to
*7 of 8 authored · 1 read from task names* once you also untick
**CVN73-DSRA27** under *Projects served*. The **Quarantine** fold lists
three rows with their line and reason — line 44 an unparseable date, line
45 a width error, and the DSRA predecessor as cross-project logic; the
**Excluded** line reads *3 level-of-effort (A9001, A9002, A9003) · 1 WBS
summary (Z6-SUM) · 2 in project CVN73-DSRA27*; **Hours** says *1 material
and 1 equipment assignments not in anyone's man-hours*. Confirm. The crumb
now reads *reading CVN73-PIA26-yardshape.xer · imported … by Demo Planner
(Y-1001)*; the Decisions Ledger has the field map (`DOCUMENT_REPLACED
p6_field_map`) and the run (`SCHEDULE_REPLACED`, `quarantined: 3`) under
the Planner's name.

Open **Runs**: *#2 SERVED* and *#1 CVN73-PIA26-full.xer*. *diff vs served*
on #1 renders the delta in the door's words (*+5706 new · −9 gone · ⚠ 414
newly NOT executable …*). *serve this run…* on #1 asks once — *a revert to
a prior import, ledgered as SCHEDULE_REPLACED naming both runs* — and the
whole product steps back to the reference export: the crumb flips, the
Sequence Board re-renders 5,706 rows with the same activity ids as before.
Switch to Foreman and stage the same file: the dry run runs, the Confirm
and serve buttons are disabled, and the card says *Foreman may not commit
or revert a document — commit_document is held by Planner*.

Re-import the morning's hazard log as any role that may raise: rows
already live are skipped and say so; raise one from the log and watch the
plate.

## What to say when asked

- **Is this real geometry?** No. The register is generated at believable
  scale from public ship-class knowledge (`docs/geometry-accuracy.md`,
  `tools/gen_cvn73_hull.py`); a yard replaces it through the register door.
- **Does it change the schedule?** Never. P6 is authoritative; the product
  proposes, ledgers and checks whether the next export reflected it.
- **Is it decision support?** Yes, and the API says so on `/health`
  (`decision_support_only: true`). Every verdict names the rule, the hazard
  and the clearing authority; a person clears.
- **What does it do when a read fails?** Renders "unavailable". A failed
  read is never an empty list that reads as clearance — including the hull
  list and the identity: no `/api/whoami`, no hulls and no doors.
- **Who did that?** Every ledger row names the person the yard's proxy
  asserted (`x-wadl-person`), hashed into the row; the rows from before
  people were asserted say so honestly and still verify. In the demo the
  names are demo people, and the badge says so.

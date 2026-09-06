# Demo script — one morning on CVN-73, role by role

A scripted walk over the reference hull that `scripts/dev.sh` boots: the
generated USS George Washington (CVN-73) register in `reference/cvn73`, the
sample P6 export `CVN73-PIA26-full.xer` as the schedule of record, and a
morning's hazard log. Every name below is a real row in those documents, so
the walk can be rehearsed and it lands the same way each time. Times are
relative to the moment the API booted (the log is stamped "this morning"),
so read the clocks on screen rather than off this page.

Twenty minutes at a steady pace. The order follows the working day: the
crew's shift, the zone, the schedule, the conflicts, the record.

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

## 1. Foreman — "what is my crew doing at 0700?" (3 min)

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

## 2. Zone Manager — "my zone, and what is next door" (5 min)

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
  shaft alley No. 3, the fire marshal's to clear. Open it. The inspector
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
  every row names who answered — the name a board of inquiry gets.

## 5. Ship Super and Project Manager — "the hull, worst first" (2 min)

Role menu → **Ship Super**. The front door is the **Deck Explorer** at ship
altitude, all zones, worst first; the zone lanes show where the held spaces
concentrate (Z4, then Z5). **Portfolio** for the Project Manager: every hull
the reader is assigned, class, availability and confidence (CVN-73 reads
*At Risk*), and the hull the reader is not assigned refuses with the
reason, which is the row-level security story in one click. The role menu
says the Project Manager *may: answer for an option or an issue* and
nothing else — on Data Sources every Confirm and Discard is grey with the
sentence, and the dry run still works.

## 6. Data Sources — "where every number came from" (2 min)

**Data Sources** is the home of the documents the hull *is*: the compartment
register, the coupling register (derived deck penetrations marked
*derived*), the zone chart, the geometry, the hazard log, the schedule of
record. Each door has a dry run, a mapping report and a revert, and each
commit is a ledger entry under the person who committed it. Committing
needs a **Planner** (the card says *anyone may dry-run; committing needs
Planner* for any other role); re-import the morning's hazard log as any
role that may raise: rows already live are skipped and say so; raise one
from the log and watch the plate.

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

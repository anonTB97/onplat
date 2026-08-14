# Attack plan — from a viewer of states to a register of work and issues

Three complaints arrived together, and they are more connected than they look:

1. *Full screen on the deck view isn't working well; I can't zoom on it.*
2. *I don't see where I can route to a "fix" for the issue.*
3. *We probably need a full register of activities in the platform.*

The first two share a root cause (diagnosed below, with the code). The third is
the capability gap that decides what this platform becomes: today it can tell
you a space is held and what would open it, but it cannot tell you **which
planned work is in trouble**, because it holds six work orders and two packages
where a real availability holds thousands of activities. An issue, properly, is
an *activity that cannot execute as planned* — and we cannot detect those
without the activities.

So the spine of this plan is: **activities in → issues detected → each issue
routed to its fix.** The full-screen and zoom work is Phase 0 because it is
small, diagnosed, and currently blocks the route-to-fix path entirely.

---

## Diagnosis (what is actually wrong, with the code)

### "Full screen" is neither full nor usable

- **It is a taller box, not a takeover.** `fullScreen` hides the selector rail
  and raises the plate viewport from 520 px to 820 px (`maxH = tall ? 820 :
  SHEET_BOX_H`, `DeckExplorer.tsx`), inside the normal page — banners, top bar,
  time control, breadcrumb and page padding all remain. On a laptop that is a
  modest crop of the screen presented as "full".
- **There is no wheel or pinch zoom anywhere in the shell.** Zero `onWheel`
  handlers exist. Zoom is two small +/− buttons, and on the plate it steps in
  whole integers. Drag-to-pan exists; scroll does nothing (or scrolls the page,
  which reads as broken). This is the literal "I can't zoom on it".
- **Entering full screen throws away your framing.** The camera-reset effect
  keys on `fullScreen`, so the zoom/pan you had is discarded at the exact moment
  you asked to see it bigger.
- **Full screen removes the route to the fix.** The decision-trace aside — which
  now carries the mitigation options, the compound plan, the redeployment list
  and the decision record — renders only when `!fullScreen`
  (`DeckExplorer.tsx:677`). Click a held space in full screen and nothing
  explains it and nothing offers a fix. Complaints 1 and 2 are the same bug
  when the user is in full screen.

### The route to a fix is real but has no front door

The options panel exists and works, but reaching it requires: Deck Explorer →
compartment altitude → not full screen → select the space → read below the
trace. The paths that *detect* an issue — the alert bell, the ship/zone worst
lists, the Work Orders space chips, the leverage board's space links — all land
on the space, but nothing says "fix" anywhere along the way, and nothing lands
with the options in view. There is no issue-first screen at all: the leverage
board answers "what is worth doing", but nobody arrives knowing an action; they
arrive knowing a problem.

### The register is 24 spaces and 8 work items

`InMemoryStore` seeds 6 work orders + 2 packages over 24 compartments. The
activity grain — the thing P6 actually schedules, the thing a foreman is handed
— does not exist as an object anywhere in the platform. Migration 0009 built the
landing tables (`p6_activity`, `p6_relationship`) and the sample XER exists, but
nothing parses XER in Rust, nothing maps activities to work, and no surface
shows an activity.

---

## Phase 0 — Make the deck view honest under full screen (small, do first)

**F1 · Real full screen.** A fixed-position overlay covering the viewport
(handling markings stay, per the classification-banner rule), containing the
plate viewport sized to the actual window, the view controls, and Esc/button to
exit. Not a bigger box.

**F2 · Continuous zoom where the reader expects it.** Wheel zoom centred on the
cursor, pinch on trackpads (`ctrlKey` wheel events), on both `SheetView` and
`PlanView`; fractional steps; the +/− buttons stay for coarse control. Preserve
framing when toggling full screen — re-clamp to the new viewport instead of
resetting. `preventDefault` on the canvas so the page never scrolls out from
under the gesture.

**F3 · The fix travels with the space.** In full screen, selecting a compartment
opens a slide-in drawer with the same trace + options panel (one component,
reused — two implementations is how the two would drift). Everywhere else, every
affordance that lands on a held space lands with the options in view: the alert
bell, worst-space rows, leverage-board space links, work-order chips. Held
markers get an explicit "fix" affordance (a wrench glyph on the marker's label)
so the deck plan itself advertises that a route exists.

*Definition of done:* full screen fills the window; wheel-zoom works in and out
of full screen; clicking a held space in full screen shows why it is held and
what would open it; the browser-verification script covers all three.

## Phase 1 — The activity register (the capability)

**A1 · Activity as a first-class domain object.** `Activity`: code, name, the
work order it belongs to (or none — unmapped is a visible state, not an error),
compartment (+ reliability grade), trade, planned `Window`, budget/earned hours,
status, constraint flags. Store trait gains `list_activities`. The demo seed
generates a few-hundred-activity register across the availability —
deterministically, anchored, derived from the existing work orders and package
segments so every number still reconciles with the boards.

**A2 · XER ingest in Rust.** Port the by-name section parser (already proven in
`scripts/validate-p6-sample.py` — field order resolved from `%F`, never by
position) into `wadl-ingest`; land `TASK`/`TASKPRED`/`TASKRSRC`/`UDFVALUE`
verbatim per the three-layer model in `docs/p6-ingest-schema.md`; then the
mapping step onto activities/work orders with the crosswalk's reliability
grades. `wadl ingest-xer <file>` CLI. The sample XER becomes an ingest test
fixture, not just documentation.

**A3 · The register surface.** The stubbed **Sequence Board** slot becomes the
register: every activity, searchable and filterable (trade, compartment, zone,
window vs the time control's instant, status, mapped/unmapped), the same
marked-not-filtered discipline the Work Orders table uses. **Daily Ops** becomes
its shift-sized slice: what is planned *now*, per trade.

**A4 · Executability — the join that creates new information.** Per activity:
evaluate its compartment **over its planned window** (the engine already takes
any instant). An activity planned into a space the engine refuses during that
window is *not executable as planned* — a fact neither P6 nor the engine holds
alone. This is the platform's second novel derivation, after stranded hours.

## Phase 2 — Issues as first-class objects (the front door)

**I1 · Issue derivation, pure and property-tested** (in `wadl-plan` or a small
`wadl-issues`): join the register × the engine × the topology to produce typed
issues, each carrying evidence and its route:

- *Not executable as planned* — A4's output (the coating/hot-work inversion in
  the sample XER, `A6010 → A4050`, is exactly this).
- *Held with crews booked now* — today's readiness "held", becoming one issue
  kind among several rather than the only visible problem.
- *Compound hold* — no single action opens it (already computed; becomes an
  issue with the plan attached).
- *Stranding concentration* — one space holding downstream hours (already
  computed in `wadl-plan`).
- *Schedule-quality findings* — negative lags into cures, constraint density
  (the P6 doc's data-quality metrics, surfaced instead of buried).

**I2 · The Issues board.** Conflicts & Risk gains two tabs: **Issues** (ranked
by man-hours at risk) and **Actions** (the existing leverage board). Every issue
row routes to its fix: the space with options open, the leverage action that
clears it, or the activity to be re-sequenced. Decisions recorded from an issue
carry the issue in the hashed detail, so the ledger reads "we saw this problem,
were offered these options, chose this one".

*This is the answer to "where do I route to a fix": one screen where issues
arrive ranked, and every row is a door.*

## Phase 3 — Survive the register's scale

- `leverage`/`assess` re-evaluate the hull per candidate action; fine at 24
  spaces, unproven at hundreds with thousands of activities. Measure, then
  bound: evaluate only spaces reachable from a changed input (the graph gives
  the reach), cache the baseline, paginate the register.
- The shell still has no JS test runner; the grid-alignment and now the zoom
  maths are guarded by one-off scripts. Add vitest and move those invariants
  into CI.
- Issue counts belong on the rail badge and in the top-bar alerts, replacing the
  current held-space count.

## Order and sizing

| Phase | Size | Depends on |
|---|---|---|
| 0 — full screen, zoom, route-to-fix | days | nothing |
| 1 — activity register + ingest + executability | the big one | nothing (P6 exports help later) |
| 2 — issues board | days once 1 exists | Phase 1 |
| 3 — scale + test infra | continuous | Phases 1–2 |

Phase 0 ships alone and first — it fixes what a user can see today. Phases 1–2
are the platform becoming what the pitch says it is: not a viewer of compartment
states, but the system that knows what work is planned, which of it is in
trouble, and what to do about each one.

# Backlog

Work with enough of the reasoning attached that picking an item up does not mean
re-deriving the decision. Items are not in priority order.

Shipped items stay, marked as such, when the reasoning behind them is what makes
the *next* change to them safe — the T-series is the case in point. An item earns
a place here only if it is real work with a known shape; vague aspirations belong
in `handoff/`, not here.

---

## T — The time dimension · **shipped**

> Requested: *"Build in a time slider on the deck view and other views as well.
> It doesn't have to be a time slider exactly, just whatever would best serve
> the UX and UI so planners and supervisors and workers can see work going on
> hour by hour and then day by day, week by week, month by month."*

Built as T1–T4 below. Kept here rather than deleted: the reasoning is what makes
the next change to it safe, and two of the decisions are easy to undo by accident.

### What it turned out to be

The first thing investigation found was that the instant was already a parameter
and **nothing read it**. `EvaluationRequest.at` was documented as "the instant the
decision is made at", passed by all four callers, and ignored inside `evaluate()`.
The visible consequence was in the demo hull: a coating cascade whose cure elapsed
on 13 May still showed as a live BLOCK in August, with its own `earliest_clear`
three months in the past. So T2 would have been a no-op on its own — the engine
had to start consulting the instant first.

`evaluate()` now consults `at` at both ends of a hold: a hazard not yet raised
contributes nothing, and a trace step whose hold has elapsed contributes nothing.
A step gated on a **verification** rather than a clock has no expiry and never
elapses. That is the asymmetry the whole feature exists to show — scrub forward
and the cure-gated holds clear themselves, leaving exactly the holds that need a
person sent.

There is deliberately **no `until` on `Hazard`**. When a hazard stops mattering is
the rule's judgement, not the hazard's: the same coating ticket blocks the deck
above for eight hours under R03 and suspends the trunk for eight under R09, and a
different rule set could price them differently from the same ticket. Expiry is
therefore priced per trace step from the rule's own `hold`.

### The shape of the control, and why not one slider

Hour-to-month is about a 700:1 resolution spread, and a single control spanning it
is unusable at both ends. Three audiences are hiding in the request, each with its
own horizon *and* its own step, so the **horizon sets both**:

| Horizon | Step | Who reads at it |
|---|---|---|
| Shift | hour | Mechanic · can I get in there at 1400? |
| Week | day | Supervisor · what frees up before Thursday? |
| Month | week | Zone manager · which weeks are over-committed? |
| Availability | month | Planner · where does the work pile up? |

That pairs with the altitude control the Deck Explorer already had. `Persona` now
carries an opening `horizon` alongside its `altitude` — space and time are the two
dimensions of one question, so a persona names its starting point in both, and a
production super lands on the shift while an executive lands on the availability.

### What shipped

- **T1 · Dated windows.** `domain::Window`, half-open so abutting shifts do not
  both count at the changeover and a hold expiring at `T` clears *at* `T`.
  Windows on work orders (`WorkOrderSummary::planned`) and per package space
  (`SpaceWork::window`), plus an availability window per hull. Undated work counts
  at **every** instant rather than disappearing — hiding it would quietly shrink
  the outstanding hours the moment a planner touched the control.
- **T2 · As-of on the read path.** `?as_of=` on the four evaluating endpoints,
  defaulting to the clock. Three properties are tested rather than asserted in a
  comment (`crates/wadl-api/tests/as_of.rs`): omitting the parameter is
  byte-identical to passing the clock's own instant, an instant outside the
  availability is refused with a reason instead of clamped, and a hull with no
  dated availability refuses every `as_of` rather than accepting anything.
  `/timeframe` serves the server's clock and the bounds it enforces.
- **T3 · The control and the projection guardrail.** `shell-web/src/TimeControl.tsx`,
  mounted in the chrome so one instant governs every module. Any instant other
  than now turns the strip amber and carries `PROJECTION — NOT AN AUTHORIZATION`;
  the breadcrumb's provenance note switches from `evaluated live` to `as of …`,
  and the Deck Explorer's subtitle drops the word "currently".
- **T4 · Playback.** One step per beat, stopping at the window's end rather than
  wrapping — a loop would re-run the day and read as live data refreshing.

### The two things not to undo by accident

1. **Nothing is interpolated in the browser.** Every scrub refetches, and the
   engine evaluates that instant for real with a real trace. Filtering a cached
   set client-side would look identical on screen and be a fabrication. This is
   why `asOf` is threaded through every fetch as a parameter instead of living in
   a module-level variable.
2. **A projection is never an authorization.** A scrubbed-future ALLOW is a
   projection and the UI says so. Decision support, not automation.

### Still open

Whether the vertical trace should gain a *time* axis — frames across, time down,
one deck — or stay spatial with time as a scrub. The frame axis is what makes that
view truthful and should not be spent lightly; probably a separate view rather
than an overload of this one.

The demo schedule is 22 dated items over a 180-day availability, deliberately
dense near the anchor and looser further out. Real P6 dates would arrive through
`wadl-ingest`, which is provenance-stamped but still unwired to a schedule of
record — the one prerequisite left for this to be about a real availability rather
than a seeded one.

---

## Other deferred work

- **Modules with no view.** Daily Ops, Sequence Board, Conflicts & Risk,
  Deconfliction Cascade. The rail marks them `soon` rather than rendering an
  empty frame that reads as missing data (`MODULES` in `App.tsx`).
- **Authentication.** The shell ships a fixed `DEMO_IDENTITY`. Tenant isolation
  is enforced at the database (RLS, `docs/adr/0003`) and the API extracts a
  caller scope, so this is a front door on a locked house — but it is still a
  missing front door.
- **Register data for nine of twelve decks.** Three decks carry compartments;
  the rest are `plate only` and say so in the rail. Not a bug — the class
  register is real and the counts are honestly zero — but the Deck Explorer is
  thin above the main deck until they are populated.
- **`deck_island` has no frame axis.** Deliberately `None` in
  `scripts/extract-deck-sheets.py`: the island plate has no single frame ruler
  to calibrate against, so it is excluded from frame-mapped views rather than
  given a fabricated calibration.
- **P6 ingest is provenance-stamped but unwired to a real schedule.** The time
  dimension above now consumes dates, so this is what turns it from a seeded
  story into a real availability.

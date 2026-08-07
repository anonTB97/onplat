# Backlog

Deferred work, with enough of the reasoning attached that picking an item up
does not mean re-deriving the decision. Items are not in priority order; the
**T-series** is the one with a stated ask behind it.

An item earns a place here only if it is real work with a known shape. Vague
aspirations belong in `handoff/`, not here.

---

## T — The time dimension

> Requested: *"Build in a time slider on the deck view and other views as well.
> It doesn't have to be a time slider exactly, just whatever would best serve
> the UX and UI so planners and supervisors and workers can see work going on
> hour by hour and then day by day, week by week, month by month."*

Today every view is a still photograph of **now**. The API evaluates
authorization against the injected clock (`state.clock.now()`, four call sites
in `crates/wadl-api/src/handlers.rs`) and the shell renders whatever came back.
Nothing in the product can answer "what does this deck look like at 1400", and
that is the question a supervisor actually asks.

### Why this is not one slider

The stated range — hour to month — is about a 700:1 spread in resolution. A
single control spanning it is unusable at both ends: a pixel is four hours at
the month end, and the month end is 500 screens wide at the hour end. Three
audiences are hiding inside that one request:

| Who | Horizon | Step | The question |
|---|---|---|---|
| Mechanic / worker | this shift | hour | *Can I get into 4-164-2-Q at 1400, or am I waiting on a cure?* |
| Supervisor | today → this week | shift, then day | *Which of my spaces free up before Thursday without anyone doing anything?* |
| Planner | the availability | week, then month | *Where does the work pile up, and what is stranded when it does?* |

So: a **horizon selector** (Shift / Day / Week / Availability) that sets both
the window and the step, with a scrubber inside that window. This pairs with
the altitude control the shell already has — `Altitude` in `Chrome.tsx`, and
each `Persona` already carries the altitude it opens at. Time is the same idea
on the other axis, and personas should carry an opening horizon too, so a
foreman lands on the shift and an executive on the availability without either
of them navigating there every morning.

### Why the architecture is ready for it

`EvaluationRequest.at: Timestamp` — the engine takes the evaluation instant as
data and reads no clock (`docs/adr/0001`; `Utc::now` is banned workspace-wide
via `clippy.toml` `disallowed_methods`). Asking the engine "what do you say at
T" is therefore a **parameter change, not a new code path**, and the answer is
a real engine decision with a real trace, not a client-side guess.

That is the load-bearing constraint. The scrubber must feed `as_of` down into
the evaluation. It must **not** filter or interpolate already-evaluated results
in the browser — a projected state with a fabricated trace is exactly the kind
of plausible lie this codebase is built to make impossible.

### The insight the feature is actually for

`Readiness` and the overlay buckets already turn on whether `earliest_clear` is
a timestamp or null — a hold gated by a **clock** versus one gated by a
**verification** (`theme.ts` `overlayBucket`, and `crates/wadl-plan/src/readiness.rs`).
Scrub forward and those two behave completely differently:

- clock-gated holds **resolve themselves**. The cure elapses; nobody does anything.
- verification-gated holds **do not**. They sit there until a person goes and does something.

Which means the time control is not decoration. Scrubbing to Thursday and
seeing what is *still* stopped is the shortest path in the product to "here is
the list of things that need a human this week" — the stranded-hours question,
answered by moving one control instead of reading a report.

### What is missing

Work items and hazards have no dated windows. `Hazard` has `since` but no end:
a hazard is live unconditionally and hold periods price `earliest_clear`
forward from `since`. There is no `planned_start` / `planned_finish` anywhere in
the workspace (`rg planned_start` → nothing). So without new data, scrubbing
moves the evaluation instant — cure clocks elapse, clock-gated holds clear —
but it cannot change **what work is booked**, and a planner scrubbing across a
month would watch an unchanging set of work items with the holds falling off.
Half a feature, and the misleading half.

Hence the sequence:

- **T1 · Dated windows.** Planned start/finish on work items; start/expected-end
  on hazards. Domain first (`Timestamp` is epoch millis with `plus_minutes`; no
  date library in `wadl-domain`, keep it that way), then a migration, then the
  seed — the demo hull needs work spread across the availability or there is
  nothing to scrub through. `wadl-ingest` is where real P6 dates would land.
- **T2 · As-of on the read path.** `?as_of=` on the read endpoints, threaded
  into `EvaluationRequest.at` in place of `clock.now()`. Keep the clock as the
  default so every existing caller is unchanged. Bound it to the availability
  window and reject instants outside it rather than serving a meaningless
  decision. Property test: `as_of = clock.now()` is identical to no parameter.
- **T3 · The control, and the projection guardrail.** Horizon selector +
  scrubber, on the Deck Explorer plan, the vertical trace, and the readiness
  boards — one shared component and one piece of state, because a time control
  that means something different on each screen is worse than none. Any instant
  other than now must be **visibly marked a projection**: decision support, not
  automation (`GuardrailStrip`). A scrubbed-future ALLOW is not a permit and the
  UI must never let it read as one.
- **T4 · Playback.** Once the scrubber is honest, stepping it is nearly free,
  and a day played back at one second per hour is the artefact that makes a
  POD board make sense. Cheap, and worth nothing before T1–T3.

### Open question for T3

Whether the vertical trace's shared frame axis should also gain a time axis —
frames across, time down, one deck — or stay spatial with time as a scrub. The
frame axis is the thing that makes the trace truthful and it should not be
spent lightly. Probably a separate view rather than an overload of this one.

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
- **P6 ingest is provenance-stamped but unwired to a real schedule.** T1 above
  is the first thing that would need it.

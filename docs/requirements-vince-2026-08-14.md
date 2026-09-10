# Requirements — Vince Stammetti session, 2026-08-14

Source: "Shipyard AI Onboard" meeting recording, 2026-08-14, 26 minutes —
Tanner Blacklidge walking Vincent Stammetti (onboard planning expert; former
availability manager) through the live tool. Vince reacted to the Deck
Explorer day picture, the constraint markers, and the distributed-package
walkthrough, and described how he would actually run an availability with it.

This document distills his words into requirements. Timestamps reference the
meeting transcript (kept outside the repo — it contains personal
conversation). Each requirement carries a disposition against the tool as of
`dfc7268`:

- **Supported** — the behaviour exists today; the requirement pins it.
- **Partial** — a foundation exists; named gaps remain.
- **New** — nothing in the tool does this yet.

The single most important thing Vince described is a *loop*, not a screen:
see the red → understand why → send people to fix the field condition →
clear it in the tool → watch everything it was blocking open up → find work
for anyone still blocked. Every high-priority requirement below is a leg of
that loop.

---

## 1. The operating rhythm the tool must serve

### VR-01 — Chalk-line baseline, with one live exception (Partial)
> "We're gonna snap a chalk line on Monday… day-to-day, the only thing
> that'll change is hot work permits, 'cause that'll be live." (2:16)

The schedule is a weekly snapshot; the tool must always say which import
it is reading and when it was taken. Permit / hazard state is the one thing
that moves intraday and must be treated as live, not part of the snapshot.

*Today:* imports are all-or-nothing with graded provenance, and the ledger
records every replacement with a delta. *Gap:* hazard/permit state has no
intraday update path — it enters only via seed or import (see VR-05).

### VR-02 — Every red must say what it is telling me (Supported — pin it)
> "We got a red X sitting there… what is that red X telling me? I got a
> collision or I've got a hot work issue. What do I got there?" (2:38)
> Answer on screen: "no verified zero-energy state in this space." (3:05)

A refused marker must explain itself where it stands: the rule, the hazard,
and the field condition to go verify (tag-out log, gas-free cert). His next
action was immediate and physical — "get the tag-out log and go verify
tags" — so the wording must use deckplate vocabulary (tag-out, zero-energy,
gas-free), not engine vocabulary.

### VR-03 — End-of-day scrub: tomorrow, tonight, and what slipped (New)
> "At the end of the day… look at this and say OK, what's going on
> tomorrow? Can we clear any of this stuff up so we can come in and get a
> clean start? …we figure out what work didn't get done, and that's how I
> start to prioritize my second, maybe third shift." (4:34)

A tomorrow-facing view: constraints that will stand in front of tomorrow's
work (clearable tonight), plus the day's planned-but-not-progressed list
ranked by schedule criticality, to hand to night shift.

### VR-04 — Week outlook (Partial)
> "I would start at the beginning of the week looking at the week and say
> what are the constraints, and are we clear to go do this?" (5:37)

One view of the week's major activities with every refusal/conflict standing
in front of them. *Today:* the time control scrubs any date and the Sequence
Board shows the whole run; there is no single "this week's work and its
blockers" rollup.

---

## 2. Clearing constraints — the core loop

### VR-05 — Administrative clear, ledgered (Implemented 2026-08-14)
> "Get the tags hung, come back and tell me they're hung. We'll
> administratively remove that. But if hot work is live, soon as you guys
> are done, that's going to clear." (3:23)

When the crew verifies the field condition, an authorized user clears the
constraint in the tool; the clear is a ledger entry (who, when, on what
basis). Constraints backed by a live feed clear themselves when the feed
says done. Nothing today lets a user resolve a hazard — this is the missing
leg of the morning-meeting loop.

### VR-06 — A clear must cascade, visibly and immediately (Implemented 2026-08-14)
> "When we clear that red X, does that clear all the other red?" (3:38)

Clearing one constraint re-evaluates everything it was refusing — same
space, adjacent spaces coupled through the ship's physics, downstream
activities — and the screen flips within one refresh. The engine already
recomputes verdicts on every read; what's missing is the clear action and
the guarantee the user *sees* the flip (see DEF-1).

### VR-07 — Drill until the path is clear (Implemented 2026-08-14)
> "If there's other pink or red, I'd go OK, what's that? Why is that red?
> We would just drill down until we cleared the path to go back to work." (4:10)

After each clear, what's still red and why, iterating to done. The refusal
chips and the Job Card's problems-with-route-out section already carry this;
the loop just has no clear action to iterate on yet.

---

## 3. Give nobody away — workforce continuity

### VR-08 — Blocked crew → alternate work, by resource group (New — high)
> "If I can't clear that tag — who's standing around and what are you gonna
> do next? …My number one rule of thumb is give nobody away. Go find
> something else for them to do." (9:09)

When a constraint blocks work, show other currently-executable work for the
same trade / resource group: the back-pocket work list, computed. Trade is
already on every work order and executability is already served per
activity — the join is new.

### VR-09 — A clear that stalls is a staffing signal (Later)
> "The tag isn't hung because I didn't get the electrician… that may signal
> me to go: hey, I didn't get Timmy today. Where am I gonna get him and
> why?" (10:33)

Let the *reason* a clear is stuck be recorded, so a pattern of
labor-shortage stalls is visible distinct from field-condition stalls.

---

## 4. Milestones and levels of schedule

### VR-10 — Daily work rolls up to the next key event (Partial)
> "I'm looking all the time at these different levels of schedules to make
> sure that getting the daily work done, I'm hitting my next milestone…
> undocking is typically the first big one." (8:55)

Each key event (undocking, light-off, …) has its own critical path distinct
from the availability's. The deck picture must be able to answer: is this
week's work keeping the next key event whole? *Today:* milestones are
ingested and flagged on activities; no key-event rollup exists.

### VR-11 — Mini critical paths / the critical chain (Later)
> "The electricians may not be on the critical path — but if they don't get
> something done by a certain date, all of a sudden the critical path runs
> right through them." (5:51)

Surface off-critical-path work whose float is nearly consumed, by trade.
Needs float/relationship data carried through from P6.

### VR-12 — Honest aggregation across breakdown levels (Supported — pin it)
> "Naval shipyards break work down to key operations — there could be 100
> for a job. I would be looking at those chunks of work." (9:09)

Real schedules arrive at key-op grain; the tool must aggregate to job /
package level without the user reading key-op noise, and without inventing
totals. The work-order → activity rollup with reconciliation evidence is
this; keep it truthful when 100-key-op jobs arrive.

---

## 5. Material readiness

### VR-13 — Big-ticket material: do I have it, and why not (New)
> "If P6 is right, do I have the material? …Not every stick — the big
> stuff: pumps, valves, motors. Do I have it or not? Why don't I have it?
> It's people and material." (12:24)

Model major material items against the work that needs them and flag
scheduled work whose material is not on hand. Material is currently not
modelled anywhere in the tool; P6 carries labor, material, and subs, so
ingestion is the entry point.

---

## 6. Emergent work

### VR-14 — New work arrives flagged, with its impact (Partial)
> "A new job comes in and it's gonna affect some of these things — will
> there be a way to flag it as new work with a potential impact?" (17:01)
> "People always adding stuff — you open up something, you find
> something." (16:48)

Work added after the chalk line must arrive marked NEW and answer: which
spaces, which existing work, which key events does it collide with?
*Today:* the re-import delta already names added/removed/retimed work and
the refusals it newly causes or clears — at import time. *Gap:* the NEW
badge doesn't persist onto the boards, and impact isn't framed against
key events.

### VR-15 — Removal creates a put-it-back obligation (New)
> "Don't forget, dummy — you gotta put the main seawater pump back in at
> some point. Do I slow something down to get that back in, because it's
> easier from an interference perspective?" (17:47)

Emergent removal work carries a future reinstallation that must live in the
schedule picture, not in someone's head — visible when planning the space's
remaining work.

### VR-16 — Warn on re-entry into a closed-out space (Partial)
> Tanner: "The fear is locking and tagging out and then — oh, I got to
> break back in, because this is gonna be an affected space and I didn't
> foresee it." Vince: "Or I got to do rework. I thought I fixed it, but I
> really didn't." (18:55)

When new or rework activity lands in a space that is tagged out or already
completed, say so at import preview and on the space. The conflict machinery
and delta exist; the completed/tagged-space re-entry check is new.

### VR-17 — The shared picture for re-sequencing (Supported — pin it)
> "We use this with the schedulers. Come on down, let's pull this up, talk
> about the most efficient way, and we'll adjust the schedule that way —
> and then we'll all know. There was no representation like this; it was
> people writing it on paper, hoping they caught it all." (18:28)

Dry-run previews, typed refusals, and re-sequence proposals stay
first-class: the tool is the artifact planners and schedulers argue over.

---

## 7. Distributed packages

### VR-18 — Package watch, gated on its key event (Partial)
> "You pulled shafts — I'm going to want to watch that job because it
> crosses multiple compartments… Where's all the line shaft bearings? Are
> they done? When we put the shaft back in, did we couple it up to the
> reduction gear? I know they all got to be done before I can dock." (15:10)

For a package spanning compartments, one view answering "is every segment
done that must be done before the gating milestone?" *Today:* the footprint
walk shows per-space windows and refusals; completion-vs-gating-event is
the missing column.

### VR-19 — Segments that leave the boat (Later)
> "I gotta take this pump out because it has to go to the shop, get
> rebuilt, get tested, and then it comes back in." (7:28)

Rip-out → shop → reinstall means a package segment is off-hull for an
interval; the space picture should know the difference between "work
paused" and "component away at the shop."

---

## 8. Reading the screen

### VR-20 — The legend answers before the user asks (Partial)
> "Why is that red? …Is there a methodology between the green and all
> that?" (20:14)

Vince had to ask what the colors meant. Every board renders the same states
in the same colors — blue in progress, green complete/allow, yellow warn,
red not executable, purple suspend — with the legend visible or one click
away on every screen, phrased in his terms once he saw it: "Correct. That's
really good." (20:51)

### VR-21 — Cross-screen identity of spaces and states (Partial)
> "I'm thinking they probably match up to the green boxes we were just
> looking at." (20:31)

A space's state in the package walk, the deck plate, and the Job Card is
visibly the *same fact* — same color, same wording, and a jump between the
views. Jump links exist; keep state rendering byte-identical across boards.

---

## 9. Data reality

### VR-22 — Survive whatever schedule the pilot yard has (Partial)
> "We'll make that an ask when we go see the shipyard: do you have a
> schedule? I don't care what it is — a tug, a barge, what do you got?" (21:19)

The importer must take arbitrary real P6 exports — commercial or Navy,
sparse or noisy — through the same dry-run / typed-refusal door without
falling over. Proven against a full carrier XER; hardening for field
variance is ongoing work, and every new sample becomes a fixture.

### VR-23 — Earned-value tie-in (Later)
> "You tie that in with the earned value look and all of that, and you got
> something." (10:46)

Budget vs remaining exists per work order; EV proper (planned value, earned
value, actuals over time) needs actuals capture and belongs after the
operating loop works.

---

## 10. The predictive horizon

### VR-24 — Courses of action, with odds (Later — explicit end state)
> "If I could get to where I don't have to do all this mental integration —
> I got something that says: here's what we need to do, here's the courses
> of action, here's the probability of success of each. Pick one." (11:02)

Everything above is prerequisite data for this. Do not attempt it before
the clear loop (§2), workforce alternates (§3), and material (§5) exist —
a recommendation engine over an incomplete picture is exactly the mental
integration problem restated.

---

## Defect observed live

### DEF-1 — A clear that doesn't clear (from 3:47) — CLOSED
During the session, clearing the red X on `3-148-2-E` was acknowledged
("accepted") but the space stayed red. Whatever the click did, the screen
must never accept a clear and keep showing the old verdict. Acceptance
criteria: an administrative clear (VR-05) flips every marker that hazard was
refusing within one refresh, and the ledger shows the clear entry. This is
the concrete test case for VR-05 + VR-06.

Closed 2026-08-14: `POST /api/vessels/:id/hazards/clear` closes the fact
(`cleared_at`/`cleared_basis`, nothing deleted), appends `HAZARD_CLEARED` to
the ledger, and the Deck Explorer's trace panel carries the clear action on
the hazard itself — basis required, every read refetched on success.
`crates/wadl-api/tests/clear_loop.rs` holds the scenario, including the
cross-space cascade, and the demo moment is re-runnable live: `3-148-2-E`
goes BLOCK → ALLOW on the clearance, options and refusal counts moving in
the same refresh.

---

## Recommended order of work

1. **The clear loop** — DEF-1, VR-05, VR-06, VR-07. ✅ Done 2026-08-14.
2. **Give nobody away** — VR-08. Turns every blocked constraint into
   redeployment instead of dead time; the data is already served.
3. **Emergent work** — VR-14, VR-15, VR-16. Persistent NEW badges, put-back
   obligations, re-entry warnings on top of the existing delta.
4. **Material have/have-not** — VR-13. New model, entered through ingestion.
5. **Rhythm views** — VR-03 (end-of-day scrub), VR-04 (week outlook).
6. **Key-event rollup** — VR-10; legend and identity polish VR-20, VR-21
   alongside.
7. **Later** — VR-09, VR-11, VR-19, VR-23, VR-24; VR-22 continuously as
   real samples arrive.

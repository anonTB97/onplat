# UX gap analysis — the three layers, and what a first-time user meets

Date 2026-09-02 · commit `f57acd4` · companion to `docs/pilot-readiness-review.md`

**The question.** Does the product separate its base data (the P6 schedule, the ship's schematics, the deck breakdowns, the zone chart, the manning book) from the visualization built on that data, and from the reporting a user takes away from the screen? When a superintendent sees a deck with issues on it, what report should exist behind that picture, by zone, by compartment, by distributed work package? And can a user walk in on day one without being overwhelmed?

**How this was produced.** Every module was loaded fresh at 1440 by 900 in a headless browser against the full sample schedule (1,561 activities) and measured at first paint: interactive controls above the fold, words above the fold, uppercase labels, type sizes. Twenty-two screens were captured, including the zone and ship altitudes, the readiness and manning overlays, the load digest, zone and space lanes, the actions tab and the day-shift board. Every screen's source was read for what it fetches and what it derives. Evidence is `file:line` at the commit above; measurements are in Appendix A.

## 1. Verdict

The screens are individually well made and honest, and the product does have the three layers the question asks about. What it does not do is show them to the user as layers. Facts of record, engine verdicts, and the picture drawn from both sit side by side on every screen with the same weight and the same type, so a new user cannot tell a number the yard supplied from a number the engine derived from a number the shell computed. The reporting layer is essentially absent: one monochrome print of the shift board, two CSV exports of the register, and the ledger. Nothing exists by zone, by compartment, or by package that a person can take to a meeting or pin to a wall. And the first-run experience is built for the planner who designed it: eleven modules in six rail groups, twenty-two views, eight state vocabularies, sixty controls on the opening screen, and four different answers to "how bad is it" across four screens. A foreman on their first Monday would not know where to look, and a zone manager would not know which number is theirs.

The good news is that this is a presentation and information-architecture problem, not an engine problem. The engine already serves everything a report needs at every grain. The fixes are: make the layers visible, give every role a front door, collapse the vocabularies, and build the reporting layer as printed cuts of what the screens already know. Roughly six engineer-weeks of shell work plus a two-week design pass, and it can run in parallel with the data-onboarding doors from the pilot review.

## 2. The three layers, as they exist today

The product's own code draws these lines correctly. The user interface does not.

| Layer | What belongs in it | Where it lives today | Where a user sees it | Gap |
|---|---|---|---|---|
| **Base data of record** | P6 schedule (XER), compartment register and deck list, geometry register (surveyed frame extents), zone chart, budget book, manning book, rules in force, field conditions (hazards), deck plates and calibration, shift calendar. | Five document doors with dry-run, commit, revert (`SourcesBoard.tsx`); the register, decks, couplings, rules and hazards are seeded constants with no door. | The Data Sources board is the one screen that shows data as data: six cards with INGESTED / INFERRED / SEEDED / NOT LOADED / REFERENCE badges and per-document findings. Doors are duplicated onto the Sequence Board, Work Orders and Deck Explorer. | Four kinds of data of record have no card at all (register, adjacency, rules, field conditions) and no door. The seeded ones are labelled SEEDED only on this screen; elsewhere they read as fact. Import doors on four screens mean the data layer has no single home. |
| **Derived facts (engine)** | Authorization verdicts and traces, cascade paths, readiness rollup by deck, zone and ship, issues ranked by hours at risk, priced mitigation options, re-sequence alternatives, hot-vs-flammable pairs, stranded hours. | `wadl-engine`, `wadl-plan`, `wadl-issues`, `wadl-mitigate`, served through 38 endpoints. | On every screen, inline with the data. A hover on a stat sometimes explains it. The breadcrumb says "engine · evaluated live". | Nothing marks a derived number as derived at the point of reading. "2 of 24 compartments refused", "58 refused this week", "77 not executable", "111 issues" and "52 in refused spaces" are all engine outputs at different grains, shown on different screens as if each were the headline. |
| **Presentation (shell arithmetic)** | Pro-rated window load, crew estimates (man-hours over 8 over days), crowding over six, zone interaction pairs, manning demand. | `windowLoad.ts`, `manning.ts`, `DeckExplorer.tsx:60-67`. | Marker labels ("≈17"), the Manning strip, the "this week" figures on the Deck Explorer. | Planning judgements the server never sees, shown at the same weight as engine verdicts. The warning triangle on a compartment is a shell constant, not a yard determination. |
| **Reporting** | What a person takes away: a shift sheet, a zone sheet, a compartment card, a package report, a look-ahead, a labour histogram, a conflict log, a key-event readiness sheet. | `DailyOps.tsx:193-258` (one monochrome print), `SequenceBoard.tsx:480-493` (register and logic CSV), the ledger. | A "Print board" button on Daily Ops. Two export buttons on the Sequence Board. | No report by zone, compartment or package. Nothing dated, nothing saved, nothing that survives the browser tab. A report today is a screenshot. |

The delineation the question asks for is therefore two changes: a **data layer with one home and a card for every kind of data of record**, and a **reporting layer that is not the screen**. Between them, a consistent way to mark a derived figure as the engine's.

## 3. What a first-time user meets

### 3.1 The opening screen

With no URL, the app opens the Deck Explorer at compartment altitude on the third deck of the first hull, for the "Planner" persona (`App.tsx:87-90, 96`). Above the fold at 1440 by 900 there are 60 interactive controls and 409 words. Reading top to bottom:

1. A handling marking band (BigBear.ai Proprietary · Competition Sensitive · All represented information is open sourced).
2. A top bar: menu, product name, search, hull picker, persona with a DEV ID badge, alert bell showing 111.
3. A guardrail strip: "Decision support — flags risk; the planner decides. Does not modify the schedule." · ILLUSTRATIVE / NOTIONAL DATA · IL5 / sovereign.
4. The time control: horizon (Day, Week, Month, Availability), the transport bar (7 buttons and a date), the day label, "now", "live".
5. A breadcrumb with "engine · evaluated live" and a Wall display button.
6. The module rail: 11 modules in 6 groups (Operate, Plan, Decide, Yard, Authorization, Help).
7. The module header: kicker, a question as the title, a two-line explanation, then the altitude selector (3), a five-figure stat line (367 activities · 23,172 MH · 58 refused · 43 unlocated · 96 hot-vs-flammable today).
8. The lens row: By space, By trade, Readiness overlay, Manning.
9. The deck rail: 11 decks, of which 7 read "no register data · plate only".
10. The view row: Single deck, Vertical trace, Whole ship, Drawing, Schematic, Restricted only, Zones and compartments, Full screen.
11. The plate toolbar: Fit width, Fit deck, 100%, minus, 55%, plus.
12. The plate itself, with pins.

Five persistent bands sit above the content on every screen and take about 170 pixels. Four of those bands are true on every screen and say the same thing every time.

### 3.2 Measured density

| Screen at first load | Controls above fold | Words above fold | Uppercase labels | Page height (px) |
|---|---|---|---|---|
| Deck Explorer (default landing) | 60 | 409 | 22 | 1,246 |
| Daily Ops | 88 | 689 | 94 | 5,415 |
| Sequence Board (register) | 65 | 464 | 75 | 1,049 |
| Conflicts and Risk (issues) | 57 | 633 | 30 | 7,037 |
| Deconfliction Cascade | 63 | 387 | 19 | 952 |
| Distributed Packages | 40 | 491 | 29 | 2,295 |
| Data Sources | 36 | 504 | 23 | 953 |
| Work Orders | 44 | 338 | 60 | 952 |
| Field Guide | 36 | 678 | 19 | 1,589 |
| Portfolio | 33 | 157 | 21 | 952 |
| Decisions Ledger | 30 | 210 | 18 | 952 |
| Deck Explorer, vertical trace | 73 | | | |

For calibration: a well-regarded operational dashboard puts 15 to 25 controls above the fold and under 200 words. Type on these screens is dominated by 10 to 12 pixel text. On Daily Ops, 198 of 230 visible text elements are 12 pixels or smaller. On a wall display across a room, or on a tablet on a deck, that is unreadable.

### 3.3 Eight vocabularies for state

A new user has to learn all of these to read the product, and they are never shown together:

| Vocabulary | Words | Where |
|---|---|---|
| Authorization state | ALLOW · WARN · SUSPEND · BLOCK | Legend, every pin, the trace, search hits (`theme.ts:5-10`) |
| Readiness | HELD · GO · IDLE · LATENT | Zone and ship boards, deck rail (`theme.ts:16-48`) |
| Readiness overlay | GO · WAIT · STOP · NO WORK | Deck Explorer overlay, Job Card (`theme.ts:60-94`) |
| Schedule status | NOT STARTED · IN PROGRESS · COMPLETE · MILESTONE · KEY EVENT | Register, lanes, shift board |
| Issue kinds | STRANDING · HELD · CREWS BOOKED · NOT EXECUTABLE · COMPOUND HOLD · NEGATIVE LAG | Conflicts and Risk |
| Location provenance | authored · ≈ derived · WBS zone hint · not located · unknown space | Everywhere a placard is drawn |
| Document provenance | INGESTED · INFERRED · SEEDED · NOT LOADED · REFERENCE · CONFIRMED · UNCONFIRMED | Data Sources, Work Orders |
| Shift-board flags | HELD · REFUSED THIS SHIFT · NOT EXECUTABLE · not located | Daily Ops |

Three of these use the word GO, two use HELD, and NOT EXECUTABLE is amber on one board and red on another. WARN spaces actually permit work. SUSPEND is not a word anyone says on a deck. The pilot review covers the yard-language fix; the point here is the count.

### 3.4 Four screens, four headline numbers

On the same hull at the same instant, the user is told:

- Deck Explorer: "2 of 24 compartments have work booked that the engine currently refuses" and "58 refused this week".
- Sequence Board: "77 not executable".
- Conflicts and Risk: "111 issues · 20,045 MH at risk".
- Daily Ops: "52 in refused spaces · 52 not executable" (this instant), "52 refused during this shift · 56 in refused spaces" (day shift).
- The bell: 111.

Each figure is correct at its own grain and window. Nothing on any screen says which grain it is, and no two screens share a definition. A superintendent asked "how bad is it" will get a different number depending on which screen the planner happened to have open.

### 3.5 The rail does not name the screens

The rail says Conflicts and Risk; the screen says "What is wrong?". The rail says Deconfliction Cascade; the screen says "If we do it, what happens everywhere else?". The rail says Deck Explorer; the screen says "Where can people work — and what's stopping them?". The questions are good first-read copy, but they are not names, and the rail's names are not on the screens. A user who was told "open the cascade" cannot confirm they did.

The rail's groups also mislead. **Authorization** holds Distributed Packages, the Decisions Ledger and the Deconfliction Cascade, directly under a guardrail strip that says the tool does not authorize anything. **Yard** holds Portfolio and Data Sources, which have nothing to do with each other. **Decide** holds one module.

### 3.6 Personas are not front doors

Eight personas (Planner, Zone Manager, Production Super, Project Super, IPT, Program Office, Material Manager, Executive) set only the altitude and the time horizon, and every one of them lands on the Deck Explorer (`Chrome.tsx:105-129`; `App.tsx:279-289`). A production superintendent whose day starts on the shift board is sent to a deck plate. A zone manager's persona is named but there is no way to say which zone is theirs, so "your zone's muster" opens on the whole hull ranked worst-first. IPT, Program Office and Material Manager are NAVSEA programme terms with no screen behind them.

### 3.7 Empty states as the first impression

The first thing in the Deck Explorer's rail is seven decks reading "no register data · plate only". Data Sources shows two NOT LOADED cards. The ledger shows "0 entries". Each is honest, and each is what a new user sees before they see anything working. The ledger's empty state explains how the first entry gets made, which is the right pattern; the deck rail's does not say why seven decks are empty or that this is expected on a 24-compartment demo register.

### 3.8 What works and should be kept

- One instant for the whole app, with the projection strip when scrubbed. Every screen answers for the same moment.
- The question-as-title with a two-line explanation and a stat row. It tells a reader what a screen is for in one breath.
- The Sources board as the honest ledger of what the hull is built from. This is the seed of the data layer.
- Search that takes a bare number as a frame station.
- The shift board's print, grouped by trade heaviest-first.
- Empty states that say what would fill them.
- The URL carrying hull, screen, instant and space.

## 4. The reporting layer: what people would take away

The picture on the Deck Explorer is the wrong artifact to take to a meeting. It changes every time the clock moves, it needs the tool to read it, and it answers "where" at the cost of "how much". What a yard actually passes around is a sheet: dated, at one grain, for one audience, and readable on paper or a phone. Each of the following is a cut of what the engine already serves. None requires new derivation. The column "exists as" names the screen that already holds the data.

S-curves are not on this list. A cumulative earned-versus-planned curve needs an earned-value tie-in the product does not have (VR-23, later), and in an availability the curve tells a production superintendent nothing they can act on today. Labour belongs on the list as a histogram, by trade and week, with the manning book overlaid: that is what production control uses to level crews.

| # | Report | Audience | The question it answers | Grain · cadence | Exists as | Gap |
|---|---|---|---|---|---|---|
| R1 | **Shift pass-down sheet** | Trade foremen, production super | Who goes where this shift, and what stands in front of them | Trade within shift · every shift | Daily Ops print (`DailyOps.tsx:193-258`) | Shift windows are UTC; no zone cut; no crew size; no permit or fire-watch column; no "clearable before the shift" list. |
| R2 | **Zone manager's day sheet** | Zone managers | What runs in my zone today by compartment, who is in it, what is held, what the neighbouring zones are doing that reaches mine | Compartment within zone · daily and weekly | Zone altitude board plus Zone lanes (`ReadinessBoards.tsx`, `ZoneLanes.tsx`) | Not printable, not exportable, not scoped to "my" zone; holds and zone interactions are on different screens. |
| R3 | **Compartment card** | Foremen, safety, ship's force | Everything about one space: work in it this week, open field conditions and who can clear them, hot-vs-flammable pairs, occupancy, clearance history | One compartment · on demand | Decision trace panel (`DeckExplorer.tsx:1601-1774`) | Lives only in a side panel on the plate; no clearance history; no print; no way to hand it to a fire marshal. |
| R4 | **Distributed package report** | Package owners, test coordinators | Footprint by compartment, segment progress, what is gating the leak test, stranded hours, expected release | One package · weekly | Distributed Packages screen (`DistributedPackages.tsx`) | Screen only; no footprint table; no export; the waits-on map does not print. |
| R5 | **Three-week look-ahead by zone** | Zone managers, planners | What starts in the next three weeks, where, with which holds still in front of it | Zone by week · weekly | Zone lanes (a Gantt) | A Gantt is not a look-ahead sheet. The yard's standard artifact is a table: activity, space, trade, start, hold, action owner. |
| R6 | **Labour loading by trade** | Production control, trade supers | Crews demanded per trade per week per zone, against the manning book | Trade by week (by zone) · weekly | Load digest (MH by zone by week) and the Manning strip (people per 4-hour step) | No trade by week histogram; no supply overlay over time; not exportable. |
| R7 | **Conflict and adjudication log** | Superintendents, safety, project management | Open conflicts by zone, how old, who owns them, what was decided | Issue · daily | Conflicts and Risk plus the ledger | No owner, no age, no disposition column; ledger does not show clearances; not exportable. |
| R8 | **Key-event readiness** | Project super, programme office | Work gating the next key event (undocking, light-off), with holds | Activities gating an event · weekly | Key events on Daily Ops and Zone lanes | No rollup exists (VR-10). |
| R9 | **What changed since the last import** | Planners, schedulers | Activities added, removed, moved; newly refused; newly clear | Import to import · per import | Dry-run delta at import time (`handlers.rs:1439-1520`) | Shown once in the confirm bar and then lost; not dated, not printable. |
| R10 | **Field-condition register** | Safety, ship's force, planners | Every open hazard: where, since when, who clears it, earliest clear, what it holds | Hazard · daily | Field conditions in the trace panel | No list view of open hazards on the hull. |
| R11 | **Crowded spaces** | Zone managers, safety | Compartments with more crews than the space or the yard tolerates, by shift | Compartment by shift · daily | Manning zone chips | Client-side heuristic, no per-space limit, not a report. |
| R12 | **Availability health, one page** | Project super, programme office | Held hours, workable hours, who can release the hull, worst spaces, trend | Hull · weekly | Ship altitude board | Not printable; no week-over-week trend. |

Three design rules for the reporting layer:

- **A report is a dated cut, not a live view.** It carries the hull, the instant it was cut, the schedule label it was cut from, and who cut it. It prints to one or two monochrome pages and exports to CSV. The ledger can record that it was produced.
- **Every report has a zone scope.** Zone is the grain a yard runs on. R1, R2, R5, R6, R7 and R11 take a zone parameter; "all zones" is the default only for project management.
- **The report names the layer of every figure.** Man-hours from the schedule of record, verdicts from the engine, crew estimates from the shell's rule. One glyph each, defined in a footer line.

## 5. Gap analysis, ranked

Severity is about the first-time user: BLOCKING means a new user would fail a basic task or be misled; HIGH means they would need help; MEDIUM is friction.

| # | Gap | Evidence | Who it hurts | Fix | Weeks |
|---|---|---|---|---|---|
| U1 | **No front door per role.** Everyone lands on a deck plate at compartment altitude. Persona changes only altitude and horizon. | `App.tsx:87-96, 279-289`; `Chrome.tsx:105-129` | Foreman, production super, zone manager | Roles instead of personas, each with a landing screen and a home scope: Foreman → shift board for their trade; Zone Manager → their zone's day sheet; Production Super → shift board, all trades; Planner → Sequence Board; Ship Super → ship board; Safety → field-condition register. Scope (zone, trade) is remembered per user. | 1.5 |
| U2 | **The layers are invisible.** Data of record, engine verdicts and shell estimates share one type and one weight; doors are on four screens. | Section 2; `SourcesBoard.tsx`; `DeckExplorer.tsx:925` | Anyone deciding whether to trust a number | One home for data (Sources, with a card for every kind of data of record, including register, adjacency, rules, field conditions and shift calendar); remove doors from the other three screens and leave a link. A single glyph for "engine verdict" and one for "planning estimate", used on every figure that is one, with a persistent legend. | 1.5 |
| U3 | **Four headline numbers.** Each screen leads with a different count of trouble at a different grain. | Section 3.4 | Superintendents asked "how bad is it" | Define one status strip for the hull, identical on every screen: spaces held now · activities refused this week · open issues · people on the hull. Each screen's own stat row then reads as detail under a shared headline. Name the grain in every stat label ("refused this week", not "refused"). | 1.0 |
| U4 | **Eight vocabularies.** | Section 3.3; `theme.ts` | Everyone new | Collapse to four: authorization state in yard words (open · open with conditions · secured · no entry), readiness (held · go · idle · latent), schedule status, provenance. Retire the third GO. One badge primitive per fact with fixed colour and label; one persistent legend drawer reachable from every screen. | 1.0 |
| U5 | **No reporting layer.** | Section 4 | Every meeting | A Reports module: R1, R2, R3, R7 and R10 first (all cuts of existing endpoints), each with print and CSV, dated and labelled. R5, R6, R9 second. R4, R8, R11, R12 third. | 5.0 |
| U6 | **The shift board is Zulu.** "Days 0700–1530 · (Z)". | `DailyOps.tsx:57-74` | Every US yard, day one | Yard time zone and shift calendar (pilot review B6). Report R1 inherits it. | in B6 |
| U7 | **Sixty controls on the opening screen.** | Section 3.1, Appendix A | Everyone new | Deck Explorer toolbar to three clusters: Altitude, View (single deck · vertical · whole ship), Layers (a menu: readiness overlay, manning, zones, drawing or schematic, restricted only). Zoom cluster on hover. Target 25 controls above the fold. | 1.0 |
| U8 | **Rail names are not screen names; groups mislead.** | Section 3.5; `App.tsx:45-57` | Anyone told "open the cascade" | Rail: Today (Shift board, Deck plan), Plan (Register and lanes, Work orders, Packages), Conflicts (Issues, Actions, Cascade), Data (Sources, Imports), Record (Ledger), Reports, Help. The screen title becomes the rail name; the question becomes the subtitle. Retire "Authorization" as a group name. | 0.5 |
| U9 | **Empty states dominate the first look.** Seven of eleven decks read "plate only". | Section 3.7 | New user on a small register | Collapse decks with no register data under one row ("7 decks without register data · plates only"); say why. Sources: a "what to load next" order. | 0.5 |
| U10 | **Type is too small for the room.** Ten to twelve pixel text dominates. | Section 3.2 | Wall display, tablet on a deck | A density setting: compact (today), standard (13 to 14 px body), wall (18 px plus, fewer columns). Wall display exists as a button; make it a real mode. | 1.0 |
| U11 | **Trace and options speak engine.** "R03 · 0 hop", "rule version 0000…0300", "cleared by marine_chemist". | `DeckExplorer.tsx:1699-1725` | Foremen | Sentence form with the raw fields behind "engine detail" (pilot review H2). | in H2 |
| U12 | **No first-run guidance.** The Field Guide is a good page nobody is sent to. | `FieldGuide.tsx` | Everyone new | A three-card first run on the landing screen (what this is, what the colours mean, where your day starts), dismissible, per user. Link the Field Guide from the persona menu. | 0.5 |
| U13 | **Tablet and phone untested.** The foreman's real device on a deck is a tablet; the plate view and the trace panel have not been laid out for it. | No responsive rules in `DeckExplorer.tsx` | Foremen | Assess before the pilot; at minimum the shift board and compartment card must work on a tablet. | 1.0 |
| U14 | **Failed reads render as good news.** | Pilot review B7 | Everyone | Carry fetch state; amber "unavailable" strip. | in B7 |

Total shell work specific to this analysis: about 14 engineer-weeks, of which U5 is five. The design pass that decides the role front doors, the rail, the vocabulary and the report formats should be done first, with the pilot yard's zone manager and a foreman in the room, and takes about two weeks.

## 6. Proposed information architecture

The rail today mirrors the prototype. The proposed rail mirrors the layers and the day:

| Group | Screens | Why |
|---|---|---|
| **Today** | Shift board · Deck plan | What is happening now, on paper and on the plate. Both open scoped to the user's zone or trade. |
| **Plan** | Register and lanes · Work orders · Packages | The schedule at its three grains. |
| **Conflicts** | Issues · Actions · Cascade | Find, price, and read the consequence. |
| **Data** | Sources · Imports · Field conditions | The base layer, with one card per kind of data of record and every door in one place. |
| **Record** | Ledger · Reports | What was decided, and the dated cuts people took away. |
| **Help** | Field guide · Legend | |

The persistent chrome shrinks from five bands to three: markings (required), a single status strip that carries the hull, the instant, the projection warning and the shared headline numbers, and the time control. The guardrail sentence moves into the persona menu and the Field Guide; it is true on every screen and does not need to be read on every screen.

## 7. What to do first

1. **Two-week design pass** with the pilot yard's zone manager and a foreman: role front doors, the rail, the four vocabularies in yard words, and paper mock-ups of R1, R2, R3 and R7. Test five tasks on three roles with the mock-ups before any code: "what is my crew doing at 0700", "what is held in my zone and who clears it", "print tonight's board", "what changed since Monday", "which package is stuck and why".
2. **Shell sprint one (three weeks):** U1 roles and landing, U3 status strip, U4 vocabularies and legend, U8 rail, U9 empty states, U12 first run.
3. **Shell sprint two (three weeks):** U2 data layer home and layer glyphs, U7 toolbar, U10 density modes, reports R1, R2, R3, R7, R10.
4. **During the pilot:** R5, R6, R9, then the rest, driven by what the morning meeting actually asks for.
5. **Measure** on the pilot floor: first-click success on the five tasks, time to answer, and how many printed sheets come from the tool versus from a spreadsheet.

## 8. What not to build

- Dashboards of tiles. The ship board's four tiles are enough; more tiles are more numbers without grain.
- S-curves or earned-value charts until VR-23 is scoped.
- A report designer. Twelve fixed reports with a zone parameter cover the yard; a designer is a product of its own.
- Notifications or a feed. The bell showing 111 is already the wrong signal; fix the count before adding channels.
- A second theme. The dark theme is right for a wall; the print path is monochrome; a light theme is not what is missing.

---

### Appendix A · First-load measurements

Method: Chromium headless, viewport 1440 by 900, each module loaded from a blank page, 1.5 seconds after network idle. "Controls" counts buttons, inputs, selects, links and tabs with a visible box above the fold. "Words" counts text in visible elements above the fold. Full sample schedule loaded (CVN73-PIA26-full.xer, 1,561 activities). Persona Planner, hull CVN-73, instant live.

| Screen | Controls | Text elements | Words | Uppercase labels | Text colours | Type sizes at or under 12 px |
|---|---|---|---|---|---|---|
| First load (no URL) | 60 | 150 | 409 | 22 | 17 | 107 of 150 |
| Daily Ops | 88 | 230 | 689 | 94 | 16 | 198 of 230 |
| Deck Explorer | 60 | 150 | 409 | 22 | 17 | 107 of 150 |
| Sequence Board | 65 | 234 | 464 | 75 | 17 | 211 of 234 |
| Work Orders | 44 | 179 | 338 | 60 | 14 | 124 of 179 |
| Conflicts and Risk | 57 | 151 | 633 | 30 | 17 | 106 of 151 |
| Portfolio | 33 | 79 | 157 | 21 | 13 | 59 of 79 |
| Data Sources | 36 | 123 | 504 | 23 | 14 | 100 of 123 |
| Distributed Packages | 40 | 136 | 491 | 29 | 15 | 96 of 136 |
| Decisions Ledger | 30 | 75 | 210 | 18 | 14 | 59 of 75 |
| Deconfliction Cascade | 63 | 132 | 387 | 19 | 17 | 109 of 132 |
| Field Guide | 36 | 119 | 678 | 19 | 13 | 75 of 119 |

Views reached by a click, controls on the whole page: Deck Explorer zone altitude 51, ship altitude 43, readiness overlay 62, manning 62, vertical trace 73, whole ship 61; Sequence Board load digest 40, zone lanes 49, space lanes 76; Conflicts and Risk actions 48; Daily Ops day shift 475 (every row carries a link and two badges).

### Appendix B · View inventory

Eleven modules, twenty-two views, four drawers.

- **Daily Ops:** this instant · days · swing · night; print.
- **Deck Explorer:** compartment altitude (single deck · vertical trace · whole ship; drawing · schematic; by space · by trade; readiness overlay; manning; restricted only; zones and compartments), zone altitude board, ship altitude board.
- **Sequence Board:** register · zone lanes · space lanes · load digest (week · month); import, export register, export logic, discard.
- **Work Orders:** table; budget door.
- **Conflicts and Risk:** issues (all · holds · plan · flow) · actions.
- **Portfolio.** **Data Sources:** six cards, five doors.
- **Distributed Packages:** chain · waits-on map · 3D walkthrough · schedule trace.
- **Decisions Ledger.** **Deconfliction Cascade:** map · 3D walkthrough. **Field Guide.**
- **Drawers:** job card, activity inspector, decision trace with field conditions and options, clear-with-basis.

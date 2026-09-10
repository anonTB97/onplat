# Council 4 — Naval UX/HCI lead: the shell for planners, supervisors and the deck plate

Reviewed on `claude/kickoff-from-docs-arhiib` at `478d734` (clean tree). Run
against `target/release/serve` (`85efd67-dirty`, memory store) serving
`shell-web/dist` (built 2026-09-09 21:05, one commit behind head — nothing in
`shell-web/src` changed since) on the reference hull, with Chromium 1194 via
`playwright-core` at three viewports: 1440×900 desk, 768×1024 tablet with
touch, 390×844 phone with touch at 2×. The scripts and every screenshot are in
the session scratchpad (`ux-pass.mjs`, `degraded.mjs`, `shots/report.json`,
`shots/degraded.json`); nothing was implemented. Earlier council documents:
1 (platform), 2 (ATO), 3 (data and performance), 7 (hull grid) — tensions in
§4. `docs/programme/s20-vocabulary-polish-and-onboarding.md` (S20) already
audited the badge primitive, the words and the Legend; this pass takes its 42
rows as given and names what it missed (§1.2 "vocabulary", §4.5). S17–S20 have
**not** landed: no `e2e/`, no `words.ts`, `Badge.tsx`, `Notice.tsx` or
`keyboard.ts` exist, so everything below is measured on the shell S20
described.

## 1. Current state

### 1.1 Solid — keep, and build the field and wall modes on it

- **Roles have real front doors.** Seven personas, each with a landing
  module, an altitude and a horizon (`Chrome.tsx:156-164`), remembered per
  browser (`:166-186`); the matrix is one table (`roles.rs:190-229`) and the
  shell greys every door with the server's own sentence — on the switchgear
  drawer as Zone Manager: *Zone Manager may not record a clearance —
  clear_hazard is held by Ship Super and Safety* (screenshot
  `1440-deckExplorer-ZoneManager`). "Who may" is never a shell guess.
- **One palette per fact, and the field-relevant distinction is first-class.**
  `STATE_STYLE`, `READINESS_STYLE`, `OVERLAY_STYLE` (`theme.ts:11-118`);
  `overlayBucket` (`:121-128`) splits WAIT (clears on a clock) from STOP
  (someone must go) — exactly what a fire watch and a foreman need to read
  at a glance, served, not derived.
- **A failed verdict read never blanks to "nothing held".** `verdictsOk`
  (`App.tsx:137-140`, set false on a failed deck-states read, `:255-292`);
  the strip then reads *Verdicts unavailable — the engine did not answer for
  this instant. Do not read any board as clearance* (`Chrome.tsx:986-989`).
  Measured: a scrub under a 503 produced exactly that line.
- **The same five numbers on every screen** (`Chrome.tsx:957-1012`): 82 /
  29,682 MH / 493 / 662 / 107,899 MH read identically on all nine screens
  photographed; a supervisor's fast status check has one place to look.
- **Markings are fixed to both edges, amber when not received**
  (`Chrome.tsx:46-108`); the release stamp sits on the bottom band.
- **Focus is visible product-wide** (`index.html:29-33`), disabled controls
  read as disabled (`:25-28`), landmarks exist (`header`, `nav`, `main`),
  the rail carries `aria-current` (`Chrome.tsx:1068`), icon buttons carry
  `aria-label`s, search has ↑↓/Enter/Escape (`:450-464`), the lanes and iso
  walk take arrow keys, Escape backs out of every panel one layer at a time
  (`DeckExplorer.tsx:540-548`, `ActivityInspector.tsx:92`, `JobCard.tsx:191`).
- **Desk density is right.** Daily Ops at 1440 puts 240 text elements and
  405 focusable controls on the first screen, two trade columns × 13 rows,
  held rows badged inline (`1440-dailyOps-Foreman`); the Sequence Board
  first screen carries 822 controls. Loading states are honest (*Reading the
  hull…*, `DeckExplorer.tsx:977`; the plate says *Loading … plate…*,
  `:2398-2408`); heavy lists are bounded (council 3 §1.1).
- **The paper path is the real field fallback** (`reports.ts` sheets:
  shift, zone day, compartment card, monochrome, cut header, layer per
  figure). In a yard where a phone is not allowed near a plant space, the
  printed shift sheet *is* the degraded mode, and it is correct.

### 1.2 Missing — with evidence

**Roles.** Neither QA/NDT nor fire watch exists as a role (`roles.rs:108-123`
lists eight; `PERSONAS` seven; `identity-proxy-contract.md` §3). The
ingredients do: work type `inspection` on the register with its own chip
(`SequenceBoard.tsx` work-type chips; 4 of the 8 first rows in
`1440-sequenceBoard-Planner` are NDT surveys), hazard kinds `hot_work_live`
and `stop_work` with `inspection_authority` (`api.ts:543-547`), R04's
30-minute fire-watch tail (S14), and R08 *Fire-watch credential invalid at
request* in `handoff/01-rule-table.csv:7` — which the seed does not compile
(the seed is "hot-work-only", `RuleTableCard.tsx:199`). The words "fire
watch" appear nowhere in `shell-web/src` (grep). What a fire watch cannot do
today: close their own permit's record (`clear_hazard` is Ship Super and
Safety only, `roles.rs:200-217`) or see *every open hot-work permit and its
R04 footprint* without selecting spaces one at a time — the plate draws the
cascade route only for the selected space (`DeckExplorer.tsx:2343-2351`), and
the hot-vs-flammable pairs from `/work-conflicts` reach the shell as a count
(`SequenceBoard.tsx:441`; zone strip `DeckExplorer.tsx:1597`), never as a
drawing. QA/NDT has no completion-evidence concept at all — and should not:
the product authorises entry, it does not accept work (Pillar "decision
support"); what QA needs here is the inspection register filtered to
executability and the stop-work door. Adding a role touches
`roles.rs`, `identity.ts` `ROLE_WORDS`, `Chrome.tsx` `PERSONAS`, the
contract §3, the generated weakest-role tests and the SSP; whether these
people have a directory group is §5 Q2.

**Responsive layout: none.** Zero `@media` rules in `shell-web/src` (grep);
every size is a pixel literal; the rail is 214 px and open by default
(`App.tsx:153`, `Chrome.tsx:1042`); the top bar is a non-wrapping flex row
(`Chrome.tsx:412-423`) whose identity button is 447–537 px wide (measured;
`Chrome.tsx:574` clamps only the crumb). Measured `scrollWidth − innerWidth`:
**+205…+295 px at 1440** — the desk build already scrolls horizontally on
every screen — 0 at 768 with the crumb and identity button off-canvas
(`768-deckExplorer-ShipSuper-full`), **+85…+175 at 390** where the content
column is ~170 px beside the open rail, Daily Ops is one word wide, and
Chromium's text autosizing inflates 52 nodes to 31.7 px because the page
overflows (`390-dailyOps-Foreman`, `390-sequenceBoard-Planner`). Tables
carry `minWidth` 900–1100 with no `overflow-x` wrapper
(`SequenceBoard.tsx:907`, `WeekAhead.tsx:370`, `Proposals.tsx:183`,
`LedgerBoard.tsx:197`). The Legend menu is a fixed 420 px (`Chrome.tsx:518`).
`docs/ux-gap-analysis.md` U13 deferred this to "the pilot's device list";
`docs/pilot-playbook.md:44` Y15 already says the foremen carry tablets.

**Touch.** Sub-44 px targets per first screen: 92–120 on Daily Ops, 93–98 on
the Sequence Board, **516 on the Cascade map** at 1440 (the compartment
squares, 8 px labels). Chips are 42×21 (`TimeControl.tsx:358-368`; `chipStyle`
`theme.ts:164-173`), icon buttons 30×30 (`Chrome.tsx:891-904`), the search
input 16 px tall, the compartment button on a shift row `fontSize: 10,
padding: 1px 5px` (`DailyOps.tsx:500-504`). Pan canvases set `touchAction:
none` (`DeckExplorer.tsx:2412, 3047`, `ZoneLanes.tsx:388`,
`VerticalTrace.tsx:306`) — drag works, pinch does not (zoom is wheel
`DeckExplorer.tsx:2229-2241` and buttons). Every gloss is a `title`
(`Chrome.tsx:970-975`, `DailyOps.tsx:489-496`, badge tooltips) — on touch
that information does not exist. S20 keeps `title` as the primary carrier
(`Badge` "title defaults to v.gloss").

**Keyboard.** No focus return on close (measured: Escape closed the drawer,
focus stayed on the rail — S20 row 29); no `aria-modal`/trap on drawer,
inspector or job card (grep: none); no skip link; the module rail is 13
tab stops, the time control 16 (each native date input is 4); no global
shortcuts (keys `1 2 g d ? /` change nothing); the sequential focus start
landed inside the drawer's option buttons before the top bar. A planner
reaching the Sequence Board by keyboard presses Tab ~30 times.

**Motion.** No `prefers-reduced-motion` anywhere; `Loading.tsx:11,22` runs an
infinite breathe; `SequenceBoard.tsx:423` a slide; playback advances every
800 ms (`TimeControl.tsx:309-324`) and fires deck-states twice per tick (16
requests in 8 s measured) — on a carrier hull that is council 3's stacked
minutes, started by one tap of ▶.

**Contrast and colour (measured from `theme.ts` hexes).** `C.subtle`
`#6e7480` is 4.17:1 on `bg`, 3.96 on `panel`, 3.70 on the top bar — used for
9.5–10.5 px uppercase labels (`DeckExplorer.tsx:1531,1561,1592`, rulers,
provenance): fails AA. `C.faint` `#4b5060` is 2.44:1 on `bg`, **2.0 on the
rail** (group labels at 8.5 px, `Chrome.tsx:1060`) and 2.16 for the release
stamp (`:100`): fails everything. `C.accent` `#3D6BFF` as link text is 4.42
(activity codes on every board): just under AA. `OVERLAY_STYLE.stop` red
`#dc2626` as text is 3.85 on `panel` (the STOP word on the drawer head).
Colour is the only carrier on the Cascade map (green freed / red shut /
outline held, `CascadeBoard` legend), the ship-view chips and the plate
markers; the first-run swatches are colour-only squares (`FirstRun.tsx:73`).
Per screen 51–171 text elements are under 11 px (ux-gap U10, still open).

**Degraded behaviour (measured with `page.route`).**
- *Every `/api` 503 after a good boot, module switch:* Deck Explorer reads
  *This hull is out of scope for you, or the API is unreachable (Error: decks
  → 503)* (`DeckExplorer.tsx:709`) — an RBAC refusal and a server failure in
  one sentence, with `String(e)` scaffolding (S20 row 12). Daily Ops drops
  from 403 to 37 controls: last-good is discarded. The strip above still
  says *82 spaces held now · 29,682 MH* from before the failure with no
  "as of" — `rows` is only cleared when the strip's own read fails
  (`App.tsx:255-292`), so one screen says unavailable while the number above
  it says 82.
- *Every `/api` hangs:* after 25 s the Deck Explorer headline reads **"0 of 0
  compartments have work booked that the engine currently refuses"**
  (`DeckExplorer.tsx:774`, `heldCount` over an empty `rows`) above *Reading
  the hull…* — a zero reading during a stall, the exact shape the codebase
  says it forbids. No fetch has a timeout or `AbortController`
  (`api.ts`: none; council 3 §1.2.7).
- *Browser offline, reload:* Chromium's own *No internet* page — no service
  worker, no app shell, no `navigator.onLine` handling (grep). Offline
  without reload keeps whatever was on screen, unmarked.
- No "stale since HH:MM" anywhere; no `visibilitychange`; the hash is parsed
  once at boot (`App.tsx:107`), so a link opened in a running tab does nothing.

**Vocabulary — what S20 missed.**
1. `SUSPEND` wears **SECURED** (`theme.ts:25`). On a deck plate *secured*
   means made safe — a secured bus is de-energised, a secured space is
   tagged out and gas-freed. Here it means *held until the condition clears*:
   the label inverts the yard's meaning on the one state where the mistake
   matters. S20's "Needs from the yard" asks held/secured/tagged in general;
   it does not flag the collision.
2. `WARN` (*OPEN · CONDITIONS*, work may proceed) and `OVERLAY_STYLE.wait`
   (*held, clears on a clock*) share `#f59e0b` (`theme.ts:19-22, 97-103`);
   the projection strip and NOT EXECUTABLE are amber too. `theme.ts:9-10`
   itself says amber on a plate reads as a hold. Colour alone must never
   separate "go" from "held"; S20 left the three fact palettes unchanged.
3. Readiness `held` and authorization `BLOCK` share `#f87171`
   (`theme.ts:28, 45`); the Daily Ops HELD button is a third red
   (`C.dangerSoft`). Three reds, two facts.
4. `title` tooltips as the gloss carrier (above) — the Legend drawer and
   per-screen first-run cards are the touch answer; S20 has them but keeps
   `title` primary.
5. "Restricted only" — council 2 R10a renames it; agreed (§4.2).
6. Zone names: `Z4` is every heading (council 7 §5 resolves it; §4.4).

**The binary's default markings.** With `WADL_MARKINGS` unset the band wears
*BigBear.ai Proprietary | Competition Sensitive | All Represented Information
is Open Sourced* (`auth.rs:87-91`, seen on every screenshot). The shell's
honest amber *HANDLING MARKINGS NOT RECEIVED — DO NOT SCREENSHOT*
(`Chrome.tsx:81-82`) therefore never fires on this build. On a yard's data
that is a vendor's caveat, and "Open Sourced", across NNPI screens.

**The strip's prototype constants** *ILLUSTRATIVE / NOTIONAL DATA · IL5 /
sovereign* (`Chrome.tsx:1000-1008`; S20 row 15) and the rail's constant green
*Sovereign node · synced* (`:1117-1120`; S20 row 30) — both still on screen.

**Section 508 is absent from the ATO material**: no mention of 508, VPAT,
WCAG or accessibility in `docs/ato-package.md`, `docs/ssp-input.md`,
`docs/production-posture.md`, `docs/poam.md` or the SSP template (grep).

### 1.3 Disqualifying

Nothing architectural. Inline-style React with one theme module is a shell a
density token and one stylesheet can carry; no rewrite is proposed.

1. **For fielding under DoD acquisition (Section 508 / WCAG 2.x AA):** the
   contrast failures on `C.subtle`/`C.faint`/accent text, colour-only state
   on the map and plate, hover-only glosses, no reduced-motion, no focus
   management on modal panels. Not an RMF control, but a conformance
   statement the acquisition requires and the package does not have. Fixable
   in `theme.ts` and two primitives (U6, U7, U8).
2. **For the deck-plate roles at 390 px and for the tablet's top bar at
   768:** no layout exists below ~1100 px; the field views the playbook
   promises (`pilot-playbook.md:44`, Y15 tablets) do not work. Fixable
   without a second product (U3, U4).
3. **For carrier-scale concurrent use:** under council 3's measured 12–41 s
   reads and future sheds, the shell shows a strip from a minute ago over a
   board that says unavailable, *0 of 0* during a stall, and discards the
   last good board on a 503. That is the schedule-integrity ambiguity the
   mandate forbids, and it is the shell's half of council 3 D10 (U2).
4. **For NNPI screens:** the vendor default marking (U1) — a one-line fix
   that must land before any screenshot leaves a yard.

### 1.4 Measurements

| What | Value |
|---|---|
| `@media` rules / `prefers-reduced-motion` / `AbortController` / `navigator.onLine` / `aria-modal` in `shell-web/src` | 0 / 0 / 0 / 0 / 0 |
| Horizontal overflow (`scrollWidth − innerWidth`) at 1440 / 768 / 390 | +205…+295 / 0 (header off-canvas) / +85…+175 px |
| Text nodes autosized above 30 px at 390 (Chromium font boosting) | 33–52 per screen |
| Sub-44 px interactive targets on the first screen, 1440: Daily Ops / Sequence Board / Cascade / Leverage | 92 / 94 / 516 / 69 |
| Text elements under 11 px on the first screen | 51–171 per screen (8 px cascade labels, 8.5 px rail groups, 9.5 px badges and bands) |
| Contrast: `C.subtle` on bg/panel/topbar · `C.faint` on bg/rail · accent link on bg · STOP red text on panel | 4.17 / 3.96 / 3.70 · 2.44 / 2.00 · 4.42 · 3.85 |
| Tab stops before the first module in the rail on the Deck Explorer | 26 (5 of them inside the drawer, 4 per date input) |
| Global keyboard shortcuts | none |
| Playback: `/deck-states` requests in 8 s on the Deck Explorer | 16 (2 per 800 ms tick) |
| Every `/api` 503, scrub Daily Ops | controls 403 → 37; strip keeps prior numbers; *Register unavailable (Error: activities → 503)* |
| Every `/api` hung 25 s, Deck Explorer | *0 of 0 compartments have work booked…* + *Reading the hull…*; no timeout |
| Offline reload | browser error page; no app shell |
| Time to first paint of a board after navigation, release binary, reference hull | 2.1–3.1 s (network idle + 1.2 s settle), all widths |

## 2. Prioritised actions

Effort in agent-hours including tests. Class: **ato** (blocks the
accreditation or the 508 conformance the acquisition needs), **crash_perf**
(the shell's behaviour under the measured stall), **ux_polish**.

| id | action | class | effort | depends on |
|---|---|---|---|---|
| U1 | Delete `DEFAULT_MARKINGS`; unset `WADL_MARKINGS` serves `[]` and the band goes amber; the demo's `dev.sh` sets its own string | ato | 0.5 | — |
| U2 | Degraded-state contract in the shell: one `Staleness` per hull `{asOf, since, reason}` held in `App`, shared by strip and boards; last-good stays; every board wears *as of HH:MM · server busy/unreachable/offline*; `0 of N` never rendered until the read lands; 404 (scope) and 5xx/timeout are two sentences; fetch timeout 45 s; playback pauses while in flight | crash_perf | 6 | council 3 D10 (same change, this is the words and the rule) |
| U3 | Responsive skeleton: one stylesheet with three breakpoints; rail collapses ≤1100 and becomes a drawer ≤768; top bar wraps into two rows and truncates the identity button; tables in `overflow-x: auto` wrappers; body never scrolls sideways; Legend/menus full-width ≤480 | ux_polish | 6 | — |
| U4 | One density token: `data-density="compact|standard|wall"` on the app root, every size in `theme.ts` expressed from `--u` (the unit) so the three settings scale type, padding and hit areas together; replaces `zoom` (`App.tsx:551`); default compact on pointer-fine ≥1100, standard on coarse pointer or ≤1100, wall from the existing button | ux_polish | 6 | U3 |
| U5 | Touch rules: hit areas ≥44 px at standard/wall (chips, icon buttons, compartment buttons, date control); every `title` gloss also reachable by tap (Badge opens its Legend entry; stat glosses under a ⓘ); pinch-zoom on the three canvases; no hover-only information | ux_polish | 4 | U4, S20 `Badge` |
| U6 | Colour independence and contrast: a glyph per state on plate/map/ship-view/first-run (▲ hot, ■ held, ◔ clears-on-clock, ✕ no entry); `C.faint` no longer used for text; `C.subtle` lightened to ≥4.5 on `panel`; accent link ≥4.5; STOP text red ≥4.5; a vitest over `theme.ts` pairs | ato | 3 | — |
| U7 | Reduced motion: `@media (prefers-reduced-motion)` kills breathe and slide; playback under it steps on ▶ press only | ux_polish | 1 | — |
| U8 | Keyboard model: skip link; roving `tabindex` on rail, chip groups and shift chips; `useDismiss` focus return (S20) plus `aria-modal` + trap on drawer/inspector/job card; shortcuts `/` search, `g` then `d w e s c l r` modules, `[` `]` step the clock, `.` now, `?` the cheat-sheet; strip changes announced `aria-live="polite"` | ux_polish | 5 | S20 `keyboard.ts` |
| U9 | Vocabulary: SECURED → *HELD · CLEARS* (yard word pending §5 Q3); WAIT gets its own hue-independent mark and a non-amber tint; Daily Ops HELD button adopts `READINESS_STYLE.held`; "Restricted only" → "Held only"; all in `words.ts`/`theme.ts` | ux_polish | 2 | S20 |
| U10 | Fire-watch role and lens: role `fire_watch` (`raise_hazard` + a new capability `close_own_permit` gating `hazards/clear` on `hot_work_live` rows the same person raised, server-side); landing Deck Explorer with a **Hot work now** lens: every open `hot_work_live` and its R04 footprint from the served deck-states traces, and the hot-vs-flammable pairs drawn as links; a "fire watch" word in the trace sentence for R04's tail | ux_polish | 8 | S18 (pairs as issues), council 7 HG-5, §5 Q2 |
| U11 | QA/NDT role: role `qa_ndt` (`raise_hazard` for `stop_work` only — same kind-scoped gate as U10); landing Sequence Board with work type `inspection` and *Not executable* preset; no completion evidence (out of scope, said so in the role card) | ux_polish | 3 | U10's gate, §5 Q2 |
| U12 | Field landing per role at standard density: Foreman lands on *my trade's column* (trade from `x-wadl-trade` or a per-browser choice until the proxy carries it), one column, held rows first; Zone Manager keeps zone focus; both ask the server for their page once council 3 D8 lands | ux_polish | 3 | U4, council 3 D8, §5 Q1 |
| U13 | Offline rule: no service worker, no persistent cache (NNPI never lands on disk); `navigator.onLine` + fetch failure set `Staleness.reason = offline`; the printed sheet is the offline mode and the role cards say so | ux_polish | 1 | U2 |
| U14 | 508 in the package: a conformance section in `docs/ato-package.md`, the contrast vitest as evidence, an axe pass in the S17 smoke (`axe-core` dev-only, admitted under Pillar 1 §3 as test tooling) | ato | 3 | U6, S17 |
| U15 | S17 smoke gains 768 and 390 viewports and the three degraded steps (503, hang, offline) as regressions, screenshots archived; `SMOKE_VIEWPORT` becomes a list | ux_polish | 2 | S17, U2, U3 |
| U16 | Wall: `density=wall` scales the chrome too (today `zoom` scales `main` only); the meeting's two screens (Deck Explorer ship altitude, Daily Ops) get a `?wall=1` boot flag for the kiosk | ux_polish | 1 | U4 |

Order: U1 today. U2 with council 3 D10 (one change). U6, U7 (theme only)
and U9 with S20 sitting A. U3 → U4 → U5 → U12 as one shell sitting after
S20, before the tablet check in `charter.md:118`. U8 with S20 sitting B.
U10/U11 after S18 and Q2. U14/U15 with S17.

## 3. Concrete changes

| file | change | why |
|---|---|---|
| `crates/wadl-api/src/auth.rs:84-91, 108-118` | Remove `DEFAULT_MARKINGS`; `markings` is `Vec::new()` when unset; `serve.rs` banner prints *markings: none — the band will read NOT RECEIVED*; `scripts/dev.sh` exports `WADL_MARKINGS="DEMO DATA \| NOTIONAL"`; SSP §4 row for `WADL_MARKINGS` says "no default" | A vendor caveat on a yard's NNPI screens; the shell's honest amber never fires |
| `shell-web/src/App.tsx` (`rows`, `issues`, `verdictsOk`, `:255-292`) | Replace `verdictsOk` with `stale: Staleness \| null` `{ asOf: number, since: number, reason: "busy" \| "unreachable" \| "offline" \| "timeout" }`; failed reads keep `rows`/`issues` and set `stale`; a successful read clears it. Pass `stale` to `StatusStrip` and every module. `apiFetch` (from council 3 D10) is the one place `AbortController` (45 s) and `navigator.onLine` set the reason | Strip and boards can no longer disagree about whether the numbers are live |
| `shell-web/src/Chrome.tsx` (`StatusStrip`, `:957-1012`) | When `stale` is set: figures dimmed, prefixed by an amber chip *as of HH:MM · {reason}*; the *Verdicts unavailable* sentence only when there is no last-good at all. Delete the two prototype constants (`:1000-1008`). Rail foot (`:1117-1120`) reads the `/health` stamp or *version unknown* (S20 row 30) | The strip is the fast status check; it must say when its numbers are from |
| `shell-web/src/DeckExplorer.tsx:709` | Two branches: `ApiRefusal.status === 404` → *Not assigned to you — the server refuses this hull; that refusal is the access control working* (S20 row 38 wording); otherwise `<Unavailable what="The hull" error />` | An RBAC refusal and a dead server are different facts with different actions |
| `shell-web/src/DeckExplorer.tsx:774` | Render the sentence only when `rows.length > 0 \|\| stale === null && loaded`; while loading: *Reading the hull — no verdicts yet* | *0 of 0* during a stall reads as clearance |
| `shell-web/src/Notice.tsx` (S20, new) | `<Stale s={Staleness} />` — the one chip every board mounts under its header; `<Unavailable>` gains `scope?: boolean` for the 404 wording | One staleness word on every screen |
| `shell-web/src/TimeControl.tsx:309-324` | Playback skips a tick while `inFlight > 0` (council 3) and, under `prefers-reduced-motion`, ▶ steps one notch per press | One tap must not queue minutes of server work |
| `shell-web/src/theme.ts` | Add `export const UNIT` read from `--u` and `density` tokens: `compact { u: 1, hit: 24, body: 12.5 }`, `standard { u: 1.15, hit: 44, body: 14 }`, `wall { u: 1.5, hit: 44, body: 18 }`; `chipStyle`, `badgeStyle`, `iconBtnStyle`, `thStyle`, `tdStyle`, `commitBtnStyle` take sizes from `UNIT`; `C.subtle` → `#8a90a0` (4.5+ on panel); `C.faint` kept for rules and swatches only (a lint test greps `color: C.faint`); `OVERLAY_STYLE.stop.fg` → `#f87171` for text, `#dc2626` stays the fill; `STATE_STYLE.SUSPEND.label` → *HELD · CLEARS* pending Q3; each of the three fact palettes gains `glyph` | One token, three densities, no second product; AA on every text ink |
| `shell-web/src/index.css` (new) + `index.html` | The only stylesheet: `:root[data-density]` sets `--u`; `@media (max-width:1100px)` rail collapsed, `@media (max-width:768px)` rail as an overlay drawer, top bar two rows, `.tablewrap { overflow-x:auto }`; `@media (max-width:480px)` menus and Legend `width:100vw`; `@media (prefers-reduced-motion:reduce) { *, ::before, ::after { animation:none !important; transition:none !important } }`; `@media (pointer:coarse)` default density standard; `@media print` (S20 row 37) | Everything inline styles cannot express, in one place, like `index.html`'s focus rule today |
| `shell-web/src/App.tsx:529-553` | Root `<div data-density={density}>`; `density` state: `wall` from the button, else `standard` when `matchMedia("(pointer: coarse)")` or width ≤1100, else `compact`; overridable in the role menu (*Density: compact · standard · wall*), remembered per browser; `collapsed` defaults from the breakpoint; delete `zoom` | The tension in §4.6 resolved in one token |
| `shell-web/src/Chrome.tsx:412-475, 655-680` | `header` `flexWrap: "wrap"`; identity button `maxWidth: 260` with ellipsis at compact, name only ≤768; search `flex: 1 1 160px`; hull crumb second row ≤1100; Legend panel `width: min(420px, 100vw − 16px)` | The desk build must not scroll sideways; the tablet must keep the identity and the hull in view |
| `SequenceBoard.tsx:907`, `WeekAhead.tsx:370`, `Proposals.tsx:183`, `LedgerBoard.tsx:197`, `ReadinessBoards.tsx:239`, `RuleTableCard.tsx:343` | Wrap each `<table>` in `<div className="tablewrap">` | Tables may be wider than the phone; the page may not |
| `shell-web/src/Badge.tsx` (S20) | `onClick` default opens the Legend drawer filtered to this word; `title` stays for the pointer; hit area from `UNIT.hit` at standard/wall via padding; a `glyph` before the word when the palette carries one | A gloss a thumb can reach; a state a colour-blind reader can tell |
| `shell-web/src/ModuleHeader.tsx`, `Chrome.tsx:970-975` | Stat glosses: a ⓘ button (44 px at standard) that toggles the gloss as text under the row | Same |
| `DeckExplorer.tsx:2410-2431, 3047`, `ZoneLanes.tsx:388`, `VerticalTrace.tsx:306` | Two-pointer pinch on the pan canvases (track two `pointerId`s, scale from their distance) using the existing `zoom`/`pan` state | Field zoom without a wheel |
| `CascadeBoard.tsx` map, `ShipView.tsx` chips, `DeckExplorer` plate markers, `FirstRun.tsx:73` | Draw the palette's `glyph` inside each square/chip; legend rows show glyph + swatch | Colour is not the only carrier |
| `shell-web/src/keyboard.ts` (S20) | `useRovingTabs(containerRef)` for the rail, horizon chips, watch chips, trade chips; `useShortcuts(map)` mounted once in `App` (`/`, `g d/w/e/s/c/l/r`, `[`, `]`, `.`, `?`), disabled while an input has focus; a skip link *Skip to the board* as the first element of `App`; `aria-modal="true"` + focus trap in `useDismiss` for drawer, inspector, job card | Desk efficiency without leaving the keyboard |
| `shell-web/src/Chrome.tsx` (`StatusStrip`) | `aria-live="polite"` on the figures row; announce *held now N* on change only | The bell and the strip reach a screen reader |
| `crates/wadl-api/src/roles.rs`, `identity.ts`, `Chrome.tsx:156-164`, `docs/identity-proxy-contract.md` §3, generated tests, SSP | Roles `fire_watch` (`raise_hazard`, `close_own_permit`) and `qa_ndt` (`raise_hazard`); `close_own_permit` gates `POST hazards/clear` when the hazard kind is `hot_work_live` and `raised_by == actor` (checked in the handler after the matrix; refused with the sentence otherwise); personas: Fire Watch → `deckExplorer` lens `hotwork`, altitude zone, horizon day; QA/NDT → `sequenceBoard?work_type=inspection&notExecutable=1` | The two teams the mandate names exist as roles with real doors |
| `shell-web/src/DeckExplorer.tsx` (lens row `:~1000`) | Fourth lens **Hot work now**: markers for every row whose served trace names a `hot_work_live` hazard (origin ▲, R04 footprint ■), hot-vs-flammable pairs from `/work-conflicts` as dashed links, the strip *N permits open · M spaces under fire-watch tail · K hot-vs-flammable pairs* | Deconfliction at a glance without selecting spaces |
| `shell-web/src/DailyOps.tsx:486-509` | `<Badge v={SHIFT_FLAG.HELD_NOW}>` beside the compartment chip (S20 row 18) and the compartment button takes `UNIT.hit`; a *My trade* chip that pins one column (from `whoami.trade` when the proxy carries it, else per browser) | A foreman's column on a tablet in one tap |
| `shell-web/src/api.ts` | `apiFetch(path, init)`: `AbortController` 45 s, `x-wadl-request` echoed into `ApiRefusal.req` (council 2 R4) so *unavailable* lines can show `ref <req>`; `navigator.onLine === false` → throws `ApiRefusal(0, "offline")` before fetching | One place the reasons come from |
| `shell-web/src/theme.test.ts` (new) | Contrast ≥4.5 for every `(ink, ground)` pair the primitives use, computed from the hexes; fails on a darker `C.subtle` | The 508 evidence is a test, not a claim |
| `shell-web/e2e/` (S17) | `lib.mjs` viewports `[1600x900, 768x1024 touch, 390x844 touch]`; steps `degraded-503`, `degraded-hang` (asserts no *0 of 0*, the stale chip present), `degraded-offline`; `axe-core` run per screen, violations archived | What was measured by hand here becomes a gate |
| `docs/ato-package.md` §2 (new subsection), `docs/poam.md` | "Section 508 / WCAG 2.1 AA" status with the contrast test and axe report as evidence; POAM-16 until U6/U8 land; POAM-17 the default marking (closed by U1) | The acquisition's conformance statement |
| `docs/training-guide.md` (S20), `docs/pilot-playbook.md` Y15 | Fire Watch and QA/NDT role cards (three tasks each); Y15 asks for the devices, gloves, and whether phones enter plant spaces; the offline rule in every card's *When something reads wrong* | The people the roles are for |

## 4. Tensions with earlier personas and proposed resolutions

1. **Council 3 D9/D10 (epoch poll, 45 s abort, last-good + "stale since"
   chip, playback pause).** Agreed and adopted as U2; this pass adds the
   rules D10 does not state: the chip is one object shared by strip and
   board (today they can disagree); a 404 is never worded as a failure; no
   count is rendered from an empty read; and D9's bump must not flash a
   board that has not changed (D9 already bumps only on epoch change — keep
   it). D8 paging is what U12's *my trade* column should ask for; until D8
   the column is a client filter over the whole register, as today.
2. **Council 2 R7 (consent banner before first render) and R10 (marking,
   "Held only").** Agreed. Resolution for the field: the banner is a full
   sheet at standard density with one 44 px acknowledge, per browser session;
   on the wall display it must be acknowledged by whoever unlocks the kiosk
   (§5 Q4). The `handling` marking of R10a is worn on the space chip as a
   glyph + word, never colour. **Offline (U13) vs council 2:** nothing is
   cached to disk — no service worker, no IndexedDB — so an offline field
   device shows only what is in memory; council 2 should confirm memory-only
   last-good on a field tablet is acceptable (§5 Q5). Council 2 R4's request
   id is surfaced on the *unavailable* line so a field report can be joined
   to an audit line.
3. **Council 1 A7 (import 503 "another import in progress").** Agreed; it
   renders through `<Unavailable>` with the server's sentence, and the dry
   run is not gated, so the Data Sources staging area never loses its file.
4. **Council 7 §5 (zone names; the code in the tooltip).** Agreed on the
   names; the tooltip half is hover-only — the heading reads *Z4 · Propulsion
   Plant & Midships*, the owner on a second line, the code as the chip text.
   HG-5's plate notice ("calibrated on CV-67, not this hull") must be visible
   text on the plate header, not a `title`.
5. **S20.** Built on, not redone: `Badge`, `Trace`, `Notice`, `keyboard.ts`,
   the Legend drawer and per-pair first-run cards are the right primitives
   and every change in §3 hangs off them. What it missed is §1.2
   "vocabulary": SECURED's collision, WAIT/WARN on one amber, three reds,
   `title` as the gloss carrier, the contrast of the inks its primitives
   inherit, and colour-only state on the map. Its two out-of-scope rows —
   density (U10 of the gap analysis) and tablet (U13) — cannot stay deferred
   to "the pilot's device list": with zero `@media` in the tree the first
   tablet is the first test. Resolution: S20 sitting A adopts U6/U7/U9
   (theme-only, no new files); U3/U4/U5 are a separate shell sitting
   immediately after S20 and before `charter.md:118`'s tablet check.
6. **Field glanceability vs desk density — named and resolved.** A foreman
   with gloves needs 44 px targets, 14 px body and one column; a planner
   needs 800 controls on one screen. Two products would drift on the words
   and the states within a month. Resolution: **one density token with three
   settings** (U4) — `compact` (today's desk), `standard` (touch/tablet),
   `wall` — chosen by pointer type and width, overridable in the role menu,
   applied through `theme.ts` units so every primitive scales together and
   no screen has a second layout. Role landings (U12) choose *what* is on
   the screen; density chooses *how big*; neither is a fork.
7. **Council 3 D11 (hand-rolled virtualisation).** Agreed, with one rule:
   the windowed Sequence Board must keep the focused row mounted and roving
   tabindex intact (a row that unmounts under focus drops the keyboard user
   to `body`); arrow-key navigation moves the window, not the other way.
8. **Council 1 §1.2 `/health` disclosure vs the rail foot (S20 row 30).**
   The foot reads the stamp through the proxy where `/health` is scoped by
   R13; behind the shim it reads it as today. No conflict.

## 5. Questions only the customer can answer

1. Which devices the deck-plate roles actually carry — ruggedised tablet
   size, gloves, whether a phone may enter a plant or magazine space at all —
   and the wall display's size and browser (Edge version, kiosk mode).
2. Do fire watches and QA/NDT inspectors have their own directory groups
   and CAC sessions, or do they read from a supervisor's tablet? May a fire
   watch close the record of their own permit, or is that always Safety?
3. The yard's words: what *secured* means on this deck plate, and whether a
   held space is *held*, *tagged*, *red-tagged* or *secured*; the display
   names of the clearing authorities (S20's ask).
4. The shared display: who is signed in on the wall, how the AC-11 lock and
   the consent banner apply to a kiosk, and whether playback is ever left
   running unattended (council 3 Q1).
5. Whether a field tablet may hold the last good board in memory while
   offline, and the screen-lock policy for a device carrying NNPI screens.
6. Whether the acquisition requires a VPAT, and at which WCAG level; any
   colour-vision requirement for safety displays, and whether the yard's
   tag-out colours should be the palette's.
7. Whether the identity proxy can assert a trade (`x-wadl-trade`) so a
   foreman's landing is their own column without a per-browser choice.
8. The freshness a fire watch needs on a rolling *Hot work now* board (a
   permit closed on the plate visible on the shack's screen within how many
   seconds) — council 3 Q2, asked for this role specifically.

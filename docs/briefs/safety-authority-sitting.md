# Brief for the rule-table sitting with the yard's safety authority

The rule table is versioned data the safety authority owns
(`docs/adr/0002-rules-are-versioned-data.md`); the engine applies whatever
rows it is handed and records the version of each row that fired. What runs
today is a development seed transcribed from the prototype's cascade
scenarios, nine entries covering seven of the table's twenty rows, and it
disagrees with `handoff/01-rule-table.csv` in two places and narrows it in
several more. This brief is what we bring to the sitting: what the engine
does with a row, the seed audited row by row against the table, the
questions still open, the decisions the authority must make with the default
in force for each, the golden trace they sign per row, and what runs until
they sign. Pilot barrier B11 (`docs/pilot-readiness-review.md` §4) closes at
this sitting or on the signed fallback in §6.

Sections: 1 what the engine does with a row · 2 the seed against the table ·
3 open questions · 4 decisions to make · 5 the golden trace they sign · 6 by
default until they do · 7 what each side brings.

## 1. What the engine does with a rule row

A row in force is a `RuleEntry` (`crates/wadl-engine/src/rules.rs`):

| Field | Meaning | Where the table's column lands |
|---|---|---|
| `rule_code` | the human code, rendered in the trace | Rule ID |
| `rule_version` | the version that produced a decision, recorded on every trace step | minted at authoring; the table has no column |
| `hazard` | which hazard kind triggers it: `coating_open`, `hot_work_live`, `energised_bus`, `flammable_stow`, `stop_work` (`evaluate.rs` `HazardKind`) | Trigger condition, reduced to a kind |
| `applies` | `SameSpace` (the hazard's own compartment) or `Coupled { code, max_hops }` (spaces reached along couplings of one code within a hop count) | Propagation type + Hop depth |
| `state` | `BLOCK`, `SUSPEND`, `WARN` (or `ALLOW`); the most severe across every row that fires governs | Resulting state |
| `authority` | the standard string rendered in the trace | Authority document |
| `clearing_authority` | a code string (`marine_chemist`, `fire_marshal`, `isolation_authority`, `issuing_authority`) rendered as "who may clear" | Who may clear |
| `hold` | minutes, or none; `earliest_clear = hazard.since + hold` | Config anchor (`coatingCureMinutes`, `fireWatchHoldMinutes`) — the table names the anchor and gives no value |
| `waivable` | every seeded row is `false` | R15's assumption |

`evaluate()` (`crates/wadl-engine/src/evaluate.rs`) does exactly this for
one compartment at one instant:

1. For each live hazard **raised by the instant** (`Hazard::raised_by`; a
   hazard not yet raised contributes nothing), take every row whose `hazard`
   matches its kind.
2. `SameSpace` fires when the hazard's origin is the compartment;
   `Coupled` walks the hull's coupling graph from the origin along edges of
   that one `code`, to at most `max_hops`, **and no further than each edge's
   own `max_reach`** (`traversal.rs:95`), and fires wherever the walk reaches
   the compartment. Direction is the edge's: an authored coupling row with
   `symmetric` = no is one-way; derived `deck_penetration` edges run from
   the upper space to the lower only (`documents.rs` `derive_vertical_edges`).
3. Each firing is a trace step: rule code, version, state, source, hazard
   label, depth, the path and the coupling codes traversed, authority,
   clearing authority, `earliest_clear`, and a sentence.
4. A step whose `hold` has **elapsed at the instant** is dropped
   (`push_live`): a timed hold clears itself at `since + hold`. A row with no
   hold never elapses; it clears only when the hazard is cleared by a person
   with a basis (the `HAZARD_CLEARED` ledger row).
5. The governing state is the most severe step; `earliest_clear` is the
   latest of the steps' holds; `governing_step()` is the step that decided
   the state, and its clearing authority is the one the screen shows.

What the engine does **not** do, and the sitting should know it does not:

- **It does not read the work type, the category or the activity.** Rows
  are selected per hull (`rules_in_force`): the in-memory store returns the
  seed whole (`memory.rs:2560`); PostgreSQL selects rows bound to the hull's
  class or to no class with `effective_to IS NULL` (`pg_repo.rs:1466`) and
  never reads `rule_binding.work_type` or `category`, although the seed
  writes `work_type = 'hot_work'` there (`pg_repo.rs:152`). So every row
  applies to every activity in a space: a cold-work inspection is refused by
  a hot-work rule. That is B11's core and S14's job.
- **It does not select rule versions by the evaluation instant.** A decision
  re-derived at a past instant uses the rows in force now; the version id on
  the historical trace is what stays explainable.
- **It has no ordering of events.** It evaluates a set of hazards at an
  instant; "which came first" (R06's race) is not representable.
- **It has no permit object.** Completeness, credential, equipment, ITP,
  evidence and temporal gates (R01, R08, R11, R12, R16, R18, R19, R21, R23)
  have no seam: `wadl-domain`'s permit typestate exists and no route creates
  a permit.
- **It has no override.** No route waives or approves past a state; R15 and
  R20 are true by absence, not by a check.

## 2. The seed audited against the table

Twenty rows in `handoff/01-rule-table.csv` (R02, R05 and R10 do not exist;
the charter's "21" counts the header). Nine seeded entries cover R03 (two),
R04, R06, R07 (two), R09, R13, R22. Version ids are the deterministic seed
ids (`0x0300`…); real versions are minted at authoring.

### 2.1 Seeded rows

| Row | The table says | The seed does (`rules.rs`) | Verdict |
|---|---|---|---|
| R03 same-space (`…0300`) | no hop-0 row; hop depth 1 | `coating_open`, `SameSpace`, BLOCK, marine chemist, hold 480 min | **Addition.** The coated space itself is refused; without it the origin of a cascade reads ALLOW. Confirm or strike. |
| R03 coupled (`…0301`) | BLOCK; ventilation (source→sink) + shared boundary; hop 1; marine chemist; cleared when ticket closed and atmosphere re-tested | `coating_open`, `deck_penetration` 1 hop, BLOCK, marine chemist, hold 480 min | **Narrower and differently routed.** The seed walks the derived vertical penetration (heat path), not a ventilation edge; nothing BLOCKs along `exhaust_trunk` from a coating (R09 SUSPENDs there). The 480-minute cure is the seed's number; the table gives none. Clearing is priced on a clock; the table's clearing is a re-test. |
| R04 (`…0401`) | SUSPEND; structural, vertical, downward; hop 1; fire watch / fire marshal; cleared when hot work complete **and** post-work fire watch elapsed | `hot_work_live`, `deck_penetration` 1 hop, SUSPEND, fire marshal, hold 30 min | **Matches at the narrower reading on reach and direction** (derived penetrations run downward). **Does not match on clearing:** `earliest_clear = since + 30 min`, so the deck below reads clear thirty minutes after the permit was *raised*, while the torch may still be lit; the engine has no "hot work complete" event. The 30 is the seed's number. Verify on the reference hull: a `hot_work_live` row raised more than thirty minutes before the instant no longer suspends the deck below. |
| R06 (`…0601`) | SUSPEND; ventilation (directional); hops 1–3; trigger: a coating opens in a space coupled to an **already active** hot-work permit; marine chemist + engine re-check | `coating_open`, `shared_bulkhead` 1 hop, **WARN**, marine chemist, hold 480 min | **Contradiction (1 of 2).** State WARN against the table's SUSPEND; bulkhead against ventilation; one hop against 1–3; and the trigger is any open coating, not the race the table describes, which the engine cannot express. The seed's row is the prototype's "boundary posted, no ignition source carried across" bulkhead case, which the table has no row for. |
| R07 same-space (`…0700`) | BLOCK; electrical (bus topology, bidirectional); hops 1–2; isolation authority | `energised_bus`, `SameSpace`, BLOCK, isolation authority, no hold | **Matches** the rule's own wording ("inside an electrical envelope"). |
| R07 coupled (`…0701`) | as above | `energised_bus`, `electrical_bus` 1 hop, BLOCK, isolation authority, no hold | **Narrower reading** (one hop, pending the two-switchboards question). **Direction is the register's, not the rule's:** the table says bidirectional; every `electrical_bus` row in `reference/cvn73/CVN73-couplings.csv` is authored one-way (`symmetric` = no). The yard's coupling register decides this, not the rule. |
| R09 (`…0901`) | **WARN**; ventilation (directional); hops 1–2; marine chemist; open question: which work classes stay permitted under WARN | `coating_open`, `exhaust_trunk` 2 hops, **SUSPEND**, marine chemist, hold 480 min | **Contradiction (2 of 2).** SUSPEND against the table's WARN. The seed comment gives the reason ("resumes when the zone clears"); the table's WARN presumes work classes the engine cannot see until S13/S14. |
| R13 (`…1301`) | BLOCK; ventilation (directional) + gas path; hops 1–2; marine chemist / fire marshal; cleared when stow secured or vent boundary isolated | `flammable_stow`, `exhaust_trunk` 2 hops, BLOCK, fire marshal, no hold | **Matches on reach and state.** Clearer narrowed to the fire marshal; "gas path" has no coupling code in the register. |
| R22 (`…2201`) | SUSPEND; any; hop 0; the issuing authority | `stop_work`, `SameSpace`, SUSPEND, issuing authority, no hold | **Matches.** |

Two facts about the reference hull the audit turns up, which the yard's
register must not repeat: `exhaust_trunk` has two authored rows on the whole
hull, so R09 and R13 fire almost nowhere; and every bus edge is one-way.
Ventilation branches and bus topology are the yard's data (checklist Y2 in
`docs/pilot-playbook.md`).

### 2.2 Rows not seeded, and why

| Rows | Kind in the table | Why there is no entry |
|---|---|---|
| R01, R18 | completeness gates | mechanical checks on a permit request; no permit object in the pilot |
| R08, R11 | credential and equipment gates | no credential or equipment registry is read |
| R12, R21 | ITP gates | no ITP or disposition object |
| R14 | governance (crew challenge to a derived adjacency) | a coupling-register change through the door, signed; the challenge itself is a process, not a rule |
| R15, R20 | governance (waiver; approval past a live block) | coded as absences: every entry `waivable: false`, no override route |
| R16 | temporal gate (shift boundary) | the shift boundary is the yard clock's (S10); a permit end is a permit's |
| R17 | isolation invalidated mid-permit | representable only as a new `energised_bus` hazard, which fires R07 (BLOCK) not R17 (SUSPEND); the distinction needs a live cold-work permit to exist |
| R19, R23 | evidence gates | no evidence object |

Confirming these are out of the pilot is itself a decision (§4, D12).

## 3. Open questions

The README (§5) names five as milestone 1's undecided seams and the seed
leaves each at its narrower reading:

- **R03** — does a mechanically isolated branch break the coupling, or only a
  physical blank?
- **R06** — on a race, is the later ticket refused or the earlier permit
  suspended?
- **R07** — does a coupled bus two switchboards away need isolation, or
  notification?
- **R08/R11** — is a credential or bottle expiring mid-window a refusal at
  request time, or a scheduled mid-shift action?
- **R15/R20** — which rules are waivable, and may any persona override a live
  BLOCK? (Assumed: hazard cascades are not waivable; no override.)

The seed's own comments carry one more the README omits: **R04** — does the
downward coupling extend two decks where a deck penetration exists? (Left
at one hop, `rules.rs:195`.) And the table carries an open question on
every row but R01 and R18: R09's permitted work classes under WARN, R12's
predecessor hold points, R13's closed-but-unsecured stow, R14's owner of a
correction, R16's split, R17's re-verification, R19's two-person
attestation, R21's re-arming on REJECT, R22's QA stop-work authority, R23's
witness level. Grouped by what an answer changes:

| Group | Questions | An answer becomes |
|---|---|---|
| Engine-shaped: answerable by a row or a coupling attribute | R03 isolated branch, R04 two decks, R07 two switchboards, R09 work classes, R13 secured stow | a rule row (hops, state), or a column the coupling register must carry (`isolated`, `blanked`) |
| Workflow-shaped: need a permit, credential, ITP or evidence object | R06 race, R08/R11, R12, R14 process, R16, R17, R19, R21, R23 | out of the pilot; a backlog row and a stated interim practice on paper |
| Policy | R15/R20, R22 QA authority | a signed statement; R22 becomes a clearing-authority string |

## 4. Decisions the authority must make at the sitting

Each with the default in force if the sitting does not decide it. A decision
is recorded as a rule row (through the rule door once S14 lands; in the
sign-off table meanwhile) or as a signed statement; never as a code change.

| # | Decision | Default until decided |
|---|---|---|
| D1 | R06 and R09 outcomes: WARN or SUSPEND for each, and along which coupling codes and hop counts | the seed: R06 WARN on `shared_bulkhead` 1 hop; R09 SUSPEND on `exhaust_trunk` 2 hops |
| D2 | R03's reach: does an open coating BLOCK the decks above and below (as seeded), the bulkhead neighbours, the ventilation branch, or a set of those; and does the coated space itself stay BLOCK | the seed: same-space BLOCK, `deck_penetration` 1 hop BLOCK |
| D3 | The two numbers the table leaves blank: the coating cure period and the post-work fire-watch hold; and whether a hot-work SUSPEND may clear on a clock at all or only when the permit is closed (a `HAZARD_CLEARED` row) | 480 and 30 minutes; the clock clears both (§2.1 R04 finding) |
| D4 | Hop depths: R04 two decks through a penetration; R07 two switchboards | one hop each |
| D5 | R03's isolated branch: what the coupling register must say about a branch for it to stop carrying a hazard (an attribute the register does not have) | no attribute; every authored edge carries |
| D6 | Which work types each row binds to (R09's WARN presumes some work is still permitted); the work-type vocabulary the field map will carry (S13) and S14 binds on | none: every row applies to every activity |
| D7 | R13: is a closed but unsecured stow secured; who clears (marine chemist, fire marshal, either) | seed: fire marshal; any open stow carries |
| D8 | R22: does QA hold stop-work authority, or only the fire marshal | either, as `issuing_authority` |
| D9 | R15/R20: confirm no row is waivable and no persona overrides a live BLOCK | as coded: none |
| D10 | The clearing-authority names as the yard uses them, and which pilot persons hold `clear_hazard` for each (S12's matrix: Safety and Ship Super) | the code strings; the matrix as designed |
| D11 | Whether the pilot runs on the authored table through the rule door (S14) or on the signed hot-work-only fallback (§6) | the seed, unrestricted |
| D12 | Confirm the thirteen unseeded rows are out of the pilot and state the paper practice for each | out; nothing stated |

## 5. The golden trace they sign

A golden trace is the engine's full `Decision` for one scenario at one fixed
instant, stored as an `insta` snapshot and asserted by a test that fails on
any byte of change (`crates/wadl-engine/tests/golden_cascade.rs`; the six
snapshots in `crates/wadl-engine/tests/snapshots/`). One contains the
governing state, and for every rule that fired: rule code, version id,
state, source space, hazard label, depth, path, the coupling codes
traversed, authority, clearing authority, `earliest_clear`, and the
sentence the field app shows. The existing six pin the prototype's coating
cascade around 3-160-2-Q: the coated space blocks, the decks above and
below block, the bulkhead neighbour warns, the trunk suspends two hops out,
an uncoupled space is allowed.

For the sitting, one trace per row in force, on the yard's own register:

1. **Scenario.** A hazard of the row's kind at a named origin space, the
   subject spaces the row should and should not reach, and the instant
   (before and after the hold, where the row has one).
2. **Expectation.** The state per subject, the clearing authority, the
   earliest clear, written by the authority before the engine runs.
3. **Run.** The engine produces the trace; the snapshot is committed.
4. **Sign.** A row in the sign-off table: rule code, version id, scenario,
   snapshot path, the signer's person id (the `x-wadl-person` the proxy
   asserts for them), and the yard's ledger seq of the rule-door commit once
   S14 lands.

A change afterwards is a **new rule version** with an effective range; the
old snapshot stays and keeps verifying against the old version, the new one
gets its own. `cargo insta review` shows the authority exactly what changed
between the two. Nothing in a signed snapshot is edited.

The sign-off table lives in this file's companion
`docs/briefs/rule-signoff.md` once the sitting produces rows; until then
there are no signatures to record and this section is the procedure.

## 6. What happens by default until they sign

- **Both stores serve the seed.** `rules_in_force` returns
  `RuleSet::seed_usn_hot_work()` in memory and the rows `wadl seed` wrote
  from it on PostgreSQL. Every decision's trace carries the seed's version
  id, so a decision made under the seed stays explainable after the table
  replaces it.
- **Every row applies to every activity** regardless of work type, until
  S14 binds by the field map's work type. Cold work in a coated space's
  neighbourhood is refused as hot work would be. Planners should read a
  refusal of non-hot work as "the rule is broader than the yard's" and say
  so in the weekly triage (`docs/pilot-playbook.md` §4.2); it becomes a
  document change at the sitting, not a code change.
- **The signed hot-work-only fallback** (the review's B11 minimum) is the
  text below, ready for signature if the sitting slips. It takes effect
  when S14 lands, because restricting evaluation by work type is S14's
  binding; before that it is a statement of intent on file and the seed
  runs unrestricted.

> Until the yard's rule table is authored through the rule door, the
> development seed (nine entries, versions `…0300`, `…0301`, `…0401`,
> `…0601`, `…0700`, `…0701`, `…0901`, `…1301`, `…2201`) is in force as
> transcribed, with the two departures from `handoff/01-rule-table.csv`
> (R06 WARN, R09 SUSPEND) acknowledged. Evaluation binds these rows to
> activities whose work type is hot work; activities of any other work type
> receive ALLOW with a trace line stating that no rule is in force for the
> work type. Every clearance is recorded with its basis under a person.
> Signed by the safety authority's representative (person id) and the
> pilot's yard lead (person id).

- **The two contradictions stand as seeded** until D1 is decided; the
  pilot record notes them on day one so nobody discovers them from a trace.

## 7. What each side brings

We bring: the twenty rows and the nine entries side by side (§2), the
reference hull's coupling counts, the six existing snapshots printed, the
engine's five hazard kinds and four coupling codes, the S12 matrix (who may
clear), the S13 field-map slots (where a work type would come from), and
the fallback text.

The authority brings: the values for the two blank anchors, the answers to
D1–D12 or the decision to defer each, the names of the clearing authorities
and the people who hold them, the yard's own ventilation and bus topology
convention (or the person who owns the coupling register), and the person
who will sign the traces.

The sitting ends with a decision recorded against every row of §4, even if
the decision is "default stands".

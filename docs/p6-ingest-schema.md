# The P6 ingest schema

What a Primavera P6 export actually contains, which parts of it the platform
takes, and what each one is worth. Sample export: `reference/p6-sample/CVN73-PIA26.xer`.
Landing tables: `migrations/0009_schedule_of_record.sql`.

This sits one level below `handoff/03-p6-field-crosswalk.csv`. That file is the
conversation to have with a planner — *is compartment a code or a UDF?* This one
is the answer written down as tables and columns, for the case where the answer is
"the good one". Where the good answer is not available, the fallback is named.

## Why three layers, not one

```
  P6 .xer export
        │  ingest, verbatim
        ▼
  p6_activity · p6_relationship        what the scheduler's file SAYS
        │  a planner maps it
        ▼
  work_order.planned_{start,finish}    what WADL WORKS TO
  work_segment_space.planned_*
        │  read at an instant
        ▼
  Readiness · deck states · the time control
```

The middle layer is the whole point. A schedule import that wrote straight into
`work_order` would make the scheduler's file the authority on which compartments
are held — and P6 does not know about hazards, coupling, or authorization. It
knows when somebody intends to be somewhere. Keeping the import verbatim and
requiring a mapping step means three things stay true:

1. **When the board and the schedule disagree, the argument is settled by
   reading.** `p6_activity` holds what was imported, not a transform of it.
2. **Unmapped scheduled work is visible.** `work_order_id IS NULL` on an ingested
   activity is a partial index, not an oversight: work in the schedule that the
   product cannot see is exactly the gap a planner needs on a list.
3. **A re-baseline does not silently move authorization.** Re-ingest writes new
   `p6_activity` rows under a new `run_id`; what WADL works to changes when
   somebody accepts the change.

This is the same discipline `source_verified` already applies to provenance.
Ingested is not confirmed.

## The XER format

P6's native export is tab-delimited with a table-per-section header:

```
ERMHDR  19.12  2026-08-10  Project  admin  A.PLANNER  Shipyard Planning  USD
%T  TASK                        ← table name
%F  task_id  task_code  ...     ← field names, in row order
%R  880111   A4020     ...      ← one row
%E                              ← end of file
```

Two consequences for a parser, both learned the hard way by everyone who writes
one:

- **`%F` order is not stable across P6 versions or export layouts.** Field
  positions must be resolved by name from the `%F` line of each section, never
  hard-coded. A parser that indexes by position works until the first upgrade and
  then silently reads the wrong column.
- **Empty is not null.** XER writes empty strings for absent dates, and some
  exports write a single space (visible in the sample's `cstr_type` column).
  Trim, then treat empty as absent.

## The sections that matter

| XER table | What it is | WADL takes |
|---|---|---|
| `PROJECT` | One row per project | Hull + availability identity, plan bounds |
| `PROJWBS` | WBS hierarchy | `wbs_path`, and the zone/system rollup |
| `TASK` | Activities | Everything dated |
| `TASKPRED` | Relationships | `p6_relationship` — sequence logic |
| `TASKRSRC` | Resource assignments | Man-hours, and often the trade |
| `RSRC` | The resource dictionary | Trade names |
| `UDFTYPE` / `UDFVALUE` | User-defined fields | Compartment, WI number, work class |
| `CALENDAR` | Working time | Shift structure (not yet consumed) |

## Field mapping

### The field map — the yard's conventions as data

A yard's P6 does not name its fields the way the sample does. Rather than a
code change per yard, the conventions are a per-hull document, kind
`p6_field_map` (`wadl_ingest::field_map::FieldMap`,
`reference/cvn73/CVN73-fieldmap.json`, loaded by `WADL_DEMO_DOCS`):

```json
{ "compartment": { "source": "udf", "name": "compartment" },
  "work_item":   { "source": "udf", "name": "wi_number" },
  "work_type":   { "source": "none" },
  "trade":       { "source": "resource" },
  "projects": [],
  "placards_from_names": true }
```

`source` is `udf` (`UDFTYPE.udf_type_name` or `udf_type_label`, trimmed,
case-insensitive — a label-only match is a finding), `activity_code`
(`ACTVTYPE.actv_code_type` → `ACTVCODE.short_name` via `TASKACTV`),
`resource` (trade only: the first labor `TASKRSRC` → `RSRC.rsrc_short_name`)
or `none`. `projects` names the `proj_short_name`s to serve; empty is every
project. The default above **is** the pre-map behaviour, so a hull with no
map keeps working. The map is refused whole for a `resource` outside the
trade, a blank name or a duplicate project; a named field the served export
does not carry is a finding, never a refusal.

The map is chosen where the file is: the door's dry run returns
`fields_seen` — every UDF with its row count, every activity code type,
resource and task types, section counts, no schedule content — and the
Data Sources card builds its selects from it. Every change re-runs the dry
run, so the located count moves before anything is stored. A map that
differs from the stored one is committed with the run, as its own ledgered
document. `wadl ingest-xer --input f.xer --survey` prints the same survey
for a yard to mail back.

### Encoding

P6 on Windows writes Windows-1252 by default. The door reads the bytes in
the browser — strict UTF-8 first (a byte-order mark stripped), Windows-1252
when that fails — and the body carries `encoding` so the run records which
branch was taken and that the browser took it (`decoded_by: browser`). The
boot loader and the CLI take the same two branches on the server
(`wadl_ingest::encoding::decode_xer`, a hand-rolled 128-entry WHATWG table,
no decoder crate). One shared literal pins both decoders: bytes
`93 94 E9 96 80` are `“ ” é – €`. UTF-16 exports would need a third branch.

### Quarantine, exclusion, and what refuses the file

The parser already rejected rows it could not read; the door used to refuse
the whole file on the first one. Now a row that cannot be honestly accepted
is **quarantined** with its 1-based line, table, code, class and reason —
classes `unparseable_date`, `backwards_window`, `unknown_status`, `no_code`,
`no_name`, `width`, `cross_project_logic`, `unknown_task_in_logic`,
`structure` — and the rest of the file is served. The quarantine is in the
preview, on the card (folded at 25, the count always said), in the run and
in the `SCHEDULE_REPLACED` ledger line. The file is refused whole (422) only
when there is no `TASK` section, when no activity survives, when the
parser's cell ceiling is hit, or when an inline map is malformed.

Three kinds of row are **excluded and listed**, not quarantined: `TT_LOE`
(level of effort is not work), `TT_WBS` (a summary row), and every row in a
project the map does not serve — with a relationship that crosses into an
excluded project quarantined as `cross_project_logic`. `TT_FinMile` is a key
event beside `TT_Mile`.

### Runs

Every commit is a run (`ingest_run`, 0008, finally has its writer:
`0018_schedule_runs_and_field_map.sql`): the label, the encoding and who
decoded, the map used, the counts, the quarantine and the exclusions, the
person and the door (`door`, `boot`, `cli`), and the served document itself.
`/timeframe` and `/activities` carry the served run's summary and the shell's
breadcrumb reads it — *reading CVN73-PIA26-full.xer · imported 09/04 06:12 by
…*. Any two runs diff in the door's delta shape; any prior run can be served
again (`POST /schedule-runs/serve`), ledgered `SCHEDULE_REPLACED` with
`reverted_to_run: true` — a revert to a prior import, not a re-parse.
Activity ids are stable from `(hull, task_code)` so an open inspector survives
a re-baseline. The in-memory store keeps the rows of the newest 12 runs;
PostgreSQL keeps every run.

### Dates — the part the time dimension needs

P6 carries **three** date pairs per activity and they mean different things. Using
the wrong one is the most common way a schedule import produces a plausible,
wrong answer:

| XER column | P6 name | Meaning | WADL |
|---|---|---|---|
| `target_start_date` / `target_end_date` | Planned / Budgeted | The **baseline**. Does not move as the job slips. | evidence only |
| `early_start_date` / `early_end_date` | Early Start / Finish | The **CPM forward pass** — the current plan. | **this pair** |
| `act_start_date` / `act_end_date` | Actual | What happened. Populated as work starts and finishes. | overrides, below |

What WADL works to, per activity:

```
planned_start  = COALESCE(act_start,  early_start)
planned_finish = COALESCE(act_finish, early_finish)
```

Actuals win where they exist, because a space is occupied when the crew is
actually in it, not when the plan said they would be. An activity that started
two days late and is still running has an actual start and no actual finish, so
the window is "began then, still open" — which is the truth.

`target_*` is deliberately **not** the source. It is the baseline, it does not
move, and importing it produces a board that is confidently a month stale. It is
ingested anyway, because baseline-versus-current is the variance a planner wants.

The window is half-open `[start, finish)`, matching `wadl_domain::time::Window`.
P6's finish is the instant work ends, so it maps onto the exclusive bound with no
fencepost arithmetic — unlike `availability.end_on`, a `date` naming the last day
inclusive, which needs `+ INTERVAL '1 day'` (a bug this repo has already had).

### Compartment — the dominant risk

The engine is compartment-scoped, so this field decides whether any of it works,
and P6 has no native concept of it. In descending order of trustworthiness:

| Where it lives | Grade | Notes |
|---|---|---|
| A dedicated UDF, controlled format | `high` | The sample's `UDFTYPE 501`. Ask for it. Field map `{ "source": "udf", "name": … }` — by name or label, whatever the yard called it. |
| An activity code with a compartment dimension | `medium` | Confirm the code dictionary, not the manual. Field map `{ "source": "activity_code", "name": … }`. |
| A WBS level that happens to be compartments | `medium` | Usually only true for some branches. No field-map source yet; `wbs_area` is the zone hint. |
| Parsed out of `task_name` | `low` | For a pilot only. |
| Absent | `low`, value `NULL` | Say so. Do not guess. |

`p6_activity.compartment_reliability` carries the grade per row, and it is not
decoration: a `low` compartment must not be presented as an authored position,
for the same reason the Deck Explorer labels a parsed frame `parsed` rather than
`register`. **Never parse free text in production.** For a pilot, a manual mapping
table maintained by the planner beats a regex that is right 90% of the time,
because the 10% is invisible and lands on a deck plan looking identical.

The sample deliberately omits the compartment UDF on one activity (`A4040`,
`task_id` 880113) so an ingest run against it exercises the absent case rather
than only the happy path. The validator fails if that gap is ever filled in.

### Man-hours

`TASKRSRC.target_qty` summed per activity **over labor assignments only**
(`RSRC.rsrc_type = RT_Labor`), with `remain_qty` for what is left. Material
and equipment assignments are counted and set aside (`material_skipped`,
`equipment_skipped` on the run) — a staging pallet is not in anyone's
man-hours; a resource with no `rsrc_type` is counted as labor with a
finding. Loaded late in many yards — the crosswalk grades this `medium` — so an activity
with dates and no hours is normal, not an error. Fall back to duration × crew
size and **flag it as derived**; an estimate that cannot be told apart from a
loaded figure will end up in a stranded-hours number that gets read aloud.

### Trade

`TASKRSRC.rsrc_id` → `RSRC.rsrc_short_name` of the first labor assignment,
where resources are modelled per trade (field map `trade: { "source":
"resource" }`, the default). Where they are modelled per crew or only loaded
on cost-significant activities, point the map at a UDF or an activity code
instead and confirm the convention. The sample models it the good way
(`SM-PRES`, `SM-ELEC`, …).

### WBS

`PROJWBS` is a parent-pointer tree; `wbs_path` is it flattened root-first. The
structure is reliable, **the semantics are not** — which level is zone, which is
system, and which is work package differs per yard and usually differs from the
WBS dictionary. Ask for the dictionary *and* a sample export, and reconcile them.
The sample encodes zone at level 2 (`Z6`) and system at level 3 (`512`).

### Relationships, and the two kinds of finding they carry

`TASKPRED` gives `pred_type` (`PR_FS`, `PR_SS`, `PR_FF`, `PR_SF`) and
`lag_hr_cnt`. Beyond the topology itself, importing it surfaces three things —
and the first two are **not** the same kind of problem, which is worth being
precise about because they are found by different parts of the system.

- **Schedule-logic violations**, which P6 can find itself. The dates contradict
  the stated relationship. The sample carries one: `A5020 → A4050`, a
  finish-to-start link with no lag where the HVAC riser is scheduled to start a
  week *before* the cableway sharing that overhead finishes terminating. P6's own
  out-of-sequence report would flag this.
- **Conforming plans the engine must still refuse**, which P6 *cannot* find. A
  negative lag legitimately permits a successor to start before its predecessor
  finishes, so the arithmetic checks out and no scheduling tool objects. The
  sample's relationship `990011` carries `lag_hr_cnt = -8`, pulling the switchgear
  penetration into the coating cure it depends on to save a shift. Nothing about
  that is a date error — it is a rule outcome, and only a compartment-scoped
  hazard engine sees it. This is the more valuable of the two fixtures, and the
  clearest single statement of what this platform is for.
- **Constraint density.** `TASK.cstr_type` (`CS_MSO`, `CS_MEO`, …) pinning dates
  in place of logic means the schedule cannot be reasoned about as a network.
  Count it and report it as a data-quality metric — the sample carries three,
  including one on `A3010`, the activity two others wait on.

`scripts/validate-p6-sample.py` asserts both fixtures are still what they claim.
A sample that quietly loses a test case is worse than one that never had it,
because the file still looks like it covers the ground.

## Where the demo differs, and why

The in-memory demo seed expresses its schedule as **offsets from an anchor** and
anchors on the clock, so the story is current whenever somebody opens the app —
the coat is always three hours into its cure. A real ingest brings real fixed
dates, and `now` falls wherever it falls. The sample export is fixed-date for
that reason: it is what an import looks like, not what the demo does.

The sample's activities are dated to reproduce the demo hull's shape around
2026-08-10 — six work orders, the HVAC and cableway package footprints, and the
coating activity `A6010` running 03:00–11:00 so an import at mid-morning lands
mid-cure.

Run `python3 scripts/validate-p6-sample.py` after editing it. It checks
referential integrity across sections, that status agrees with the actual dates,
that budgeted units reconcile with earned plus remaining, and that finish-to-start
logic is satisfied by the dates. Writing it caught two genuine defects in the
first draft of this sample — an activity marked not-started carrying 180 earned
hours, and a cableway relationship modelled finish-to-start whose own dates
overlapped by 58 hours — and one error in this document's first draft, which
described the negative lag as a logic violation when P6's arithmetic in fact
permits it.

## Not yet consumed

- **`CALENDAR`** — shift structure. The `Shift` horizon currently steps by a
  clock hour; a yard on a 2-shift 6-day calendar has non-working time the
  scrubber walks straight through as though work were happening.
- **`phys_complete_pct`** — physical, duration-based and units-based percent
  complete give different answers, so `status_code` is used and percent complete
  is advisory (crosswalk's position, kept).
- **Multiple hulls in one project** — the field map serves one or more
  projects per hull (the other way round), and says *N projects in this
  export* when no project is named. One project spanning several hulls still
  needs a mapping table before anything is trusted.
- **Baseline variance** — `target_*` is stored but nothing reads it yet.

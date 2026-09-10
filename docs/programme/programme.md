# The pilot programme — order, numbers, contracts

The integration decisions for the slices designed in this directory. A
builder reads `implementer-contract.md`, then its slice's packet, then this
file for anything the packet leaves to "programme.md".

## How the work runs

One builder at a time on the main branch (four CPUs; no parallel builds).
Design packets are written before a slice is built; for the slices that do
not yet have a packet (S14 onward) the builder writes the packet as the first
hour of its sitting, commits it, then builds against it. Every sitting ends
with the gate green and the branch pushed; every green build state in between
is a pushed checkpoint, because a sitting can be cut off without notice.

## Waves

| Wave | Slices, in order | Why this order |
|---|---|---|
| 1 · The production path | S10 (yard clock, server then shell) → S12 (person in the ledger) → S13 (XER survival + run history) | The three pilot blockers a yard notices in week one: the shift board is on the wrong clock, the ledger names nobody, the real export imports badly. S10 first because S13 and S11 both parse and render through its clock. S12 before S13 so the run history is written under a person from its first row. |
| 2 · The morning meeting | S11 (Tomorrow + Week) → S15 (run it in production) → S16 (PostgreSQL proof in CI) | S11 is the demo's centrepiece and needs only S10. S15 and S16 are the ops and evidence the ISSO conversation opens with; they touch little product code and can follow a docs agent in the second slot. |
| 3 · The yard's rules | S14 (rules the yard will sign) → S18 (conflict issues from the engine) → S19 (adjudication completeness) | S14 needs the work type S13 carries; S18 needs S14's bindings; S19 needs S12's person. Built in the pilot's own order of need. |
| 4 · Proof and polish | S17 (Playwright smoke, cold walkthrough, handlers.rs split) → S20 (vocabulary and onboarding) → S21 (pilot playbook and ATO package) | S17 runs over everything above it. S20 and S21 are mostly documents and can run alongside S17 in the second slot. |

## Migration numbers

| File | Slice |
|---|---|
| `0016_yard_clock_document.sql` | S10 |
| `0017_ledger_actor.sql` | S12 |
| `0018_schedule_runs_and_field_map.sql` | S13 |
| `0019_rule_table_document.sql` | S14 (if the packet needs one) |
| `0020_trade_taxonomy_and_conflict_issues.sql` | S18 (if needed) |
| `0021_issue_ownership.sql` | S19 (if needed) |

Forward-only. Each migration that widens the `ingested_document` kind CHECK
lists every kind in force at that point, including the ones earlier
migrations in this table added.

## Contract decisions

- **The yard clock (S10 ↔ S11 ↔ S13).** The clock is served inside
  `GET /timeframe` as `yard_clock { label, source: "document" | "default_utc", clock }`
  and by its own door at `/yard-clock`. The shell applies it through
  `clock.ts` (`setYardClock`, `currentClock`) and the pure mirror
  `yardClock.ts`; S11 reads shift windows from `reports.ts::shiftChoices`
  and `shiftWindow`, nothing else. S13's `ingest_xer_with(input, label, &FieldMap, &YardClock)`
  supersedes S10's `ingest_xer_in`; S10 lands first and S13 renames.
- **The person (S12 ↔ S19).** `TenantScope` carries `Actor { id, name }`;
  every ledger row written after 0017 is chain format 2 with the actor in the
  hash; `unattributed` is the actor when the proxy asserts none. S19's owner
  field on an issue is a person id from the same header contract, never free
  text.
- **Work type (S13 ↔ S14 ↔ S18).** The field map decides which XER field
  carries the work type; the activity read serves `work_type: string | null`
  from S13 onward. S14 binds rules by that string plus category and an
  effective range; S18's trade taxonomy maps trade codes to the same work-type
  vocabulary and never invents a second one.
- **Run history (S13 ↔ S16).** The served run pointer is the schedule of
  record; S16's PostgreSQL CI job loads the reference hull through the doors
  (the `wadl load-docs` CLI door is part of S16) and therefore creates a run
  row the same way the shell would.
- **Health and version (S15 ↔ S16).** `/health` gains `version { git, built_at, schema }`
  in S15; S16's CI job asserts it.
- **Issues (S18 ↔ S19).** S18 adds issue kinds; S19 adds state, owner and
  due-by to every kind including S18's. S18 must not add its own
  acknowledgement path.
- **`ledger_document` becomes `pub(crate)`** in S10; later slices reuse it.

## Shared conventions (in addition to the implementer contract)

- New API modules: `crates/wadl-api/src/<feature>.rs`, registered in
  `lib.rs`, with routes added to `routes.rs` and leak tests + SSP regenerated.
  Nothing new goes into `handlers.rs`; S13 begins moving the schedule door out
  of it and S17 finishes the split.
- Ledger action names are `UPPER_SNAKE` nouns of what happened
  (`DOCUMENT_REPLACED`, `SCHEDULE_REPLACED`, `ISSUE_ASSIGNED`), with the
  document kind in the entry's detail rather than in the action name.
- A door is `GET` (current document + provenance), `POST` (with `?dry_run=true`
  returning findings and a preview, without it committing and ledgering), and
  `POST …/revert`; refusals are 422 problem+json with every reason; findings
  never refuse.
- The shell's Data Sources card for a door shows the status word
  (`INGESTED`, `DEFAULT`, `SEEDED`), the label, the provenance and the last
  ledger entry, and stages a dry run before every commit.
- Every new figure names its layer in its tooltip or its column header:
  "schedule of record", "engine", "shell estimate".
- Tests that pin instants from the sample XER quote the wall-clock string
  they came from, so a clock change is a one-line update with a reason.

## File ownership

| Path | Owner | Rule for later slices |
|---|---|---|
| `crates/wadl-domain/src/civil.rs`, `shell-web/src/yardClock.ts` | S10 | Extend with tests against the shared vector file; never fork a second clock. |
| `crates/wadl-api/src/auth.rs`, `roles.rs`, `docs/identity-proxy-contract.md` | S12 | Capabilities are added to the matrix in `roles.rs`, not checked ad hoc in handlers. |
| `crates/wadl-ingest/src/{field_map,encoding}.rs`, `crates/wadl-api/src/schedule_door.rs` | S13 | The XER parse has one entry point; new fields go through the field map. |
| `crates/wadl-engine/src/rules.rs` | S14 | Rule semantics change only with a golden trace per row. |
| `shell-web/src/{clock,watch,reports}.ts`, `TimeControl.tsx` | S10 | S11 consumes; it does not restyle the transport bar. |
| `shell-web/src/DailyOps.tsx` | S10 then S11 | S11 adds Tomorrow beside "This instant"; the shift chips stay S10's. |

## Cuts and deferrals

- Per-trade or per-zone calendars, holidays (S10): after the pilot.
- Ledger chain v3 or an external timestamping authority (S12): after the
  pilot; v2 with the actor in the hash is what the ISSO asked for.
- Run-to-run diff of resource assignments (S13): after the pilot; the diff is
  at activity grain.
- A 3,000-space scale test (B9) is folded into S17's evidence bundle rather
  than its own slice; the reference hull already exercises the indexed paths.
- The WADL operator CLI beyond `load-docs` and `support-bundle` stays out of
  the pilot.

## The two conversations to open now

They gate S12 and S14 and are prepared in `charter.md`: the proxy owner's
header contract and the safety authority's rule-table sitting. The code
ships with defaults (`unattributed`, the seed rule set audited against the
table) so neither blocks the demo, and each answer replaces a default through
a document.

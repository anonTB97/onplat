# Programme charter — from demoable to pilot-ready to ATO

Date 2026-09-04 · head `9509187` · branch `claude/kickoff-from-docs-arhiib`.
Companion to `docs/pilot-readiness-review.md` (barriers B1–B13, H1–H10),
`docs/execution-plan.md` (slices 1–9 landed), `docs/production-posture.md`,
`docs/ssp-input.md`, `docs/poam.md`, and `docs/programme/implementer-contract.md`.
`programme.md` fixes slice order, migration numbers and shared contracts; this
charter fixes what "done" means, the steps a team would take, how one AI
session takes each step without dropping the check it exists for, and what
only the yard can supply.

## Summary

The pilot is one MRO hull at one US yard, 5–15 named planners and
superintendents, eight weeks, PostgreSQL behind the yard's identity proxy.
Slices 1–9 retired B1, B2, B3, B7, B8, most of B12, and the ledgering half of
H5; the build is demoable end to end on the reference hull. What remains
pilot-blocking is B4 (survive the yard's XER), B5 (a person on every ledger
row), B6 (the yard's clock), B9 (measured at 3,000 spaces), B10 (the API
suite on PostgreSQL), B11 (rules the yard signs), B13 (run it in production),
plus the pilot-proof subset of H6/H9 and the vocabulary residue of H2. That
is about 19 engineer-weeks by the review's costing, eight calendar weeks for
three engineers, and roughly nine one-agent sittings of two to four hours
each plus the review passes around them. The calendar is set by the yard's
inputs, not by the build: the first yard meeting decides B4, B5, B6, B11 and
the ATO vehicle, and it should happen before the third slice lands.

## What already exists

- **Doors** for register, couplings, zones, geometry, hazard log, manning
  book, budget book, schedule of record: dry run, findings, commit, revert,
  every commit and revert ledgered on both stores (`documents.rs`,
  `SourcesBoard.tsx`). The reference hull boots through them
  (`WADL_DEMO_DOCS`).
- **Trust**: cleared hazards stay in the past; cascade never re-emits the
  origin; empty `WADL_PROXY_KEY` refuses to boot; unknown `/api` paths 404;
  failed reads render "unavailable"; `/health` asks the store and reports
  migration and document schema versions.
- **Time**: one server-owned instant, `as_of` on every evaluating read,
  projection labelled, transport clamped; hazards read at an instant.
- **Reports**: five dated cuts with layer glyphs, print and CSV.
- **Proposals**: refusal → checked alternative → ledgered proposal →
  change-request CSV → next XER dry run reports it reflected.
- **Posture**: RLS on every tenant table proved on live PostgreSQL
  (`pg_rls`); 49 generated leak tests; `gen-ssp --check`; `cargo-deny`; SPDX
  SBOM; air-gap build; reproducible-build job; `self-assessment.sh`
  WADL-SA-01..10 run in CI; hardened unit file; `verify-ledger`; chain
  verified on every ledger read; `support-bundle`.
- **Gaps carried forward** (evidence in the review): XER UDF names are
  literals (`xer.rs:403`); one bad row refuses the file; UTF-8 only; ledger
  `by_person` NULL; shell clock Zulu; rules 7 of 21 rows bound by class only;
  API suite in-memory only; no backup/restore/release procedure; README
  status section describes milestone 1.

## Scope

1. The remaining pilot-blocking slices, each designed as its own packet in
   this directory (proposed ids; `programme.md` is authoritative):
   S10 yard clock (B6) · S11 XER survival and run history (B4, H4-minimum) ·
   S12 person in the ledger (B5) · S13 rule-set door and authority sitting
   (B11) · S14 PostgreSQL proof and CLI data load (B10) · S15 engine at
   3,000 spaces (B9) · S16 run it: backup, restore, release, runbook, request
   id (B13) · S17 pilot proof: Playwright smoke, cold walkthrough, doc
   reconciliation, evidence bundle (H6, H9) · S18 yard words residue (H2:
   trace sentence, authority and coupling display names).
2. The review passes between slices: adversarial critiques
   (`critique-<lens>.md`), the threat-model diff review, QA, docs.
3. The yard-facing preparation: intake packet, data-load rehearsal, training
   material, demo rehearsal, ATO package assembly.

## Out of scope

- H1 conflict issues, H3 Tomorrow/Week views, H5 owner and due-by, H7 fetch
  hygiene, H8 drawing door, H10 kiosk: built during the pilot from planner
  feedback (review §5).
- New construction, `vessel_grant`, live permit feed, P6 write-back, waiver
  workflow, ML: review §8.
- POAM-6 role→capability matrix beyond per-hull assignment: only if the yard
  names duty roles at intake; otherwise all pilot users are planners with
  every door.
- The full SSP as the ISSO files it: the repo produces the input and the
  evidence; system-specific sections need the yard.

## Contracts

The slice packets carry route, document, migration, env, CLI and shell
contracts. Charter-level contracts the packets must honour:

- **Routes** enter `routes.rs` with a sample body; `gen-leak-tests` and
  `gen-ssp` regenerate; errors are problem+json; every read takes `as_of`.
- **Documents** follow the door shape (`documents.rs`): scope check before
  body read, dry run with findings and rejections carrying line numbers,
  all-or-nothing commit, revert, ledger entry on both stores, `schema_version`.
- **Migrations** 0016 onward, forward-only, RLS on every new tenant table,
  policy exercised by `pg_rls.rs`.
- **Env**: new variables documented in `bin/serve.rs`'s header and therefore
  in `gen-ssp` output; unparseable values fall back safe, never open.
- **CLI**: `wadl migrate | seed | verify-ledger | ingest-xer | support-bundle`
  exists; S14 adds `wadl import --kind <register|couplings|zones|geometry|
  hazards|schedule|rules|calendar> --vessel <uuid> --dry-run|--commit` over
  the same door code paths, for the yard data load with a ledger entry.
- **Shell**: new modules registered in `App.tsx` `MODULES` with a Field Guide
  paragraph; failed reads carry fetch state; every figure names its layer;
  yard words only.
- **Dependencies**: none at runtime. One dev-only addition proposed:
  `playwright-core` in `shell-web` devDependencies for S17 (admission test
  point 2: dev/CI only, never in the binary; browsers from
  `/opt/pw-browsers` locally and Playwright's installer in CI). `docker`
  PostgreSQL 16 for local `pg_rls` is already the practice.

## The human-team plan (weeks the review implies, from this head)

| Phase | Weeks | Steps | Exit |
|---|---|---|---|
| Discovery and yard kickoff | 1–2 | Get one real XER, the WBS dictionary, the compartment list, zone chart, shift calendar, one day's tag-out and permit log, the proxy owner's header contract, the ISSO's authorization vehicle; schedule the safety-authority sitting. | Every item in "Needs from the yard" has a named owner and a date. |
| Design reviews | 1–3 | One packet per slice, reviewed by a second engineer; two-week UX design pass with the zone manager and a foreman (ux-gap §7). | Packets approved; vocabulary and shift names signed. |
| Build | 3–8 | S10 clock; S11 XER; S13 rules (after the sitting); S12 identity (after the proxy contract); S14 PG proof; S15 engine; S16 ops. Three engineers, one slice each in flight. | All slices landed, CI green, execution-plan rows updated. |
| QA | 8–9 | Playwright smoke on both stores; second engineer's cold clone-build-run-import-clear walk; dry run with the yard's real XER; tablet check of the shift board. | Cold walk passes from the README alone; the yard's export imports with a quarantine list the scheduler agrees with. |
| Security review | 9 | Threat-model review of the pilot diff against the 800-53 anchors; self-assessment against a proxy-fronted staging; ISSO pre-read of the package. | No FAIL, no WARN on staging; findings in the POA&M. |
| Documentation | 9–10 | Runbook, README reconciliation, SSP regen, POA&M update, one-page "your day" card per role. | Docs say what the code does; `gen-ssp --check` green. |
| Training | 10 | Two half-day sessions, role by role, from `docs/demo-script.md` on the yard's data. | Each named user completes their role's five tasks. |
| Data load with the yard | 10–11 | Register, couplings, zones, geometry, calendar, rule set, hazard log, XER through the doors on the yard's PostgreSQL; findings signed. | No hand SQL; every commit ledgered under a named person. |
| Demo rehearsal, go/no-go | 11 | Scripted walk on the yard's hull in the room, on the wall display. | Go. |
| ATO artifacts | 2–12 (parallel) | Categorization, boundary diagram, PPSM, SSP, SAP/SAR evidence, CM plan, contingency plan, IR procedure, PTA, POA&M, ROB; package handed to the ISSO by week 12. | Package accepted; pilot runs under the vehicle the AO named (an IATT or a change to the enclave's ATO). |
| Pilot | 12–20 | H1, H3, H4, H5, H7 built in flight. | Morning meeting runs off the tool; one conflict a week adjudicated through it. |

About 11 calendar weeks to pilot-ready with three engineers; the review's 12
from its date less what slices 1–9 retired, plus the ATO stream in parallel.
The AO's decision after package submission is on the AO's clock, typically
two to four months, which is why the vehicle question is a week-one item.

## The Claude plan — each step faster, the check kept

One agent at a time on the main tree, 4 CPUs, two-to-four-hour sittings.

| Phase | How a session does it | The check kept |
|---|---|---|
| Discovery | Cannot be done by the session. It prepares: the intake packet (below), an `ingest-xer --report` the yard runs on its own export and mails back (UDF names, encoding, projects, calendars, resource types, row counts; no schedule content), and two synthetic yard-shaped XERs (Windows-1252, other UDF names, multi-project, LOE rows) so S11 is designed against variants, not one sample. | Every unknown maps to a code seam and a question with a default; the yard's answer replaces the default through a document, never a code change. |
| Design review | The packet in `docs/programme/<id>-<title>.md`; then a critic agent with a named lens (security, shipbuilder UX, scale, time-honesty) writes `critique-<lens>.md` and must name what the slice fails and what it would break; the packet is revised before build. | An independent reader argues against the design; the packet is persisted as the review record. |
| Build | Implementer contract: `git status` first, one slice, gates run not assumed, new modules not `handlers.rs`, both stores, ledger, `as_of`, one commit with the execution-plan row. | The lint gate is CI's gate; tests pin every behaviour added; the branch is demoable at every head. |
| QA | S17's Playwright smoke: boot release binary on the reference hull, drive load → scrub → trace → clear → scrub back → ledger verify → import dry run, screenshots per step; run once on the in-memory store and once on PostgreSQL in docker. Then a **cold walkthrough**: a fresh agent with only the README and the demo script, no session memory, performs the walk and files each stop as a defect. | A driver other than the author, on the pilot's store; screenshots a human looks at; the README is the only instruction. |
| Security review | A review agent reads the pilot diff with the threat model (proxy header laundering, key custody, RLS on new tables, body ceilings on new doors, problem bodies, path handling, time-source discipline) and maps each change to AC-3/4, AU-2/9/10, IA-2, SC-5, SI-10/11, CM-7; runs `gen-leak-tests --check`, `gen-ssp --check`, `pg_rls`, `cargo deny`, `self-assessment.sh` with `WADL_PROXY_KEY` set; writes findings into `docs/poam.md`. | Every new route has a leak test, every new table a proved policy, every new env var an SSP line; no claim of Implemented without a verification pointer. |
| Documentation | `gen-ssp`; README status and BACKLOG reconciled to the code; runbook in `deploy/`; Field Guide paragraphs; the packets are the design docs. | `gen-ssp --check` in CI; the cold-walkthrough agent reads only the docs. |
| Training | Produces the per-role one-page card and a recorded rehearsal (screenshots plus narration) from the demo script on the yard's data; the human runs the room. | A person trains people; the session cannot sit in the room and does not claim to. |
| Data load | S14's CLI door rehearsed on the reference hull and the synthetic XERs; on the day, the engineer runs dry runs with the scheduler reading the findings. | Findings signed by a named yard person before commit; every commit ledgered under that person. |
| Demo rehearsal | The Playwright walk on the yard's hull, screenshots reviewed; timings recorded. | A human watches the pictures and gives go/no-go. |
| ATO artifacts | S17's evidence bundle (dated, from CI): SSP input, SBOM, self-assessment output, leak-test list, `pg_rls` log, `cargo-deny` report, test counts, reproducible hash, ledger verify; the session drafts the missing prose artifacts from the code. | The ISSO reviews; the bundle is regenerated, never edited. |

Estimate for the Claude plan: nine build sittings, four critique passes, one
QA sitting, one security-review sitting, one docs sitting, one ATO-drafting
sitting: about seventeen sittings, two to three working weeks of one agent.
The calendar remains the yard's: S11, S12, S13 cannot be finished without
the inputs below.

## What cannot be done without the yard, and how to arrive decisive

| Item | Why only the yard | Preparation so the first meeting settles it |
|---|---|---|
| One real XER export, the WBS dictionary, the activity-code dictionary | B4 is inference from the format and one sample; UDF names, encoding, project structure, calendars, LOE and material resources are the yard's conventions. | The `ingest-xer --report` script; a field-map document format with defaults; the two synthetic variants already imported. |
| The compartment list, deck list, GA drawings | The register is the ship; the reference hull is generated. | Register and geometry CSV shapes documented with a filled sample; the finding list from the door as the acceptance test. |
| The zone chart and zone managers | Zones are the grain the yard runs on; the six-zone scheme is our reasoning. | `docs/zone-scheme.md` and the chart CSV; the adjacency rule stated for them to accept or change. |
| The rule table and its authority | Rules are versioned data the safety authority owns; the seed contradicts the handoff in two rows; five R-questions are open (README §5). | A sitting packet: the 21 rows, the 9 seeded, contradictions marked, the five questions, a golden trace per row as the sign-off; the hot-work-only fallback written for signature if the sitting slips. |
| The identity proxy contract | Header names, the person-id claim, key custody, session timeouts, CAC mapping, the org UUID and assignment source are the proxy owner's. | `deploy/README.md` contract extended with `x-wadl-person` (S12); a curl pairing check; a one-page "what we need from the proxy". |
| Time zone, shift calendar, shift names | Trivial to ask, impossible to guess; every US yard differs. | The shift-calendar document format (S10) with a Norfolk default filled in. |
| A day's tag-out, permit and coating logs | The hazard-log door's CSV is our shape; the loop's live exception (VR-01) is theirs. | Hazard-log CSV documented with a sample day; the mapping from their columns as a field map, not code. |
| PostgreSQL hosting and a DBA | Who runs it, version, backup policy, who applies migrations, who owns `wadl_app`. | The runbook and restore drill (S16); `wadl migrate` idempotent; the one-page host requirements. |
| The ATO vehicle, categorization, marking | IATT versus enclave change, FIPS 199 level, CUI marking (the shell's marking band is a constant), impact level, the ISSO's template. | The evidence bundle and SSP input in hand; a written list of the artifacts we produce and the ones we need their template for. |
| Named users, devices, the room | Roles, tablets, the wall display, the meeting's current spreadsheet. | The role cards; the density mode question; the baseline measure of how the morning meeting runs today. |

## Definition of "fully demoable" (checkable)

1. From a clean clone, `scripts/dev.sh` boots the reference hull and
   `docs/demo-script.md` runs start to finish with no failing step and no
   workaround; `WADL_DEMO=seed` boots the 24-space world and every module
   renders.
2. Every rail module renders on both worlds with no console error; killing
   the API makes every board read "unavailable", never an empty positive.
3. Every visible figure names its layer; every document card shows its
   provenance; every door has dry run, commit and revert; every commit and
   revert is a ledger entry; the chain verify reads clean.
4. Clear a hazard, scrub back an hour, the hold is there; propose to P6,
   export the CSV, re-import an export carrying it, the delta says reflected.
5. The lint gate and CI are green at head; `self-assessment.sh` reports no
   FAIL.
6. A person who has never seen the product gives the demo from the script
   alone (the cold walkthrough), and the S17 Playwright walk reproduces it.

## Definition of "pilot-ready" (checkable)

1. The yard's register, couplings, zones, geometry, shift calendar, rule
   set, hazard log and XER are loaded through the doors on the yard's
   PostgreSQL behind its proxy, with no hand SQL; every dry-run finding list
   was read and signed by a named yard person; every commit is ledgered
   under that person.
2. `/api/whoami` reports `proxy-asserted` with a person id; every ledger row
   since data load names a person; `self-assessment.sh` against the deployed
   instance has no FAIL and no WARN; an empty key refuses to boot.
3. The API test suite is green against PostgreSQL in CI; the shell has been
   driven against the yard's PostgreSQL by a person for the rehearsal.
4. Every clock on screen and in every report is yard-local with the zone
   shown once; the shift board's names and hours are the yard's; a test pins
   XER wall-clock parsing in the yard zone.
5. Rules in force are the safety authority's table through the rule door,
   with a golden trace per row, or the signed hot-work-only fallback.
6. Deck-states and issues at the yard's register (up to 3,000 spaces) answer
   inside one second in release on the yard's host, recorded in
   `docs/stress-test.md`.
7. A backup was taken and a restore drilled on the yard's PostgreSQL; a
   release is tagged; `/health` reports tag, commit and schema version; the
   runbook and `support-bundle` were exercised by the yard's IT.
8. Each named user has logged in through the proxy and completed their
   role's five tasks; the wall display works in the meeting room.
9. The ATO vehicle is in writing from the ISSO or AO; the evidence bundle
   and POA&M are current at the release tag.
10. The go/no-go rehearsal on the yard's hull passed.

## The ATO stream

What an ISSO assembles for an RMF package, and where each item stands.
"Produced" means a CI artifact or generated document at the release tag.

| # | Artifact | Status | Source |
|---|---|---|---|
| A1 | System categorization (FIPS 199 / CNSSI 1253) | missing, yard | ISSO template; the data statement in SSP §1 as input |
| A2 | Authorization boundary and data-flow diagram | missing | prose in SSP §2; draw it (one listener, no egress, PostgreSQL inside) |
| A3 | SSP control implementation statements | produced (input) | `cargo xtask gen-ssp` → `docs/ssp-input.md`, drift-checked in CI |
| A4 | Hardware/software inventory | produced (software) | SPDX SBOM CI artifact; host inventory is the yard's |
| A5 | Ports, protocols and services (PPSM) | missing, trivial | one TCP listener, PostgreSQL port; derive from `serve.rs` and the unit |
| A6 | Security assessment plan and results | partly produced | WADL-SA-01..10, leak tests, `pg_rls`, property and golden tests; needs a dated, archived run (S17 evidence bundle) |
| A7 | Vulnerability and supply-chain results | produced | `cargo-deny` every push; host and PostgreSQL STIG results are the yard's |
| A8 | Cross-tenant isolation proof | produced | generated leak tests, `pg_rls` on live PostgreSQL |
| A9 | Audit record specification and integrity | produced | posture §5, `deploy/README.md`; ledger `verify-ledger` and chain verify on read; journald sealing is the yard's (POAM-4) |
| A10 | POA&M | produced, stale | `docs/poam.md`: close POAM-2 note, add B-item residue and review findings |
| A11 | Configuration management plan | partial | pinned toolchain, `--locked`, forward-only migrations; write cadence, rollback stance, release tagging (S16) |
| A12 | Contingency plan, backup and restore | missing | S16 runbook and drilled restore |
| A13 | Incident response procedure | missing | write against the audit stream, `support-bundle`, ledger verify |
| A14 | Privacy threshold analysis | missing | person ids enter the ledger in S12; no other PII |
| A15 | Interconnection agreements | not needed | no egress; statement in SSP §2 |
| A16 | Build integrity and reproducibility | produced | air-gap job, reproducible-build job, checksummed deployable set |
| A17 | SBOM and release signing | missing (POAM-5) | cosign or the enclave PKI once key custody exists |
| A18 | Secure code review record | partial | clippy walls, `forbid(unsafe_code)`; the critique and security-review passes persisted in this directory become the record |
| A19 | Security impact analysis per change | produced | `gen-ssp --check` and `gen-leak-tests --check` fail drift; the packets are the SIA |
| A20 | Rules of behaviour and training records | missing | role cards and the training sessions |
| A21 | Cryptography statement | missing, short | sha2 hash chain is tamper evidence, not confidentiality; TLS and CAC at the accredited terminator |

The repo already produces A3, A4, A7, A8, A9, A16, A19 and most of A6; S16
and S17 add A11, A12, A6's archive and the bundle; A2, A5, A13, A14, A21 are
drafting from the code; A1, A17, A20 and the host halves need the yard.

## Files

New: `docs/programme/charter.md` (this), `programme.md`, one packet per
slice, `critique-<lens>.md` per pass. The slices touch the files their
packets list; charter-level expectations are `deploy/README.md` (runbook,
person header), `docs/poam.md`, `README.md` status, `xtask/src/main.rs`
(evidence bundle), `shell-web/package.json` (dev-only Playwright).

## Tests

The programme's own tests are the definitions above, made runnable: the
Playwright walk on both stores, the API suite against PostgreSQL in CI, the
self-assessment with the proxy key set, and the cold walkthrough as a
repeatable procedure.

## Acceptance

Every statement under "pilot-ready" checked true at a tagged release on the
yard's PostgreSQL, with the evidence bundle from that tag handed to the ISSO.

## Demo moment

The go/no-go rehearsal: the demo script on the yard's hull, in the yard's
zones and shift names, with the yard's rules, every commit in the ledger
under a person's name, and the chain verify clean.

## Depends on / conflicts with

S13 and S12 wait on the yard (sitting, proxy contract); S10 and S11 do not
and go first. S14 follows any slice that adds a `Repositories` method. S17
is last because it proves the others. Conflicts: slices touching
`Chrome.tsx` (S10 clock, S12 whoami person, S18 words) should not overlap;
`programme.md` sequences them.

## Risks

- The yard's XER teaches something the variants did not; S11's field map
  must absorb it as data. Get the export before S11 is critiqued.
- The safety authority is unavailable; the pilot runs on the signed
  hot-work-only fallback and the rule door lands anyway.
- The proxy owner cannot add a person header; fall back to the mapped
  subject in `x-org-id`'s companion and log the gap in the POA&M.
- The AO's clock: if no vehicle exists by week 6, the pilot is a demo in a
  room, not a system in an enclave; ask in week one.
- One agent, one tree: a red head blocks the next sitting; the implementer
  contract's gate discipline is the mitigation.

## Needs from the yard

The table above, with an owner and a date for each row, before the third
slice lands.

## Estimate

Human team: about 11 calendar weeks to pilot-ready, three engineers, then an
8-week pilot; ATO decision on the AO's clock. Claude: about seventeen
sittings, two to three working weeks, gated by the yard's inputs.

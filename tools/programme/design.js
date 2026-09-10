// Design workflow for the pilot programme: one designer per slice writes
// docs/programme/<id>-<title>.md; an integration architect writes
// docs/programme/programme.md; three critics write docs/programme/critique-*.md.
// Run with the Claude Code Workflow tool: Workflow({scriptPath: "tools/programme/design.js"}).
export const meta = {
  name: 'pilot-programme-design',
  description: 'Design every remaining pilot slice against the code, then integrate and critique the programme',
  phases: [
    { title: 'Design', detail: 'one designer per slice, plus the programme charter; each writes docs/programme/<id>.md' },
    { title: 'Integrate', detail: 'waves, migration numbers, file ownership, shared contracts' },
    { title: 'Critique', detail: 'yard, ISSO and UX critics on the whole programme' },
  ],
}

const REPO = '/home/user/shipyardaionboard'

const CONVENTIONS = [
  'Repository: ' + REPO + ' (Rust workspace + React/Vite shell in shell-web), branch claude/kickoff-from-docs-arhiib. Read before you design:',
  '- docs/pilot-readiness-review.md (the ranked barriers B1-B13 and HIGH items H1-H10; sections 4 and 5), docs/execution-plan.md (slices 1-9 landed; the rules every slice is held to), docs/ux-gap-analysis.md, docs/poam.md, docs/production-posture.md, docs/ssp-input.md, docs/demo-script.md, docs/zone-scheme.md, docs/p6-ingest-schema.md, README.md.',
  '- The code your slice touches. Key files: crates/wadl-api/src/{handlers.rs (4,300 lines; clippy too_many_lines bites; new work goes in NEW modules), documents.rs, routes.rs, lib.rs, auth.rs, hardening.rs, bin/serve.rs}; crates/wadl-store/src/{repo.rs (the async Repositories trait; BOTH memory.rs and pg_repo.rs implement it), model.rs, memory.rs, pg_repo.rs, ledger.rs}; crates/wadl-engine (pure, wasm-safe: no tokio/sqlx/std::time); crates/wadl-ingest/src/xer.rs; crates/wadl-cli/src/main.rs; migrations/ (0001-0015, forward-only, RLS on every tenant table, proved by crates/wadl-store/tests/pg_rls.rs); shell-web/src/{App.tsx, Chrome.tsx (roles/personas), api.ts, DailyOps.tsx, SequenceBoard.tsx, SourcesBoard.tsx, DeckExplorer.tsx, TimeControl.tsx, clock.ts, reports.ts, Reports.tsx, LedgerBoard.tsx, IssuesBoard.tsx, LeverageBoard.tsx, ingest.ts}.',
  'Established patterns you must design WITH, not around:',
  '- "Doors": a document enters through a route with a server-side dry run (preview/findings/rejections with reasons), a commit that writes a ledger entry, and a revert. See documents.rs, the register/couplings/zones/geometry/hazards/schedule-of-record/manning-book/budget-book handlers, and SourcesBoard.tsx. Every document commit and revert is ledgered on both stores.',
  '- Provenance: every figure names its layer (schedule of record / engine / shell estimate). Nothing renders good news it cannot prove: a failed read is "unavailable", never an empty list.',
  '- Time-honesty: every read takes an instant (as_of); the past does not change because someone acted in the present.',
  '- Routes are listed in routes.rs with leak-test sample bodies; adding a route requires `cargo run -p xtask -- gen-leak-tests` (and gen-ssp). Errors are problem+json.',
  '- Lint gate: cargo fmt; RUSTFLAGS=-D warnings clippy --workspace --all-targets --all-features (pedantic lints are ON: too_many_lines, indexing_slicing, similar_names, items_after_statements); cargo test --workspace --all-features; shell: npm run typecheck, npx vitest run, npm run build.',
  '- No new runtime dependency without a written reason (hand-rolled middleware/parsers are the accreditation story). Ask whether the slice truly needs one; if so name it and the reason.',
  '- Decision support only: the product never edits the schedule of record and never grants an authorization.',
  '- The demo boots on the reference hull (reference/cvn73 + reference/p6-sample/CVN73-PIA26-full.xer, 476 spaces, 5,706 activities) via scripts/dev.sh; the seed world is the 24-space alternative. Anything you add must work on both and must be demoable on the reference hull.',
  '- Only 4 CPUs are available: implementation will be done by ONE agent at a time on the main tree in roughly a two-to-four-hour sitting per slice, so design the SMALLEST slice that closes the barrier for the pilot. Prefer under fifteen files touched; put anything beyond that in out_of_scope with a one-line reason. Do not build; do not run cargo or npm.',
  'PERSIST YOUR WORK: before you return, write your full design as Markdown to ' + REPO + '/docs/programme/<id>-<kebab-title>.md (id lower-case, e.g. s10-yard-clock.md; charter.md, programme.md, critique-<lens>.md for the non-slice agents). Sections: Summary; What already exists; Scope; Out of scope; Contracts (routes with JSON shapes, documents, migrations, env, CLI, shell modules); Files (new / touched); Tests; Acceptance; Demo moment; Depends on / conflicts with; Risks; Needs from the yard; Estimate. Keep it under 350 lines. The file is the deliverable a human team would have produced as a design review packet; the JSON you return is its index.',
].join('\n')

const SLICES = [
  { id: 'S10', title: "The yard's clock", brief: "Pilot barrier B6. Everything is UTC; shifts anchor to UTC midnight; watch, half-shift and shift are three names for the yard's day. Design: a per-yard IANA time zone and shift calendar as ONE small authored document (a door with dry run/commit/revert/ledger, on both stores, seeded for the demo yard), the XER wall-clock parsed in that zone, every clock and sheet rendered yard-local with the zone shown once, Daily Ops and the time grid driven from the calendar, shifts called what the yard calls them, the report shift windows following it. Note: no tz database crate exists in the workspace; the preferred answer is an authored offset schedule (standard offset + optional daylight rule with two nth-weekday transitions) evaluated by a small pure civil-time module in wadl-domain and mirrored in the shell, with one shared test-vector file. Confirm or refute that with reasons. Keep the shell change tractable: a single clock module the formatters go through, not a rewrite of every screen." },
  { id: 'S11', title: 'The morning meeting', brief: "HIGH item H3, the highest-value UX item. A Tomorrow mode on Daily Ops: next shift's work with the holds standing in front of it, split into 'clearable tonight' versus 'clears on its own', each with the clearing authority and the earliest clear; and a Week page keyed to the next key event (from the schedule of record's milestones), worst first, with proposals already headed to P6 shown against it. Depends on the yard clock (S10) for shift windows: assume a contract of GET /api/vessels/:id/timeframe returning a yard_clock {zone, standard offset, optional daylight rule, block minutes, named shifts with start/end minutes} and a shell module yardClock.ts exposing shiftWindows(clock, dayStart) and toCivil/fromCivil; state any other assumption. Design the exact screens, what each row says, the engine/API reads they need (existing: deck-states, activities, schedule-alternatives, issues, leverage, schedule-proposals), and the print sheets." },
  { id: 'S12', title: 'A person behind every decision', brief: "Pilot barrier B5 and POA&M items 1 and 6. Today the shell sends a compile-time identity, the hull picker is a constant list, append_audit has no actor, by_person is NULL on every ledger row, handling markings are string constants. (The empty-WADL_PROXY_KEY refusal already landed.) Design: extend the proxy header contract with a person id and display name (and roles/capabilities), thread the person into the ledger hash and every ledger row (with a chain-format version so existing chains still verify), make the shell read /api/whoami and build its identity, roles and hull list from it, keep the dev shim as an explicitly-labelled demo mode, and take the role model beyond per-hull assignment (capabilities per role: who may clear, raise, commit a document, propose). Write the identity-proxy contract as a document a yard's proxy owner can implement (docs/identity-proxy-contract.md)." },
  { id: 'S13', title: "Survive the yard's XER, with run history", brief: "Pilot barrier B4 and HIGH item H4. Today UDF names are hard-wired, one bad row refuses the file, UTF-8 only, material resources summed as man-hours, no project filter, level-of-effort rows treated as work. Design: a per-vessel field map door (which XER field/UDF carries compartment, work item, work type, trade), row-level quarantine with reasons instead of refusing the file, Windows-1252 decoding (a hand-rolled 128-entry table), labor-only resources as man-hours, a project filter, LOE rows excluded from work, an ingest_run row per import with the served run pointed to, diff and revert against any prior run, stable activity ids from (vessel, task_code), and 'reading <label>, imported <when> by <whom>' in the breadcrumb. Check what the existing schedule-of-record door and xer.rs already do before designing." },
  { id: 'S14', title: 'Rules the yard will sign', brief: "Pilot barrier B11. Nine seeded rule entries cover 7 of 21 rule-table rows (handoff/01-rule-table.csv) and contradict the table in two places; bound by class only, ignoring work type, category and effective-from; cold-work inspections are refused by hot-work rules. Design: work type carried on activities (from the XER field map of S13; assume a work_type field on the activity read), rules bound by work type, category and effective range, a rule-set import door in the rule table's CSV layout with dry run, a golden trace per row (a test fixture the safety authority can read), the safety authority's sign-off recorded as a document, and the seed audited against the table. State exactly how evaluate() and the RuleSet change and how existing traces stay stable." },
  { id: 'S15', title: 'Run it in production', brief: "Pilot barrier B13. No backup or restore procedure, forward-only migrations with no rollback stance, no version stamp, no tagged release, no runbook, support bundle vestigial. Design: docs/runbook.md (install, configure the proxy, back up, restore, upgrade with migrations, roll back, incident, support bundle), scripts for backup and restore with a drill test that can run in CI against PostgreSQL, a release version (git describe + schema version) baked at build time and surfaced in /health and the shell footer, a written migration rollback policy, and a real `wadl support-bundle`." },
  { id: 'S16', title: 'Prove the production path in CI', brief: "Remainder of pilot barrier B10. The API integration tests (crates/wadl-api/tests/*.rs, about 15 files) run on the in-memory store only. Design: make the suite store-generic (a test-support module that builds the app over memory or PostgreSQL from DATABASE_URL), run it against PostgreSQL in CI (there is already a postgres service job in .github/workflows/ci.yml), mark database tests ignored unless DATABASE_URL is set, decide how the PostgreSQL world gets its data in CI (the seed vs loading the reference documents through the doors; the doors are the honest path; a `wadl load-docs` CLI door is acceptable), and check whether demo mode still binds off loopback." },
  { id: 'S17', title: 'Tests that prove the pilot, and a cold walkthrough', brief: "HIGH items H6 and H9. Design: a Playwright smoke suite (playwright-core is installed in shell-web/node_modules; Chromium at /opt/pw-browsers/chromium) over load, scrub, trace, clear, raise, propose, ledger and the demo script's path, runnable locally and in CI against the built shell + release API; the five pilot-critical behaviours pinned as API tests; a doc reconciliation list (README status, BACKLOG, engine lib.rs docs, ADR 0002, the ingest schema doc, the traversal doc comment vs the code); and a plan to split crates/wadl-api/src/handlers.rs (4,300 lines) into modules without changing behaviour." },
  { id: 'S18', title: 'Conflict issues from the engine', brief: "HIGH item H1. Hot-vs-flammable and crowding today are shell-side English keyword matching (see SequenceBoard's 'hot vs flammable today' and the work-conflicts route). Design: a per-yard trade taxonomy document (trade code to work type: hot work, flammable/coatings, confined space, electrical, etc.) through a door, hot-vs-flammable and crowding as engine- or plan-derived issues with an adjudication path into the ledger (acknowledge with a decision), surfaced on Conflicts & Risk and the Sequence Board. Assume S13 gives activities a work_type and S14 binds rules by it; do not duplicate those." },
  { id: 'S19', title: 'Adjudication completeness', brief: "HIGH item H5. Issues have acknowledge only. Design: owner, due-by and state on issues (open / acknowledged / assigned / resolved / accepted-risk), ledgered with the person from S12; a decisions export a scheduler can apply in P6 (the proposals change-request CSV already exists; extend to decisions and clearances); the ledger screen summarising each decision kind in a sentence." },
  { id: 'S20', title: 'Vocabulary, polish and pilot onboarding', brief: "HIGH item H2 remainder plus pilot user onboarding. Audit the shell for: one badge primitive per fact, the trace as a sentence with engine detail behind a fold, authorities and coupling codes with display names, HAZARD_CLEARED and every ledger kind styled and summarised, first-run cards per role, keyboard and print behaviour, empty and error states. Design a concrete polish list (file, element, change) and a training guide outline (docs/training-guide.md) per role." },
  { id: 'S21', title: 'Pilot playbook and the ATO package', brief: "Documents only. Design: docs/pilot-playbook.md (the eight-week pilot: data-load procedure with the yard's scheduler, weekly cadence, success metrics, feedback loop into the ledger), the two outside conversations as prepared briefs with the decisions needed (the safety authority's rule-table sitting; the proxy owner's identity contract), an updated docs/ssp-input.md against NIST 800-53 anchor points with evidence pointers into the repo, POA&M closures with evidence, and an ATO package skeleton (what an ISSO needs from us, what exists, what is missing)." },
]

const DESIGN_SCHEMA = {
  type: 'object',
  required: ['slice', 'title', 'doc_path', 'summary', 'scope', 'out_of_scope', 'contracts', 'files_new', 'files_touched', 'tests', 'acceptance', 'demo_moment', 'depends_on', 'conflicts_with', 'risks', 'needs_from_yard', 'new_dependencies', 'estimate_hours'],
  properties: {
    slice: { type: 'string' }, title: { type: 'string' }, doc_path: { type: 'string' }, summary: { type: 'string' },
    scope: { type: 'array', items: { type: 'string' } },
    out_of_scope: { type: 'array', items: { type: 'string' } },
    contracts: { type: 'array', items: { type: 'object', required: ['kind', 'name', 'detail'], properties: { kind: { type: 'string', enum: ['route', 'document', 'migration', 'env', 'cli', 'shell_module', 'engine_api', 'store_api', 'doc', 'ci', 'script'] }, name: { type: 'string' }, detail: { type: 'string' } } } },
    files_new: { type: 'array', items: { type: 'string' } },
    files_touched: { type: 'array', items: { type: 'string' } },
    tests: { type: 'array', items: { type: 'string' } },
    acceptance: { type: 'array', items: { type: 'string' } },
    demo_moment: { type: 'string' },
    depends_on: { type: 'array', items: { type: 'string' } },
    conflicts_with: { type: 'array', items: { type: 'string' } },
    risks: { type: 'array', items: { type: 'string' } },
    needs_from_yard: { type: 'array', items: { type: 'string' } },
    new_dependencies: { type: 'array', items: { type: 'string' } },
    estimate_hours: { type: 'number' },
  },
}

function designPrompt(s) {
  return [
    'You are the lead engineer designing ONE slice of a naval-shipyard work-authorization product so that a single implementation agent can build it end to end without asking questions.',
    CONVENTIONS,
    'SLICE ' + s.id + ' - ' + s.title,
    'Brief: ' + s.brief,
    '',
    'Do the work: read the review sections and the code your slice touches (grep for the existing handlers, store trait methods, shell modules), confirm what already exists so you do not redesign landed behaviour, then produce the design. Be concrete: exact route paths and JSON shapes, exact document columns, exact migration DDL sketches (the number is assigned later; call it NNNN), exact new file paths (prefer new modules over growing handlers.rs), exact shell components and what each row/label says in yard words, exact tests (file and case names), and acceptance criteria a reviewer can check in the browser or with curl. Estimate honestly in agent-hours. List anything that needs the yard (rule table, proxy contract, real XER). Prefer zero new runtime dependencies; if one is unavoidable, name it and why. Write the Markdown design file first, then return the JSON index with doc_path set to the file you wrote.',
  ].join('\n')
}

const CHARTER_SCHEMA = {
  type: 'object', required: ['doc_path', 'human_team_plan', 'claude_plan', 'cannot_be_done_without_yard', 'definition_of_demoable', 'definition_of_pilot_ready', 'ato_stream'],
  properties: {
    doc_path: { type: 'string' },
    human_team_plan: { type: 'array', items: { type: 'object', required: ['phase', 'steps', 'weeks'], properties: { phase: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } }, weeks: { type: 'number' } } } },
    claude_plan: { type: 'array', items: { type: 'object', required: ['phase', 'how', 'checks_kept'], properties: { phase: { type: 'string' }, how: { type: 'string' }, checks_kept: { type: 'array', items: { type: 'string' } } } } },
    cannot_be_done_without_yard: { type: 'array', items: { type: 'string' } },
    definition_of_demoable: { type: 'array', items: { type: 'string' } },
    definition_of_pilot_ready: { type: 'array', items: { type: 'string' } },
    ato_stream: { type: 'array', items: { type: 'string' }, description: 'the ordered list of artifacts and evidence an ISSO needs, and which the repo can produce itself' },
  },
}

const charterPrompt = [
  'You are the programme lead for taking a naval-shipyard work-authorization product from "demoable" to "pilot-ready" (one MRO hull at one US yard, 5-15 named planners and superintendents, eight weeks, PostgreSQL behind the yard\'s identity proxy) and onward to a Navy ATO.',
  CONVENTIONS,
  'Read docs/pilot-readiness-review.md fully (its timeline assumes three engineers for 12 weeks), docs/execution-plan.md (what has landed since), docs/poam.md, docs/production-posture.md, docs/ssp-input.md.',
  'Task: write docs/programme/charter.md and return its index. It must contain (1) every step a human team would take from here to pilot-ready and ATO-ready (discovery, design reviews, build, QA, security review, documentation, training, data load with the yard, demo rehearsal, ATO artifacts) with the weeks the review implies; (2) how a single AI engineering session does each step faster WITHOUT dropping the check the step exists for (a design review becomes an adversarial critic pass; QA becomes a Playwright smoke plus a cold walkthrough; a security review becomes a threat-model-driven review of the diff against 800-53 anchors); (3) what genuinely cannot be done without the yard and how to prepare for it so the first meeting is decisive; (4) a crisp definition of "fully demoable" and of "pilot-ready" as checkable statements; (5) the ATO stream: which artifacts an ISSO needs, which the repo already produces (gen-ssp, cargo-deny, leak tests, RLS proof, ledger verify), which are missing.',
].join('\n')

const ARCH_SCHEMA = {
  type: 'object', required: ['doc_path', 'waves', 'migration_numbers', 'shared_conventions', 'contract_decisions', 'file_ownership', 'sequencing_risks', 'cuts'],
  properties: {
    doc_path: { type: 'string' },
    waves: { type: 'array', items: { type: 'object', required: ['name', 'slices', 'rationale'], properties: { name: { type: 'string' }, slices: { type: 'array', items: { type: 'string' } }, rationale: { type: 'string' } } } },
    migration_numbers: { type: 'object', additionalProperties: { type: 'string' }, description: 'migration file name -> slice' },
    shared_conventions: { type: 'array', items: { type: 'string' } },
    contract_decisions: { type: 'array', items: { type: 'object', required: ['topic', 'decision', 'affects'], properties: { topic: { type: 'string' }, decision: { type: 'string' }, affects: { type: 'array', items: { type: 'string' } } } } },
    file_ownership: { type: 'array', items: { type: 'object', required: ['path', 'owner', 'rule'], properties: { path: { type: 'string' }, owner: { type: 'string' }, rule: { type: 'string' } } } },
    sequencing_risks: { type: 'array', items: { type: 'string' } },
    cuts: { type: 'array', items: { type: 'string' }, description: 'scope the architect recommends cutting or deferring past the pilot, with why' },
  },
}

const CRITIC_SCHEMA = {
  type: 'object', required: ['lens', 'doc_path', 'verdict', 'missing', 'wrong', 'must_fix_before_pilot', 'demo_risks'],
  properties: {
    lens: { type: 'string' }, doc_path: { type: 'string' }, verdict: { type: 'string' },
    missing: { type: 'array', items: { type: 'object', required: ['item', 'why', 'where'], properties: { item: { type: 'string' }, why: { type: 'string' }, where: { type: 'string', description: 'slice id or NEW' } } } },
    wrong: { type: 'array', items: { type: 'object', required: ['slice', 'what', 'instead'], properties: { slice: { type: 'string' }, what: { type: 'string' }, instead: { type: 'string' } } } },
    must_fix_before_pilot: { type: 'array', items: { type: 'string' } },
    demo_risks: { type: 'array', items: { type: 'string' } },
  },
}

phase('Design')
log('Designing ' + SLICES.length + ' slices plus the programme charter (2 agents at a time on this box); each writes docs/programme/*.md')
const charterP = agent(charterPrompt, { label: 'charter', phase: 'Design', schema: CHARTER_SCHEMA, effort: 'high' })
const designs = (await parallel(SLICES.map(function (s) {
  return function () { return agent(designPrompt(s), { label: 'design:' + s.id, phase: 'Design', schema: DESIGN_SCHEMA, effort: 'high' }) }
}))).filter(Boolean)
const charter = await charterP
log(designs.length + '/' + SLICES.length + ' designs returned')

phase('Integrate')
const archPrompt = [
  'You are the integration architect. Below are ' + designs.length + ' slice design indexes for one Rust + React codebase; the full designs are the Markdown files at their doc_path (read every one). They will be implemented by ONE agent at a time on the main branch (4 CPUs, no parallel builds), each slice committed and pushed with the lint gate green.',
  CONVENTIONS,
  'Designs (JSON index): ' + JSON.stringify(designs),
  'Programme charter (JSON index): ' + JSON.stringify(charter),
  'Write docs/programme/programme.md and return its index. It must decide: (1) build waves: the order the slices are implemented in, respecting depends_on and putting the demo-critical and ATO-critical slices earliest, with docs-only slices (S21, parts of S20) able to run in a second agent slot alongside a build; (2) migration numbers: assign 0016 onward in build order, one file per slice that needs one, naming them; (3) shared conventions every implementer must follow (module placement, route registration and leak-test regeneration, ledger action naming, document door shape, provenance labels, test-support module, shell module registration in App.tsx, yard-word labels); (4) contract decisions where two designs disagree or overlap (the yard calendar contract S10/S11, the field map and work type S13/S14/S18, identity S12/S19, run history S13/S16, health/version S15/S16, issues S18/S19): decide, do not list options; (5) file ownership rules that keep later slices from rewriting earlier ones; (6) sequencing risks; (7) cuts: anything that should be deferred past the pilot, with why; also trim any design that touches more than fifteen files down to what the pilot needs. Be decisive and specific; the output goes straight into implementation prompts.',
].join('\n')
const arch = await agent(archPrompt, { label: 'architect', phase: 'Integrate', schema: ARCH_SCHEMA, effort: 'xhigh' })

phase('Critique')
const LENSES = [
  { id: 'yard', who: 'a shipyard production superintendent who has run carrier availabilities and a P6 scheduler who has lived through bad imports; you judge whether the morning meeting can run off this tool and whether the yard can load its data through it' },
  { id: 'isso', who: 'a Navy ISSO and an accreditation assessor working an RMF package; you judge identity, audit, RLS, supply chain, deploy integrity, honest failure, and whether the evidence an ATO needs will exist' },
  { id: 'ux', who: 'a product designer who has shipped dense operational tools for field users on shared displays and tablets; you judge vocabulary, information architecture, print sheets, first-run, error states, and whether a first-time superintendent reads every screen without a glossary' },
]
const critics = (await parallel(LENSES.map(function (l) {
  return function () {
    return agent([
      'You are ' + l.who + '. Review the pilot programme as an adversary: find what is missing, what is wrong, what must be fixed before a pilot, and what would embarrass a live demo. Read docs/programme/*.md in ' + REPO + ' (the charter, every slice design, programme.md) and the code and docs where you need evidence (docs/pilot-readiness-review.md, docs/execution-plan.md, docs/demo-script.md, shell-web/src, crates/wadl-api/src). Do not restate the plan; return only findings, each specific enough to act on. Write them to docs/programme/critique-' + l.id + '.md first, then return the JSON index.',
      'Charter index: ' + JSON.stringify(charter),
      'Architecture index: ' + JSON.stringify(arch),
    ].join('\n'), { label: 'critic:' + l.id, phase: 'Critique', schema: CRITIC_SCHEMA, effort: 'high' })
  }
}))).filter(Boolean)

return { charter: charter, designs: designs, arch: arch, critics: critics }

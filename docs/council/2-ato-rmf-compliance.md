# Council 2 — ATO / RMF compliance lead: IL5 and NNPI posture

Reviewed on `claude/kickoff-from-docs-arhiib` at `3b1df73` (working tree
carries S14 sitting-B edits in `rule_table.rs`, not read). Nothing was
implemented. §1.5 was measured against `target/release/serve` (built
2026-09-07; `hardening.rs` and `ledger.rs` unchanged since, so the audit-line
and chain claims are current; its `/health` predates the S15 stamp). Earlier
council documents: `1-chief-systems-architect.md` (tensions in §4) and
`7-hull-grid-template.md` (its HG-4 is carried here by control ID, as asked).

Two bars, kept apart. **IL5** is the CUI bar: validated crypto on every hop
and at rest, a STIG'd platform, DoD identity and session policy, audit that
covers access as well as errors. **NNPI** is different in kind: *need-to-know*,
not role — a Planner assigned to the hull is not thereby entitled to the
reactor compartments' arrangement, and the role → capability matrix has no
axis for that. §1.4 designs both readings; neither is assumed until §5 Q1.

## 1. Current state

### 1.1 Solid — evidence an assessor can run

- **One identity seam, fail-closed, proven.** `auth.rs:223-238` refuses before
  any identity header is read in proxy mode (constant-time compare,
  `:216-218`); an empty key refuses boot (`serve.rs:280-283`); the shim
  cannot bind off loopback (`serve.rs:335-343`, CI `ci.yml:85-97`). A person
  is required in proxy mode (`auth.rs:294-299`); absent roles resolve to
  `reader` (`:434-447`). Every scoped route resolves `Caller` first and the
  generated leak tests fail CI if one does not (`xtask/src/main.rs:151-172`).
  AC-3, AC-6, IA-2 (hybrid), IA-8 — with a verification pointer each.
- **Least privilege is one table and one gate.** `roles.rs:183-221` MATRIX,
  `:292-429` GATED (28 routes), `:495-508` the `route_layer`; a unit test
  refuses a POST placed nowhere (`:550-573`); a weakest-role test per gated
  route is generated (`xtask/src/main.rs:202-241`). No role holds every
  capability (`roles.rs:576-598`). Measured: a `reader` at `hazards/clear` →
  403 with the capability named (§1.5).
- **Tenant isolation is two independent layers.** 55 tables created, 55 with
  `ENABLE ROW LEVEL SECURITY` (grep over `migrations/`); policies deny on an
  unset GUC (`0001:117-139`, `NULLIF(current_setting(.., true), '')`); the app
  runs `SET LOCAL ROLE wadl_app` + `set_config('app.org_id', $1, true)` per
  transaction (`pg.rs:107-117`) so the owner bypass cannot hide a dropped
  policy; 29 `pg_rls` tests on live PostgreSQL. AC-3/AC-4/SC-4 at tenant
  grain.
- **The ledger is append-only by privilege and chained by hash.**
  `0007:36-39` revokes UPDATE/DELETE from `wadl_app`; `0017:13-14` refuses a
  format-2 row that names nobody; `append_audit_in` takes a per-hull advisory
  lock and hashes the actor (`pg_repo.rs:2049-2070`); the chain is re-verified
  on every read (`handlers.rs:1348-1366`) and offline by `wadl verify-ledger`.
  AU-10 at the "this row names this person" level.
- **Transport audit exists, is outermost, and logs refusals.**
  `hardening.rs:64-78` layer order; `:104` logs every `/api` request and every
  non-2xx; shed 503s included (`:135-151` sits inside). AU-2/AU-12 for the
  request grain.
- **No egress, no TLS stack, no config file, no unsafe; supply chain is
  evidence-shaped.** `Cargo.lock` has no `rustls`/`native-tls`/`openssl`; CSP
  `connect-src 'self'` (`hardening.rs:238-240`); env-only config
  (`serve.rs:13-47`); `unsafe_code = "forbid"`, panics denied
  (`Cargo.toml:93-108`); `cargo-deny` (`ci.yml:262-269`), SPDX SBOM
  (`:271-282`), vendored offline build (`:284-300`), reproducibility on
  dispatch (`:302-323`), `--locked` everywhere. CM-6/7, SA-11, SI-16, RA-5,
  CM-8, SR-3/4 (signing is POAM-5).
- **The paperwork is generated and drift-checked** (`gen-ssp --check`,
  `ci.yml:58-59`; self-assessment every build, `:61-81`) and
  `docs/ato-package.md` is honest about what is missing (§2.1, §2.3, §2.9,
  §2.11, A17, A21). CA-2/CA-7, PL-2 inputs.
- **Host sandbox** (`deploy/wadl.service:41-84`): SC-39, CM-7 and most
  OS-STIG "application account" items.
- **No credential and no PII beyond the proxy's subject.** `person`
  (`0001:67-77`) is never written (no `INSERT INTO person` in `crates/`); no
  session, no cookie (`identity-proxy-contract.md:17-20`); the shell persists
  only the demo role (`Chrome.tsx:171,182`).

### 1.2 Missing — not disqualifying, but each is a control an assessor will ask for by number

- **AU-3 content.** The audit line is exactly eight fields
  (`hardening.rs:107-116`; measured §1.5): no request id, no source address
  (nothing reads `x-forwarded-for`; grep over `crates/wadl-api/src` is empty),
  no session correlator, no trust mode, and on a 403 neither the capability
  nor the roles. AU-3 asks for "where the event occurred" and "source";
  `docs/runbook.md:299-301` defers the request id to after the pilot.
- **AU-5 (response to audit failure) is undefined, and the measured
  behaviour is the worst shape.** The audit write is `println!`
  (`hardening.rs:105`): it blocks the async worker on a slow pipe and
  *panics* on a dead one. Measured (§1.5): with the stdout reader gone,
  seven requests answered 200 with their lines lost silently, the eighth got
  an empty reply from a panicking `tokio-rt-worker`, and the process kept
  serving. No counter, no stderr line, no 503. In a container the log
  pipeline *is* a pipe (council 1 §4.3).
- **AU-2 at data-access grain.** Bulk reads are logged at path grain only:
  `GET …/compartments` returned 12 "Reactor plant (restricted)" spaces to a
  `reader` with one line saying `/compartments` (§1.5). Adequate for CUI, not
  for NNPI, where disclosure of a marked record must be auditable per record.
  Query strings are excluded by design (`hardening.rs:86`), so `as_of` — which
  instant was read — is not recorded either.
- **AU-9(3)/AU-10 are weaker than the SSP reads.** The chain is an unkeyed
  SHA-256 (`ledger.rs:81-96, 102-125`). Anyone who can UPDATE `audit_entry`
  — the owner role, which `wadl migrate`, `backup.sh` and `verify-ledger`
  all use — can rewrite a row *and every hash after it* consistently, and
  verify passes. It detects the app role (which cannot UPDATE anyway) and
  accidents, not a privileged insider. `ssp-input.md:182-192` says
  "non-repudiation"; the honest claim is "integrity against non-privileged
  modification". No chain head leaves the database.
- **SC-13 has no statement, and nothing in the binary is FIPS-validated.**
  RustCrypto `sha2 0.10.9` (`Cargo.lock:1550`) for the ledger and activity
  ids; under `postgres`, `md-5`, `hmac`, `sha2`, `stringprep` (`:1062, :715,
  :1845`) for SCRAM-SHA-256; `rand`/`getrandom` for uuid v7.
  `docs/ato-package.md:261` (A21) names the statement as missing. The AO
  will ask what protects CUI: today "nothing in the binary; the terminator
  and the disk" — acceptable *if written*, with the chain then a checksum,
  not a cryptographic control.
- **SC-28 has no statement.** The binary encrypts nothing at rest (correct).
  PostgreSQL at rest is the platform's (LUKS/dm-crypt under a FIPS kernel, or
  TDE); nothing in `deploy/README.md` or `docs/runbook.md` requires it.
  `scripts/backup.sh:63` writes `pg_dump -Fc` in the clear with a sha256
  sidecar — integrity, not confidentiality (CP-9(8), SC-28(1)); `pgcrypto`
  (`0001:27`) serves only `gen_random_uuid()`.
- **IA-5 / SC-12.** The proxy key and the database password are environment
  values (`auth.rs:102-104`; `serve.rs:78`); the unit file's credential hint
  does not work (council 1 §1.2, `deploy/wadl.service:36-39`) and its
  fallback line is a static authenticator in a config file (IA-5(7)). No
  rotation path: one key, compared exactly; rotating it restarts binary and
  proxy in lockstep.
- **AC-8 (system use notification).** No DoD consent banner anywhere in the
  shell (`grep -ri "consent\|government information system" shell-web/src`
  is empty). The terminator can show it at CAC login; the ASD STIG expects
  the application to, and `FirstRun.tsx` is the obvious place.
- **SC-8 on the database hop** — council 1 §1.3.1 in full; the sentence at
  `docs/ato-package.md:82-84` is false for this build. Carried in §4.1.
- **AC-2 is claimed Implemented** (`ssp-input.md:142`) but the binary does no
  account management: no creation, disablement, review, or last-use; the
  `person` table is unused. It is *inherited* from the directory and the
  terminator. Vocabulary, but an assessor reads "Implemented" as "show me".
- **AC-16 / AC-21 (security attributes, information sharing) do not exist.**
  The only place "restricted" appears in the data is a free-text register
  column (`documents.rs:150` `category`; `reference/cvn73/CVN73-register.csv`,
  12 rows) that nothing reads as a control; the shell's "Restricted only"
  filter (`DeckExplorer.tsx:252, 632, 1034-1035`) means *engine verdict ≠
  ALLOW*, not a handling marking — a word collision an NNPI reviewer will
  trip on. See §1.4.
- **`/health` is open and discloses** identity mode, backend, schema version
  and (at HEAD) commit and build instant (`handlers.rs:116-138`, measured
  §1.5). Council 1 A4/A17 cover the split; the disclosure part is CM-8/SI-11.
- **Nothing written for the platform's STIG half**: no container image, so
  no container evidence (council 1 §1.2); no PostgreSQL contract naming
  `pgaudit` on owner-role DML against `audit_entry` (the one path around
  append-only) or `log_connections`.
- **CP-9/CP-10 exist** (`scripts/backup.sh`, `restore.sh`,
  `restore-drill.sh`) but the SSP input has no CP family. **SI-4**: no
  counters; AU-6 review is `jq` over the journal (`deploy/README.md:133`).

### 1.3 Disqualifying for IL5/NNPI, or for carrier-scale concurrent use

1. **NNPI has no enforcement axis and no data model, and the reference hull
   already contains what NNPI would look like.** `TenantScope` is
   `{org, assigned_vessels, actor}` (`scope.rs:95-102`); assignment is per
   hull, in code only (`pg_repo.rs:133-137`); capabilities are per role.
   Nothing can say "this person may see the hull but not 4-116-0-E and its
   arrangement". Served documents are one jsonb row per (hull, kind)
   (`0011:69-78`; `pg_repo.rs:476`), so compartment-level RLS is not
   expressible on them. Measured: a `reader` receives every reactor-plant
   space by name (§1.5). If the yard's documents carry NNPI, this system
   cannot be accredited to hold it as built. Not a rewrite — the seam and
   the RLS pattern are the right places for a clearance axis (§1.4 A) — but
   architecture, and the customer's answer decides whether it is built.
2. **Hull drawings and a real hull's register are served unscoped or would
   be.** Council 7 HG-4: 9.9 MB of deck plates under `shell-web/public/decks`
   are served by `static_site` (`hardening.rs:276-346`) with no `Caller` —
   from the proxy host the port serves them without the key. The demo's
   plates are a public reissue; a CVN's reactor-compartment arrangement is
   NNPI. AC-3, AC-21, SC-4: a real hull's drawings must never enter the
   static bundle, and `static_site` must serve an allow-list, not a directory.
3. **The database hop cannot be encrypted by this build** (council 1
   §1.3.1). SC-8/SC-13 fail on every topology that is not same-host loopback.
4. **AU-5 as measured**: audit loss is silent and the process keeps serving.
   An AO reads "the system continues to operate without audit" as a
   disqualifier unless the SSP names it as the configured choice (AU-5(2)
   "halt on failure" is the DoD default posture for audit-critical systems).
5. **Two-transaction commits** (council 1 §1.3.2) are also AU-12 findings: a
   document served with no ledger row is an audit record that was never
   generated.

### 1.4 NNPI — two readings, both designed, neither assumed

**What could carry NNPI here.** The register (names, arrangement, adjacency
of reactor-plant spaces: `zone-scheme.md:44`, 12 rows in the reference
register), geometry (extents), couplings (paths through the plant), the
schedule of record (reactor-plant work descriptions, sequence, dates),
hazards in a plant space, and derivatively the ledger `detail`
(`handlers.rs:1577, 1661` write compartment and label) and findings that
cross a plant space. Placards alone are generally not NNPI; the arrangement,
the descriptions and the aggregate may be. The NNPI authority decides (Q1, Q2).

**Reading A — NNPI in-app, need-to-know enforced in RLS and in the shell.**
1. Identity: a seventh header `x-wadl-clearances` (comma-separated tokens,
   e.g. `nnpi`), resolved in `auth.rs::resolve` into
   `TenantScope.clearances: BTreeSet<String>`; never granted by the shim
   without the header; served on `whoami`.
2. Store: `with_tenant` also sets `app.clearances` (`set_config`, bound).
   `ingested_document` gains `segment text NOT NULL DEFAULT 'general'` in
   the primary key; `hazard` gains `handling text NOT NULL DEFAULT 'general'`;
   policies on both add `AND (segment = 'general' OR segment = ANY
   (string_to_array(current_setting('app.clearances', true), ',')))`. The
   doors split a committed document by the register's `handling` attribute
   (register rows marked `nnpi` and every geometry/coupling/schedule/hazard
   row that names one of them) into two rows; revert reverts both.
3. Read path: the store reads the general segment always and the NNPI
   segment only when cleared; the engine runs on what the store returned; a
   finding that crosses a hidden space is served as `restricted space` with
   the placard only (server-side, before serialisation — "server computes,
   shell renders" already puts this in the right place). The ledger `detail`
   for actions in marked spaces carries the placard, never the label.
4. Audit: every response that includes NNPI rows adds `restricted_rows: N`
   and the placards to the audit line (AU-2 per-record disclosure).
5. Shell: wears the marking on the space, the plate and the band; the
   "Restricted only" filter is renamed (`Held only`) so the word means one
   thing.
6. Proof: `pg_rls` tests per segment; generated leak tests driven without
   the clearance; a self-assessment check that an uncleared session gets
   404 on a marked compartment.
Effort ~40 agent-hours after the customer's word list and clearance source
exist. Not a rewrite: one more axis through the one seam and the one RLS
pattern.

**Reading B — metadata only; NNPI content stays outside.** The system holds
placards, deck, zone, frame, trade, activity ids and dates; no descriptive
label, drawing or arrangement for marked spaces. The register gains a
`handling` column; a marked row's `name` must equal the placard or a
customer-approved neutral string; a door lint (`WADL_HANDLING_LINT=<file>`)
refuses any document line matching the authority's word list, as a typed
refusal with the line number. Deck plates for a real hull are not shipped.
~10 h. The accreditation is then IL5/CUI; the NNPI authority still concurs
that placards + zones + reactor-work dates are not NNPI in aggregate (Q2).

Either way: HG-4 (§1.3.2) is required, and the customer must confirm scope
before either is assumed.

### 1.5 Measurements (release binary, 4 vCPU dev box, memory store)

| What | Value |
|---|---|
| Audit line fields (`GET …/register` as `reader`) | `audit, ts_ms, method, path, status, dur_ms, org, person` — 8; no req id, no src, no mode/roles/capability |
| 403 line for `reader` at `hazards/clear` | same 8 fields, `status: 403`; the capability appears only in the response body |
| stdout reader closed after 1.5 KB | requests 1–7: 200, lines lost silently; request 8: empty reply (curl 52), stderr `failed printing to stdout: Broken pipe (os error 32)` in `tokio-rt-worker`; process alive and serving |
| `reader`, reference hull | `/compartments`: 24 "Reactor" mentions, 12 "restricted"; `/deck-states`: 24; `/compartments/4-116-0-E/state`: 200; audit at path grain |
| `/health`, no identity | 200 with `identity_mode`, `store.backend`, `schema_version` (HEAD adds `version.git`, `built_at`) |
| `scripts/self-assessment.sh` | 11 PASS, 2 WARN (SA-05, SA-11 dev shim), 0 FAIL; no check reads the audit stream |
| RLS coverage | 55 `CREATE TABLE`, 55 `ENABLE ROW LEVEL SECURITY`, 0 `FORCE` (owner bypass by design) |
| Static bundle | `shell-web/public/decks` 9.9 MB, served without a `Caller` |

### 1.6 Gap list by control — POA&M starting point

Class: **ATO** blocks accreditation; **crash/perf** loses data or falls over;
**UX**. Effort in agent-hours including tests and docs.

| Control | Current state (evidence) | Remediation | Effort | Class |
|---|---|---|---|---|
| AC-16, AC-21 | no marking attribute, no need-to-know axis (`scope.rs:95-102`; `documents.rs:150` free text; §1.5) | R10a now; R10b if reading A | 10 / 40 | ATO |
| AC-3, SC-4 (static) | drawings served unscoped (`hardening.rs:276-346`; HG-4) | R11 allow-list; drawings as scoped documents (S22) | 3 | ATO |
| AC-2 | claimed Implemented (`ssp-input.md:142`); nothing in-app | R1: restate as Inherited (directory + terminator) | in R1 | ATO |
| AC-8 | no consent banner in shell or contract | R7 | 2 | ATO |
| AC-11, AC-12, AC-7, AC-10, AC-17 | terminator's (`deploy/README.md:91-109`); only proof is contract §8 step 10 | R1 names the parameters; the yard files the proxy config | 0.5 | ATO |
| AU-3 | 8 fields, no source/req/mode/cap (`hardening.rs:107-116`) | R4 | 4 | ATO |
| AU-5, AU-5(2) | silent loss then panic (§1.5) | R3 | 4 | ATO |
| AU-2 (data access) | path grain only; NNPI needs record grain | R12 (+R10) | 2 | ATO |
| AU-9(3), AU-10 | unkeyed chain, owner can rewrite consistently (`ledger.rs:81-125`) | R5 anchors; R9 validated hash; R1 restates the claim | 3 + 6 | ATO |
| AU-12 | commit and ledger row in two transactions (council 1 §1.3.2) | council 1 A3 | 10 | crash/perf |
| AU-4, AU-6, AU-11 | journald / pipeline / yard (POAM-4) | council 1 A14 per topology; R18 DB-side | 1 | ATO |
| IA-5, IA-5(1)(7), SC-12 | env secrets, no rotation (`auth.rs:102-104`, `serve.rs:78`, `wadl.service:39`) | council 1 A5 + R6 dual key | 3 | ATO |
| SC-8, SC-13 (DB hop) | no TLS stack; false sentence (`ato-package.md:82-84`) | council 1 A1/A2, FIPS build per §4.1 | 1 + 6 | ATO |
| SC-13 (statement) | no A21; RustCrypto everywhere | R2; R9 optional `fips` feature | 1 (+6) | ATO |
| SC-28, CP-9(8) | nothing written; backups in the clear (`backup.sh:63`) | R8 | 3 | ATO |
| CM-8, SI-11 | `/health` open disclosure (`handlers.rs:116-138`) | R13 with council 1 A4/A17 | 2 | ATO |
| CM-6, CM-7 (container) | no image, no STIG evidence | council 1 A8/A12 + R14 | 4 | ATO |
| CP-9, CP-10 | scripts exist, absent from SSP | R1 adds the CP family with the drill as proof | in R1 | ATO |
| RA-5 (container, DB) | cargo-deny only | R14 scan in CI; DB STIG is the yard's | in R14 | ATO |
| SI-4 | none | counters on `/health` (shed, timeouts, audit failures) | 2 | UX |
| CA-2, CA-7 | self-assessment lacks audit/consent/static checks | R15 | 3 | ATO |
| PL-2, PM | POA&M stale (POAM-4/5 open, no rows for the above) | R16 | 2 | ATO |

## 2. Prioritised actions

| id | action | class | effort | depends on |
|---|---|---|---|---|
| R1 | Restate the SSP: AC-2 Inherited; add SC-13, SC-28, AU-5, IA-5, SC-12, AC-8, CP-9/10, AC-16/21 (Planned, pending Q1); AU-9/10 worded as "integrity against non-privileged modification"; SC-8 per topology; regenerate | ATO | 3 | council 1 A1 |
| R2 | Cryptography statement (A21) from the code: algorithm, crate, version, purpose, validation status, per use | ATO | 1 | — |
| R3 | Audit writer with a defined failure mode: checked write, no panic, counter, one stderr line, `WADL_AUDIT_FAIL=halt` (default) turns `/health` 503 and refuses `/api` with 503 `audit unavailable`; `continue` keeps serving and counts | ATO | 4 | — |
| R4 | Audit line gains `req` (uuid v7, echoed `x-wadl-request`), `src` (`x-forwarded-for` first hop in proxy mode), `mode`, `roles`, `cap` on 403, `instance`; problem bodies carry `req` | ATO | 4 | (merges council 1 A13) |
| R5 | Ledger head anchoring: each append emits `{"audit":"ledger","vessel","seq","hash"}` on the audit stream; `verify-ledger --anchors <export>` cross-checks the chain against the platform's sealed log | ATO | 3 | R3 |
| R6 | Dual proxy key for rotation: `WADL_PROXY_KEY_PREVIOUS` accepted for the window, `key: previous` on the audit line; boot refuses if equal to current | ATO | 2 | council 1 A5 |
| R7 | DoD consent banner: `WADL_CONSENT_BANNER` (path to text) served on `whoami` as `consent_banner`; shell shows it before first render, acknowledged per browser session; contract §5 requires it at CAC login too | ATO | 2 | — |
| R8 | Backup confidentiality: `backup.sh` encrypts the dump (`openssl enc -aes-256-gcm` with the host's FIPS provider, key from `$WADL_BACKUP_KEY_FILE`); `restore.sh` decrypts; runbook §3 states LUKS/TDE for the data directory | ATO | 3 | — |
| R9 | `fips` cargo feature: `aws-lc-rs` (`fips`) replaces `sha2` for the ledger and activity ids and backs `postgres-tls`; CI `air-gap` builds it; without it the SSP calls the chain a checksum | ATO | 6 | R2, council 1 A2, Q4 |
| R10a | `handling` attribute on register spaces (`general`/`nnpi`/yard codes), carried on every served space and hazard, worn by the shell; door lint from a customer word list; rename "Restricted only" | ATO | 10 | Q1 |
| R10b | Reading A: clearance header → `TenantScope.clearances` → `app.clearances` GUC; `segment` on `ingested_document` and `handling` on `hazard` with policies; doors split at commit; server-side redaction of crossing findings; `pg_rls` + generated tests | ATO | 40 | R10a, R12, Q1, Q3 |
| R11 | `static_site` serves only paths in vite's manifest (`dist/.vite/manifest.json`) plus `index.html`; `public/decks` moves out of the bundle for any real hull; WADL-SA-14 | ATO | 3 | — |
| R12 | Audit line gains `rows` for list reads and `restricted_rows` + placards when R10 marks exist; `as_of` recorded as a field, not the query string | ATO | 2 | R4 |
| R13 | `/health` body without the proxy key in proxy mode is `{status}` only; full body with the key or on loopback | ATO | 2 | council 1 A4 |
| R14 | Container STIG evidence: Iron Bank base, uid 65532, read-only rootfs, no shell; CI runs the image against a STIG/CIS profile and archives the report; chart forbids privilege escalation | ATO | 4 | council 1 A8, A12 |
| R15 | Self-assessment WADL-SA-12..16: audit line carries `req`/`src`; audit failure → 503; `consent_banner` served; non-manifest static path 404; `/health` unauthenticated is status-only | ATO | 3 | R3, R4, R7, R11, R13 |
| R16 | POA&M rows POAM-8..15 for every open row in §1.6 with severity and trigger; POAM-4 rewritten per topology | ATO | 2 | R1 |
| R17 | `/health` counters: `shed`, `timeouts`, `audit_failures`, `pool_wait_ms` | UX | 2 | R3, council 1 A6 |
| R18 | Database contract: owner role only for `migrate`/`backup`/`verify`; `pgaudit` on `audit_entry` DML by the owner; `log_connections` | ATO | 1 | council 1 A18 |

Order: R1–R4 and R11 first (paper and the two measured faults); R5–R8 with
council 1 A5; R10a as soon as Q1 is answered and before any real register
is loaded; R9, R13–R16 with the container work; R10b only on reading A.

## 3. Concrete changes

| file | change | why |
|---|---|---|
| `crates/wadl-api/src/hardening.rs` | Replace `println!` in `audited` with `audit::emit(&line)`: `std::io::stdout().lock().write_all` + `\n`, result checked; on `Err` increment `AUDIT_FAILURES: AtomicU64`, write one `{"event":"audit_stream_failed"}` to stderr (once), and if `WADL_AUDIT_FAIL` is `halt` (default) set `AUDIT_DEAD: AtomicBool`. `guarded` refuses `/api` with 503 `problem+json` `"audit stream unavailable"` while dead. Add `req` (uuid v7) minted before `next.run`, set as `x-wadl-request` on the response and put in request extensions so `ApiError::into_response` can include it; add `src` from `x-forwarded-for` (first value, proxy mode only), `mode`, `roles` (from a second `auth::resolve` result cached in extensions by the gate), `cap` on 403, `instance`. Unit test with a writer that returns `Err` on the third line. | AU-5, AU-3; measured silent loss and panic |
| `crates/wadl-api/src/handlers.rs` (`health`) | Read `AUDIT_DEAD`/`AUDIT_FAILURES`; 503 `{"status":"audit_unavailable"}` while dead; unauthenticated body in proxy mode is `{"status", "decision_support_only"}` only. | AU-5, CM-8 |
| `crates/wadl-api/src/error.rs` | `problem` adds `"req"` from extensions when present. | AU-3 correlation |
| `crates/wadl-store/src/pg_repo.rs` (`append_audit_in`), `memory.rs` | After the insert, `println!`-free call into the same audit emitter: `{"audit":"ledger","org","vessel","seq","hash":hex}`. | AU-9(3) anchor |
| `crates/wadl-cli/src/verify.rs` | `--anchors <file>` reads JSON lines, indexes `(vessel, seq) → hash`, and reports any anchored row whose stored hash differs, plus the last anchored seq per hull. | Detects a consistent rewrite |
| `crates/wadl-api/src/auth.rs` | `Env` gains `previous_key: Option<String>` from `WADL_PROXY_KEY_PREVIOUS` (via the `read_secret` helper of council 1 A5); `trust_gate` returns which matched; boot refuses `previous == current`. `Env` gains `consent_banner: Option<String>` (file contents of `WADL_CONSENT_BANNER`, ≤ 4 KB). For R10b: `CLEARANCES_HEADER = "x-wadl-clearances"`, parsed into `TenantScope.clearances`, tokens `[a-z0-9_-]{1,32}`, never granted on the shim without the header. | SC-12 rotation; AC-8; AC-16 |
| `crates/wadl-api/src/roles.rs` (`whoami`) | Serve `consent_banner` and (R10b) `clearances`. | AC-8; shell renders what the server resolved |
| `shell-web/src/FirstRun.tsx`, `Chrome.tsx` | Modal with `whoami.consent_banner` before any hull renders; `sessionStorage` acknowledgement; rename "Restricted only" → "Held only". | AC-8; word collision |
| `crates/wadl-api/src/hardening.rs` (`static_site`) | Load `dist/.vite/manifest.json` at boot into a `HashSet<PathBuf>` of servable files (+ `index.html`, `favicon`); `serve_file` refuses anything else with 404; `WADL_STATIC_EXTRA` (dir) for deliberately public files. Test: a file present on disk but not in the manifest is 404. | HG-4; AC-3 on the static path |
| `shell-web/vite.config.ts` | `build.manifest: true`. | Feeds the allow-list |
| `crates/wadl-store/src/scope.rs`, `pg.rs` | (R10b) `clearances: BTreeSet<String>`; `with_tenant` sets `app.clearances` via `set_config($2, true)` joined by `,`. | Need-to-know reaches RLS |
| `migrations/0020_handling_marking.sql` (R10a) | `ALTER TABLE ingested_document ADD COLUMN handling_summary jsonb` (counts per marking, for `/health`/bundle without content); document shape version 2 adds `handling` per space and per hazard row (`model.rs` `RegisterSpaceSummary`, `HazardSummary`); `documents.rs` parses column `handling` (default `general`), refuses unknown codes. | AC-16 attribute exists before any real register is loaded |
| `migrations/0021_nnpi_segments.sql` (R10b) | `ingested_document`: add `segment text NOT NULL DEFAULT 'general'`, PK `(vessel_id, kind, segment)`; `hazard.handling text NOT NULL DEFAULT 'general'`; replace the two policies with the tenant predicate `AND (segment/handling = 'general' OR … = ANY(string_to_array(current_setting('app.clearances', true), ',')))`; `audit_entry.handling` likewise (rows about marked spaces are served only when cleared; the chain is verified server-side over all rows by a `SECURITY DEFINER` function `verify_chain(vessel)` that runs as owner and returns only the verdict). | Segregation is a database property, not a handler's memory |
| `crates/wadl-api/src/documents.rs` (doors) | R10a: door lint — `WADL_HANDLING_LINT=<file>` of case-insensitive terms; a line matching one in a `general` row is a typed refusal with the line number. R10b: split the committed document into segments by the register's `handling` and by reference (geometry/coupling/schedule/hazard rows naming a marked placard). | SI-10 keeps NNPI descriptors out (B) or in the right segment (A) |
| `crates/wadl-api/src/handlers.rs` (finding serialisation) | R10b: one `redact_for(scope)` pass over findings, adjacency and mitigations: a crossing into a hidden space is served as `{"placard", "restricted": true}` with no label; ledger `detail` for marked spaces carries the placard only. | Server computes, shell renders; no NNPI in the ledger's prose |
| `scripts/backup.sh`, `scripts/restore.sh` | `pg_dump … \| openssl enc -aes-256-gcm -pbkdf2 -pass file:"$WADL_BACKUP_KEY_FILE"` (the host's FIPS provider); manifest records `encrypted: true`; `restore.sh` decrypts first and refuses a clear dump unless `--allow-clear`. | SC-28, CP-9(8) |
| `Cargo.toml`, `crates/wadl-store/Cargo.toml` (R9) | `[features] fips = ["dep:aws-lc-rs"]` with `aws-lc-rs = { version = "1", default-features = false, features = ["fips"] }`; `ledger.rs` selects the digest by feature behind one `fn sha256(&[u8]) -> [u8;32]`; `postgres-tls` (council 1 A2) requires `fips`. CI `air-gap` job builds `--features fips` (cmake/go in the image). | SC-13 with a validated module where it is claimed |
| `xtask/src/ssp_template.md` | §5 gains CP, SC-13, SC-28, AU-5, IA-5, SC-12, AC-8, AC-16/21 (Planned) and the restated AC-2, AU-9/10, SC-8; §4 gains `WADL_AUDIT_FAIL`, `WADL_CONSENT_BANNER`, `WADL_PROXY_KEY_PREVIOUS`, `WADL_HANDLING_LINT`; fix "three import endpoints" (`:43`). | The generated SSP must carry every family the AO will ask for |
| `docs/ato-package.md` | §2.3 and §2.12 A21: the crypto statement (R2) and the DB-hop topology rule; §2.8 the audit failure mode and the `req` id. | Removes the false sentence and the missing artifact |
| `docs/poam.md` | POAM-8 plaintext DB hop; POAM-9 two-transaction commit; POAM-10 audit failure mode; POAM-11 unkeyed chain; POAM-12 backups in the clear; POAM-13 no marking/need-to-know axis (blocks any NNPI load); POAM-14 consent banner; POAM-15 static bundle unscoped. | Versioned with the code, as the register already promises |
| `scripts/self-assessment.sh` | SA-12 `x-wadl-request` on every `/api` response; SA-13 `/health` unauthenticated body has no `version`/`schema_version` in proxy mode; SA-14 `GET /decks/nope.jpg` and a manifest-absent file are 404; SA-15 `whoami.consent_banner` non-empty in proxy mode (WARN on shim); SA-16 (needs `WADL_AUDIT_FAIL=halt` and a closed stdout in CI) `/api` is 503. | CA-7: each new claim becomes a check |
| `.github/workflows/ci.yml` | `self-assessment` job adds the SA-16 run (`serve \| head -c 1 …`); `container` job (council 1 A12) adds an `oscap`/Anchore STIG profile step with the report as an artifact. | The measured fault becomes a regression test |
| `deploy/README.md`, `docs/runbook.md` | "Encryption at rest" section: LUKS/dm-crypt or TDE required for the data directory and WAL, key custody named; backups encrypted; `pgaudit` and `log_connections`; the consent banner at the terminator. | SC-28, AU-12, AC-8 — the yard's half, written where they look |

## 4. Tensions with earlier personas and proposed resolutions

1. **Council 1 §4.1 — TLS out of the default binary, mesh/loopback as the
   accepted shapes.** Agreed on the default. Stricter here: any TLS the
   binary ever carries must be a validated module, so `postgres-tls` must be
   `rustls` over `aws-lc-rs` with `fips`, never `ring`, and the GovCloud mesh
   must be the FIPS build of Istio with the SSP citing the module.
   Resolution: `postgres-tls` depends on `fips` (R9); the `air-gap` job builds
   it so the enclave build is rehearsed with cmake and go present.
2. **Council 1 A13 (request id, instance) vs my R4.** Same change; mine adds
   `src`, `mode`, `roles`, `cap` and the id in problem bodies. Resolution:
   one implementation, R4's field list, council 1's `instance`.
3. **Council 1 §4.3 — AU-9 moves to the platform's pipeline; "the ledger
   remains the tamper-evident record".** Half agreed: tamper-evident against
   the app role and accidents, not the owner role (§1.2). Resolution: R5
   anchors the chain head into the same pipeline so the platform's sealing
   covers the chain; R9 where the AO requires a validated hash; R1 words the
   claim honestly meanwhile. AU-5 stays in the binary regardless (R3): a
   pipeline cannot notice a writer that panicked.
4. **Council 1 A3 (ledgered commit in one transaction).** Agreed; it is also
   AU-12. If the data persona prefers an outbox, the audit requirement is
   only that the row exists whenever the document does.
5. **Council 1 §4.6 — keep the shared proxy key; the mesh policy is defence
   in depth.** Agreed, plus rotation (R6) and secret-from-file (A5): a static
   authenticator with no rotation path is IA-5(1) as it stands. Council 1 A7's
   import 503 raises no audit objection; it is logged with `cap` and `req`.
6. **Council 1 A4/A17 (`/health` split; unauthenticated `/health` through the
   terminator is a finding).** Agreed; R13 also strips the disclosure at the
   binary, because from the proxy host the port is reachable without a session.
7. **Council 7 HG-4 and Q4 (drawings in the static bundle; whether a real
   hull's grid is marked).** Carried as §1.3.2 / R11 with control IDs AC-3,
   AC-21, SC-4. Council 7's S22 grid document becomes a scoped, ledgered
   document — under reading A it also carries `handling`. The demo's invented
   CVN-73 numbers may stay in `reference/` only while no real hull exists in
   the repository (Q2 covers the aggregate). Council 7's "Restricted only"
   means an engine verdict; NNPI reviewers read it as a marking — renamed in
   R10a, and "restricted" is reserved for handling.
8. **Pillar 1 minimalism vs R9.** `aws-lc-rs` is a C library with a cmake
   build — the largest admission this tree would make. Resolution: behind
   `fips`, default off, admitted under Pillar 1 §3 only when the AO requires
   a validated module for AU-9(3); otherwise R1's wording plus R5 is the
   cheaper closure. The customer decides (Q4).

## 5. Questions only the customer can answer

1. **NNPI scope.** Will any document loaded into this system — register,
   geometry, couplings, schedule of record, hazard log — carry NNPI, and is
   the deployment to hold it (reading A) or exclude it (reading B)? Who is
   the NNPI authority that answers, and will they concur in writing?
2. **Aggregation.** Do compartment placards + zone membership + the dates and
   trades of reactor-plant work constitute NNPI in aggregate, even with every
   label stripped? This decides whether reading B is IL5 or still NNPI.
3. **Need-to-know source.** If reading A: where does a person's clearance
   come from for the proxy to assert it — a directory group, the RCO's
   list, or a signed roster — and who revokes it?
4. **Validated crypto for the ledger.** Does the AO require AU-9(3) to be met
   with a FIPS 140-validated module (R9), or accept an anchored SHA-256 chain
   as integrity evidence with the SSP wording of R1?
5. **At rest.** Which mechanism the yard's PostgreSQL host provides (LUKS
   under a FIPS-mode kernel, TDE, managed-service encryption) and who holds
   the keys; the same for backups (R8) and the journal on disk.
6. **Categorization and marking.** The FIPS 199 impact levels, the CUI
   category string for `WADL_MARKINGS`, and the DoD consent banner text (R7).
7. **Audit failure policy.** Halt or continue when the audit stream fails
   (R3 default `halt`); the SIEM the audit stream and the ledger anchors
   land in; retention period; whether EDIPIs may appear in it (PTA, contract
   Q8).
8. **Proxy key custody and rotation cadence** (contract Q6); whether the
   terminator or the application shows the consent banner, or both; the
   container platform and image base (council 1 Q1, Q2, Q5), whose STIG
   profile decides R14's tooling; and whether the AO accepts AC-2/7/10/11/
   12/17 as inherited from the terminator's ATO, and in which document.

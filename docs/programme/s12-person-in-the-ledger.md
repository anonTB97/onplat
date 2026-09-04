# S12 — A person behind every decision

Date 2026-09-04 · head `7783fda` · branch `claude/kickoff-from-docs-arhiib`.
Pilot barrier B5 (`docs/pilot-readiness-review.md` §4); POA&M items 1 and 6 (`docs/poam.md`); charter risk "the proxy owner cannot add a person header".

## Summary

Today the shell sends a compile-time `DEMO_IDENTITY` (`shell-web/src/demo.ts:19`), the hull picker is the constant `PICKABLE_HULLS`, `append_audit` takes no actor (`crates/wadl-store/src/repo.rs:468`), `audit_entry.by_person` is NULL on every row, every hashed detail says only `*_by_org`, and the handling markings are three string constants (`Chrome.tsx:40`). The empty-key refusal already landed (slice 2). This slice makes the identity proxy's hop carry a **person** (`x-wadl-person`, `x-wadl-person-name`) and **roles** (`x-wadl-roles`); resolves them once in the existing extractor into an `Actor` carried on `TenantScope`; hashes the actor into every new ledger row under a **chain format version 2** so the rows already written (v1) keep verifying; gates every write route by a **role → capability matrix** in one table-driven middleware, served on `/api/whoami` with the caller's hulls; makes the shell boot from `/health` + `/api/whoami` so its identity, role list, hull list and markings are what the server resolved; keeps the dev shim as an explicitly labelled **DEMO MODE** in which switching role switches what you may do; and writes the contract a proxy owner implements (`docs/identity-proxy-contract.md`). Zero new dependencies: header parsing, percent-decoding and the gate are a few dozen lines each, and hand-rolled middleware is the accreditation story.

## What already exists

- `auth.rs`: one extractor `Caller(TenantScope)`; `trust_gate` (constant-time `x-wadl-proxy-key`), `identity_mode()`; `x-org-id`, `x-assigned-vessels`; unit tests for both modes; `proxy_key_is_empty` boot refusal in `serve.rs`.
- `scope.rs`: `TenantScope { org, assigned_vessels }`, `new`, `is_assigned`. Every repo call takes it; `scoped_vessel`/`pg_get_vessel` turn a foreign or unassigned hull into `NotFound`.
- Ledger: `ledger.rs` `compute_hash(prev, action, detail, occurred_at_ms)`, `verify_chain`, `verify_records`, `build_chain`; `model::AuditRecord` (seq, action, detail, subject_ref, occurred_at_ms, hashes); `memory.rs:2294` and `pg_repo.rs:1488` `append_audit` (PG under a per-hull advisory lock); `handlers::ledger` re-verifies on every read; `wadl-cli verify-ledger` reads a `LedgerEntry` JSON export. Ten `append_audit` call sites in `handlers.rs` (decision, ack, raise ×2, clear, schedule replaced, `ledger_document` for every door commit/revert, hazard-log import, propose, withdraw), each with a `*_by_org` field in its hashed detail — left byte-stable.
- `migrations/0007`: `audit_entry` with `by_person uuid REFERENCES person` (never written), append-only by privilege, RLS. `0001` has `person`, `persona`, `persona_capability`, `person_assignment` — seeded in `pg_seed.sql`, read by no code path.
- Routes: `routes.rs` inventory (`/api/whoami` scoped, no `:id`); 21 POST rows, doors accept `?dry_run=true` (`DryRun`); `xtask gen-leak-tests` renders one foreign-hull test per scoped `:id` route and drives them as the yard tenant with hand-built headers; `gen-ssp` renders `ssp_template.md`.
- `hardening.rs:93` audit line carries `org` from the raw header; `/health` (`handlers.rs:121`) reports store reachability and versions; `deploy/README.md` documents the three-header contract; `self-assessment.sh` WADL-SA-03..06 check refusal, scope and mode.
- Shell: `api.ts` `Identity {org, assignedVessels}` → two headers on every fetch; `whoami()`/`WhoAmI`; every write surfaces the server's problem `detail` in its error path (`clearHazard` `api.ts:505`, acks, decisions, doors); `App.tsx` reads `listVessels`/`whoami` once with `DEMO_IDENTITY` and passes it as `identity=` to eleven modules; `Chrome.tsx` `PERSONAS` (seven roles with landing screens, remembered per browser), the persona menu with the "Signed in — as the server resolves it" block and the amber `DEV ID` badge, `ClassificationBanner` with `MARKINGS`; `LedgerBoard.tsx` renders entries with `summarise(detail)`.

## Scope

1. **Contract**: `x-wadl-person`, `x-wadl-person-name`, `x-wadl-roles` on the proxy hop; parsed in `auth.rs`; refused (401) without a person in proxy mode; synthesised and labelled in dev mode. `WADL_DEFAULT_ROLES` for a proxy that cannot assert groups. `WADL_MARKINGS` for the handling band.
2. **Store**: `Actor` on `TenantScope`; `AuditRecord` gains `actor_id`, `actor_name`, `chain_version`; both stores write v2 rows; migration NNNN; `ledger.rs` verifies v1 and v2 in one chain; `verify-ledger` reads old and new exports.
3. **Roles**: `roles.rs` — `Capability`, `Role`, the matrix, the gated-route table, the `gate` middleware (403 problem+json with a yard sentence), `whoami` moved here and extended (person, roles, capabilities, hulls, matrix, warnings, markings). Generated weakest-role tests from the same table.
4. **Shell**: boots from `/health` then `/api/whoami`; identity, role list, hull list and markings from the answer; `DEMO MODE` badge and menu text; capability-aware buttons on Data Sources and the Deck Explorer's raise/clear; a **By** column on the ledger; Field Guide paragraph.
5. **Docs**: `docs/identity-proxy-contract.md`; `deploy/README.md` points at it; POA&M 6 and posture Pillar 2 updated; execution-plan row.

## Out of scope

- Writing `person` rows and `by_person uuid` from the proxy subject: needs an upsert into a tenant table per first-seen person (a directory the pilot does not have); `by_person` stays reserved, `actor_id text` is the record.
- Per-hull roles (`x-wadl-roles` is per session; `person_assignment` is per hull): the pilot is one hull.
- The matrix as an ingested document with a door: it is eight rows the yard signs once; a code table served on `whoami` is verifiable and versioned with the binary. Revisit when a second yard wants a different one.
- Capability-aware buttons on `IssuesBoard`, `Mitigations`, `ActivityInspector`, `SequenceBoard`, `WorkOrders`: the server refuses with a sentence those screens already display; five files for cosmetics.
- Session, logout, idle timeout: the terminator's share (`deploy/README.md`), unchanged.
- A `x-request-id` in the audit line and problem bodies (S16).

## Contracts

### Proxy hop headers (the contract `docs/identity-proxy-contract.md` publishes)

| Header | Proxy mode | Dev shim | Format |
|---|---|---|---|
| `x-wadl-proxy-key` | required, constant-time match | ignored | as today |
| `x-org-id` | required | required | uuid, as today |
| `x-assigned-vessels` | required (may be empty) | as today | comma-separated uuids |
| `x-wadl-person` | **required** → 401 `"the proxy asserted no person (x-wadl-person)"` | optional → `dev:anonymous` | `[A-Za-z0-9._:@/-]{1,128}`, the proxy's stable subject (EDIPI or badge); outside the charset → 401 in both modes |
| `x-wadl-person-name` | optional | optional | percent-encoded UTF-8, ≤ 200 bytes on the wire, ≤ 120 chars decoded, control characters refused; undecodable → name = id and a whoami warning |
| `x-wadl-roles` | optional; absent → `WADL_DEFAULT_ROLES` or `reader` | absent → **every** capability (demo) | comma-separated role codes; unknown codes ignored and reported in `warnings` |

The proxy strips all six from client traffic before setting its own. `auth.rs` grows `resolve(parts: &Parts, key: Option<&str>, env: &Env) -> Result<Caller, ApiError>` shared by the extractor and the gate; `Caller` becomes `pub(crate) struct Caller { pub scope: TenantScope, pub roles: Vec<Role>, pub capabilities: BTreeSet<Capability>, pub person_source: PersonSource, pub warnings: Vec<String> }` (handlers keep destructuring `Caller { scope, .. }`; the `Caller(scope)` pattern is replaced mechanically at its ~60 sites by `Caller { scope, .. }` — one `sed`, no logic).

### Env (documented in `bin/serve.rs`'s header; unparseable falls back safe)

- `WADL_DEFAULT_ROLES` — role codes granted to every proxy-authenticated person when the proxy asserts none (e.g. `planner` for a pilot whose proxy cannot map groups). Ignored in dev mode. Unknown codes → refused at boot, like the empty key.
- `WADL_MARKINGS` — `|`-separated handling markings for the shell's band, default the three current strings. Served on `/api/whoami` as `markings`.

### `wadl_store::scope::Actor` and `TenantScope`

```rust
pub struct Actor { pub id: String, pub name: String, pub source: ActorSource }   // ActorSource: Proxy | DevShim | DevShimAnonymous | System
impl Actor { pub fn system(what: &str) -> Self; pub fn unattributed() -> Self /* id "system:unattributed" */ }
pub struct TenantScope { pub org, pub assigned_vessels, pub actor: Actor }         // `new` → unattributed; `with_actor(self, Actor) -> Self`
```

### Ledger chain v2 (`ledger.rs`)

`LedgerEntry` gains `#[serde(default = "one")] chain_version: u8`, `#[serde(default)] actor_id: Option<String>`, `#[serde(default)] actor_name: Option<String>`. `compute_hash_v2(prev, action, detail, occurred_at_ms, actor_id, actor_name)` = SHA-256 of `prev ‖ 0 ‖ "v2" ‖ 0 ‖ action ‖ 0 ‖ detail ‖ 0 ‖ occurred_at_ms(be) ‖ 0 ‖ actor_id ‖ 0 ‖ actor_name`. `verify_chain` dispatches per entry (1 → today's hash; 2 → v2; other → `HashMismatch`: a version we cannot hash is a hash we cannot trust). `build_chain` unchanged (v1); `build_chain_v2(&[(action, detail, ts, actor_id, actor_name)])`. `AuditRecord` gains `actor_id: Option<String>`, `actor_name: Option<String>`, `chain_version: u8`; `verify_records` maps them. Both stores write `chain_version 2` with `scope.actor` on every append; `list_audit` returns the columns.

### Migration `migrations/NNNN_ledger_actor.sql`

```sql
-- NNNN: a person on every ledger row (pilot barrier B5; POA&M 1 and 6).
-- The identity proxy's subject is a string (EDIPI, badge), not a row in
-- `person`; `by_person uuid` stays reserved for a directory-backed person.
-- Rows written before this migration are chain format 1 and keep verifying;
-- rows from now on are format 2 and hash the actor.
ALTER TABLE audit_entry
  ADD COLUMN actor_id      text,
  ADD COLUMN actor_name    text,
  ADD COLUMN chain_version smallint NOT NULL DEFAULT 1 CHECK (chain_version >= 1),
  ADD CONSTRAINT audit_entry_v2_names_a_person CHECK (chain_version = 1 OR actor_id IS NOT NULL);
COMMENT ON COLUMN audit_entry.actor_id IS 'x-wadl-person as asserted by the identity proxy (dev:… on the shim, system:… for the binary); hashed into entry_hash from chain_version 2';
CREATE INDEX ON audit_entry (org_id, actor_id, entry_id DESC);
```

RLS inherited; no new table. `pg_repo::append_audit` binds the three columns; `list_audit` selects them.

### Roles (`crates/wadl-api/src/roles.rs`)

```
Capability: read · raise_hazard · clear_hazard · commit_document · propose · decide
Role code         capabilities (read is implicit)              yard word
planner           raise_hazard commit_document propose decide  Planner
ship_super        raise_hazard clear_hazard propose decide     Ship Super
safety            raise_hazard clear_hazard decide             Safety
zone_manager      raise_hazard decide                          Zone Manager
production_super  raise_hazard decide                          Production Super
foreman           raise_hazard                                 Foreman
project_manager   decide                                       Project Manager
reader            —                                            Reader
```

Gated routes (`GATED: &[(&str, &str, Capability)]`; a POST with `?dry_run=true` is never gated — anyone may preview):

| Capability | Routes |
|---|---|
| `raise_hazard` | `POST /hazards`, `POST /hazards/import` |
| `clear_hazard` | `POST /hazards/clear` |
| `decide` | `POST /compartments/:no/decision`, `POST /issues/acknowledge` |
| `propose` | `POST /schedule-proposals`, `POST /schedule-proposals/withdraw` |
| `commit_document` | `POST` and `POST …/revert` for `register`, `couplings`, `zones`, `geometry`, `schedule-of-record`, `manning-book`, `budget-book` |

(all under `/api/vessels/:id`.) `roles::gate` is an `axum::middleware::from_fn` applied with `Router::route_layer` in `build_router`: it reads `MatchedPath` + method, looks the pair up in `GATED`, passes through if unlisted or `dry_run=true`, resolves the caller via `auth::resolve` (an error passes through so the handler refuses identically — 401 before anything), passes through if the path's `:id` is not in `assigned_vessels` (the handler's 404 comes first: a capability is never judged on a hull the caller cannot see), and otherwise refuses with `ApiError::Forbidden(sentence)` → **403** problem+json `{"title":"forbidden","detail":"Foreman may not record a clearance — clear_hazard is held by Safety and Ship Super","capability":"clear_hazard","roles":["foreman"]}`. Sentences per capability in yard words: "raise a field condition", "record a clearance", "commit or revert a document", "propose a schedule change", "answer for an option or an issue". `error.rs` gains `Forbidden(String)`.

`GET /api/whoami` (moved to `roles.rs`, now takes `State`):

```json
{ "identity_mode": "proxy-asserted", "org": "…0001", "assigned_vessels": ["…0073"],
  "person": { "id": "1234567890", "name": "R. Alvarez", "source": "proxy" },
  "roles": ["safety"], "capabilities": ["read", "raise_hazard", "clear_hazard", "decide"],
  "hulls": [ VesselSummary… ],                       /* list_vessels(scope): the hulls this scope is served */
  "role_matrix": { "planner": ["raise_hazard", …], … },
  "warnings": ["x-wadl-roles named an unknown role \"welder\" — ignored"],
  "markings": ["CUI//SP-CTI", "Decision support only"],
  "decision_support_only": true }
```

`person.source` ∈ `proxy` | `dev-shim` | `dev-shim-anonymous`. Dev mode with no roles header: `roles: []`, every capability, warning `"demo mode: no x-wadl-roles — every door is open"`. `GET /health` gains `"identity_mode"`. The audit line (`hardening.rs`) gains `"person"` from the raw header (`-` when absent). `routes.rs` needs no new row.

### CLI

None new. `verify-ledger` parses exports with or without the three fields (serde defaults).

### Shell modules

- `api.ts`: `Identity = { mode: "proxy" } | { mode: "dev"; org; assignedVessels; person: { id; name }; roles: string[] }`; `headers()` sends nothing for `proxy`, the five dev headers (name percent-encoded) for `dev`; `health(): Promise<{ identity_mode }>`; `WhoAmI` gains `person`, `roles`, `capabilities`, `hulls`, `role_matrix`, `warnings`, `markings`; `AuditEntry` gains `actor_id`, `actor_name`, `chain_version`.
- `demo.ts`: `DEMO_PEOPLE: Record<roleCode, {id, name}>` (`dev:planner` "Demo Planner (Y-1001)", `dev:safety` "Demo Safety Officer (Y-1007)", …); `DEMO_UNASSIGNED_HULLS` (DDG, LPD, "not assigned · demo") — the RBAC refusal stays demoable; `DEMO_IDENTITY`/`PICKABLE_HULLS` deleted.
- `identity.ts` (new, pure + one context): `devIdentityFor(persona): Identity`; `identityFromHealth(mode, persona)`; `hullChoicesFrom(who, mode): HullChoice[]`; `can(who, cap)`; `refusalSentence(cap, who)` mirroring the server's; `IdentityContext` / `useIdentity()` → `{ identity, who, whoState: "loading" | "ok" | "failed", can }`.
- `App.tsx`: boot `health()` → `identity` state → `whoami(identity)` → `who`; `hulls` from `hullChoicesFrom`; `identity={identity}` at the eleven sites; a dev-mode role switch rebuilds `identity` (new roles header) and re-reads whoami; `selected` defaults to `who.hulls[0]`; the `IdentityContext` provider wraps the modules.
- `Chrome.tsx`: `Persona.code`; `ClassificationBanner({ markings: string[] | null })` — null renders amber `HANDLING MARKINGS NOT RECEIVED — DO NOT SCREENSHOT`; the role button reads `R. Alvarez · Safety`; the `DEV ID` badge becomes `DEMO MODE`; the signed-in block: `R. Alvarez (1234567890) · asserted by the yard's proxy` / `roles: safety` / `may: raise a field condition · record a clearance · answer for an issue`; in proxy mode the switch list is `who.roles` only, footnote `roles come from the yard's directory — ask the proxy owner to change them`; in dev mode all seven, footnote `demo mode — the shim is not a login; switching role changes what you may do`; `whoState === "failed"` → `identity unavailable — /api/whoami did not answer` (as today).
- `LedgerBoard.tsx`: new **By** column: `actor_name` (title `id · source`); v1 rows read `— recorded before people were asserted (chain v1)`; the header note ends "…every row names the person who answered."
- `SourcesBoard.tsx`: `SourceCard` commit/revert buttons disabled when `!can("commit_document")`, title = the refusal sentence; dry run stays enabled with caption `anyone may dry-run; committing needs Planner or Ship Super`.
- `DeckExplorer.tsx`: raise and clear buttons the same under `raise_hazard` / `clear_hazard`.
- `FieldGuide.tsx`: paragraph "Who you are": the proxy names you, the ledger records you, your role decides which doors you may commit.

## Files

New: `crates/wadl-api/src/roles.rs`; `migrations/NNNN_ledger_actor.sql`; `docs/identity-proxy-contract.md`; `crates/wadl-api/tests/identity.rs`; `shell-web/src/identity.ts`; `shell-web/src/identity.test.ts`.

Touched (Rust): `crates/wadl-api/src/auth.rs` (person, name, roles, `resolve`, `Caller` fields, `Env`), `error.rs` (`Forbidden`), `lib.rs` (`pub mod roles`, `route_layer(gate)`, whoami → `roles::whoami`), `handlers.rs` (delete `whoami`; `/health` `identity_mode`; `Caller(scope)` → `Caller { scope, .. }` mechanically), `hardening.rs` (`person` in the audit line), `bin/serve.rs` (env docs, boot check on `WADL_DEFAULT_ROLES`, banner `identity: dev-headers — DEMO MODE, every door open`); `crates/wadl-store/src/scope.rs`, `ledger.rs`, `model.rs`, `memory.rs` (`AuditRow` actor + version), `pg_repo.rs` (bind/select); `crates/wadl-store/tests/pg_rls.rs`; `xtask/src/main.rs` (weakest-role block) and `xtask/src/ssp_template.md` (AC-6, IA-2, AU-10 sentences); generated `crates/wadl-api/tests/generated_leak_test.rs`, `docs/ssp-input.md`; `scripts/self-assessment.sh` (WADL-SA-11).

Touched (shell): `api.ts`, `demo.ts`, `App.tsx`, `Chrome.tsx`, `LedgerBoard.tsx`, `SourcesBoard.tsx`, `DeckExplorer.tsx`, `FieldGuide.tsx`.

Docs: `deploy/README.md` (table → contract link, curl with person), `docs/poam.md` (POAM-6 closure text, POAM-1 verify line), `docs/production-posture.md` Pillar 2 (four sentences), `README.md` run section (curl), `docs/execution-plan.md` row.

Twenty-six source files plus generated and docs — over the fifteen-file preference because the barrier runs from the proxy hop through the store to the chrome. The build order below has a cut line after item 5: above it closes B5 (person on every row, whoami-driven shell, gate); below it is the shell's cosmetics.

## Tests

Rust unit — `auth.rs`: `proxy_mode_refuses_a_request_with_no_person`; `dev_mode_synthesises_an_anonymous_person_and_says_so`; `a_person_id_outside_the_charset_is_refused_in_both_modes`; `a_percent_encoded_name_decodes_and_a_bad_one_falls_back_to_the_id_with_a_warning`; `roles_parse_and_unknown_codes_are_reported_not_granted`; `default_roles_apply_only_in_proxy_mode_and_only_when_none_are_asserted`. `roles.rs`: `every_post_route_in_the_inventory_is_gated_or_named_free` (the free list is empty today; a new POST must be placed); `no_role_holds_every_capability_and_reader_holds_none`; `a_dry_run_passes_the_gate`; `the_gate_sees_the_matched_path_on_every_gated_route` (drives `demo_app` with `x-wadl-roles: reader` and asserts 403 on one door, 404 on a foreign hull, 401 with no org). `ledger.rs`: `a_v2_entry_hashes_the_actor`; `a_chain_that_switches_from_v1_to_v2_verifies`; `altering_the_actor_of_a_v2_entry_breaks_the_chain`; `a_v1_export_without_the_new_fields_still_parses_and_verifies`; `an_unknown_chain_version_is_a_hash_mismatch`.

Rust integration — `crates/wadl-api/tests/identity.rs` (in-memory, `TestClock`): `whoami_names_the_person_roles_capabilities_hulls_and_markings`; `a_clearance_lands_in_the_ledger_under_the_person_who_recorded_it` (clear as `x-wadl-person: 1234567890`, roles `safety` → `GET ledger` newest row `actor_id`, `actor_name`, `chain_version 2`, `verified true`); `a_foreman_is_refused_a_clearance_with_a_sentence_and_nothing_is_written` (403 body, ledger length unchanged, hazard still live); `a_reader_may_dry_run_the_register_but_not_commit_it`; `a_foreign_hull_is_not_found_before_a_capability_is_judged` (reader + navy hull → 404); `dev_mode_without_roles_opens_every_door_and_the_ledger_says_dev_anonymous`; `every_door_commit_and_revert_names_the_person` (loop the seven doors as planner, assert every `DOCUMENT_*` row's actor). `pg_rls.rs`: `a_ledger_row_names_its_person_and_a_v1_row_before_it_still_verifies` (insert one v1 row as owner with today's hash, append v2 through the store, `verify_records` over `list_audit` reversed, the v2 constraint refuses a v2 row with no actor). Generated: `weakest_role_post_…` per gated route (in-tenant hull, `x-wadl-roles: reader`, sample body → 403) plus `every_gated_route_has_a_weakest_role_test` count; existing foreign-hull tests unchanged.

Shell — `identity.test.ts`: `a dev identity for a role sends that role and its demo person, name percent-encoded`; `a proxy identity sends no identity headers`; `can() reads capabilities, never role names`; `hull choices come from whoami, with the unassigned demo hulls only in demo mode`; `the refusal sentence names the role and who holds the capability`.

## Acceptance

1. Dev: `scripts/dev.sh`; banner prints `identity: dev-headers — DEMO MODE (every door open; x-wadl-roles narrows it)`. `curl -s -H x-org-id:…0001 -H x-assigned-vessels:…0073 localhost:8080/api/whoami` → `person.id "dev:anonymous"`, `person.source "dev-shim-anonymous"`, six capabilities, `hulls` with CVN-73, `warnings[0]` says demo mode.
2. Proxy: `WADL_PROXY_KEY=k ./target/release/serve` — no key → 401; key, no person → 401 with `detail "the proxy asserted no person (x-wadl-person)"`; `-H x-wadl-proxy-key:k -H x-wadl-person:1234567890 -H 'x-wadl-person-name:R.%20Alvarez' -H x-wadl-roles:foreman` → `person.name "R. Alvarez"`, `roles ["foreman"]`, `capabilities ["read","raise_hazard"]`, `identity_mode "proxy-asserted"`.
3. As that foreman, `POST …/hazards/clear` on the shaft-alley hold → 403 `"Foreman may not record a clearance — clear_hazard is held by Safety and Ship Super"`; `GET …/ledger` unchanged. With `x-wadl-roles:safety` → 200; the ledger's newest entry has `actor_id "1234567890"`, `actor_name "R. Alvarez"`, `chain_version 2`, `verified true`.
4. `POST …/register?dry_run=true` as `reader` → 200 preview; without `dry_run` → 403; nothing stored, no ledger row.
5. `WADL_MARKINGS='CUI//SP-CTI|Decision support only'` → the band reads those; kill the API → the band reads amber `HANDLING MARKINGS NOT RECEIVED — DO NOT SCREENSHOT`.
6. Browser, demo: the role button reads `Demo Planner · Planner` with amber `DEMO MODE`; the menu's signed-in block names the person and `may: …`; hull picker lists CVN-73/71/75 from whoami and DDG/LPD marked `not assigned · demo`; picking LPD renders OUT OF SCOPE as today. Switch to **Foreman**: Data Sources commit and revert buttons are disabled with the sentence, dry run enabled; Deck Explorer's clear button disabled. Switch to **Safety**: clear a hold; **Decisions Ledger** shows the row with `By Demo Safety Officer (Y-1007)`; the chain verifies.
7. PostgreSQL (`DATABASE_URL`, migrated pilot DB with rows from before): the Ledger's older rows read `— recorded before people were asserted (chain v1)`, new rows name the person, `✓ chain verifies`; `pg_rls` green.
8. `scripts/self-assessment.sh` against the proxy-armed instance: WADL-SA-05 PASS, new WADL-SA-11 PASS `whoami names a person (1234567890)`; on the dev instance WADL-SA-11 WARN `dev shim person`.
9. All gates green: fmt, clippy `-D warnings` pedantic, `cargo test --workspace --all-features`, `gen-leak-tests --check`, `gen-ssp --check`, `pg_rls`, `npm run typecheck`, `vitest`, `npm run build`.

## Demo moment

Open the role menu: it no longer says which of seven jobs you are pretending to do — it says who the server thinks you are, in amber, `DEMO MODE`, with the doors your role may open listed under your name. Switch to Foreman and walk to the shaft-alley hold: the clear button is grey and says, in one sentence, that a Foreman may not record a clearance and who may. Switch to Safety, clear it, open the Decisions Ledger: the newest row carries a name in the **By** column, the rows from last week say honestly that they were written before people were asserted, and the chain verifies across both. Then, in the terminal, the same clearance through the proxy contract with `x-wadl-person: 1234567890` — the ledger row reads `R. Alvarez`, and that is the name a board of inquiry gets.

## Depends on / conflicts with

Depends on nothing unlanded. **Conflicts**: S10 and S12 both edit `Chrome.tsx`, `App.tsx`, `api.ts`, `SourcesBoard.tsx`, `DeckExplorer.tsx` and `handlers.rs` — sequence them, do not overlap; whichever lands second rebases (S10's `ledger_document` `pub(crate)` change and this slice's `Caller { scope, .. }` rewrite are mechanical). S11 says it leaves `Chrome.tsx` alone. S14 (PG proof, CLI data load) follows this slice: the CLI door must pass an `Actor::system("wadl import --as <person>")` — the person flag is S14's. S16's request id joins the same audit line. S18 (yard words) may rename the capability sentences; they live in one table.

## Risks

- `MatchedPath` must be present in a `route_layer` middleware on this axum version; the unit test `the_gate_sees_the_matched_path_on_every_gated_route` pins it. If it is absent, the fallback is a one-line `caller.require(cap)?` per handler (21 sites) — worse, but bounded.
- A proxy that cannot assert group membership makes every pilot user a `reader`; `WADL_DEFAULT_ROLES=planner` is the documented, SSP-visible fallback — a deployment decision, not a silent default.
- Display names: header values are bytes; percent-encoding is the one scheme every proxy can emit (`$ssl_client_s_dn_cn` in nginx needs a `map`). Undecodable names fall back to the id and warn rather than refuse, so a name bug never locks a person out.
- The v2 constraint refuses a v2 row without an actor; both stores always carry one (`unattributed` at worst), and the memory store never writes NULL. A future v3 is a migration.
- The mechanical `Caller(scope)` → `Caller { scope, .. }` rewrite touches ~60 handler signatures in `handlers.rs`; zero logic, but the diff is large. Do it with one `sed` and let clippy prove it.
- Roles are per session, not per hull; a person who is Safety on one hull and a reader on another is the same on both. Stated in the contract; the pilot is one hull.
- Demo-mode role switching re-reads whoami and refetches the hull list; the selected hull persists across the switch (it is in the URL), so no board loses its place.

## Needs from the yard

- The proxy owner: which subject the terminator can assert (EDIPI from the CAC, badge from AD), whether it can assert a display name and group membership, header size limits, and the AD-group → role-code mapping (the contract gives them the eight codes).
- The role → capability matrix above, signed: in particular who may **record a clearance** (the clearing authority) and who may **commit a document** during the data load.
- The handling marking string from the ISSO (`WADL_MARKINGS`), and whether person ids may appear on screen and in the ledger export (PTA, charter A14).
- Whether the pilot needs `WADL_DEFAULT_ROLES` (no group mapping available on day one).

## Estimate

About 7 agent-hours across two sittings. Sitting one (server, ~3.75 h): `auth.rs` person/name/roles + `resolve` + tests 1.0; `scope.rs`/`ledger.rs` v2/`model.rs`/both stores/migration/`pg_rls` 1.0; `roles.rs` matrix, gate, whoami, `error.rs`, `lib.rs`, `Caller` rewrite 0.75; xtask weakest-role block, regen, SSP template, self-assessment, `identity.rs` tests, gates 1.0. Sitting two (shell + docs, ~3.25 h): `api.ts`/`demo.ts`/`identity.ts` + tests 0.75; `App.tsx` boot and hull list 0.5; `Chrome.tsx` banner, badge, menu 0.75; `LedgerBoard`/`SourcesBoard`/`DeckExplorer`/`FieldGuide` 0.5; `docs/identity-proxy-contract.md`, `deploy/README.md`, POA&M, posture 0.5; browser verification 0.25. Build order: scope/ledger → stores/migration → auth → roles/gate/whoami → API tests + generated tests → **cut line** → shell boot → chrome → ledger column and gated buttons → docs.

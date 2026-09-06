# The identity proxy contract

The normative statement of the hop between the yard's accredited reverse
proxy and the WADL binary: six headers, what the binary does with each, what
it refuses, and the test a proxy owner runs to prove the pairing. It matches
the code in `crates/wadl-api/src/auth.rs` (the one extractor), `roles.rs`
(the matrix and the gate) and `hardening.rs` (the audit line); a change to
any of those is a change to this page in the same commit. The background —
why the product authenticates nobody, the questions only the yard can settle
— is `docs/briefs/proxy-owner-contract.md`; this page is the part the proxy
owner implements.

## 1. The shape

- The binary binds loopback (`127.0.0.1:8080`; `WADL_BIND` widens it, only in
  the unit file) and speaks plain HTTP. TLS and CAC/PIV are the proxy's.
- The binary holds no session: no login route, no cookie, no logout. Every
  request is judged on the headers it arrives with, and a request without
  them is an unauthenticated request. Session lifetime is the proxy's
  (`deploy/README.md`, AC-11/AC-12).
- Two trust modes, chosen by the environment at boot and named on `/health`
  as `identity_mode`:
  - **`proxy-asserted`** — `WADL_PROXY_KEY` is set. Nothing is read until the
    request's `x-wadl-proxy-key` matches it in constant time. This is the
    only mode a yard runs.
  - **`dev-headers`** — the dev shim, DEMO MODE. Headers are trusted as
    given. Loopback only; the startup banner, `/api/whoami` and the shell's
    amber badge all say so.
- `GET /api/whoami` returns what the binary *resolved* — the person, the
  roles, the capabilities, the hulls — never an echo of the headers, so the
  pairing is verifiable with one call.

## 2. The headers

| Header | Required | Format | Refused when |
|---|---|---|---|
| `x-wadl-proxy-key` | in proxy mode, always | the shared secret from the proxy's secret store | absent or not equal → 401 before any identity header is read; `WADL_PROXY_KEY=""` refuses to boot |
| `x-org-id` | yes | uuid; the pilot's one tenant, equal to the organisation row the DBA bootstrapped | absent or not a uuid → 401 |
| `x-assigned-vessels` | present, may be empty | comma-separated hull uuids the person may see | never refused; an unparseable entry is dropped; a hull not listed is 404 on every route, the same body as a hull that does not exist |
| `x-wadl-person` | in proxy mode, yes | `[A-Za-z0-9._:@/-]{1,128}` — the proxy's **stable** subject for the person (EDIPI from the certificate, or the badge number); the same string for the same person across sessions and certificate renewals, because it is hashed into the ledger | proxy mode, absent → 401 `"the proxy asserted no person (x-wadl-person)"`; outside the charset, either mode → 401 `"x-wadl-person is not a person id — expected [A-Za-z0-9._:@/-]{1,128}"` |
| `x-wadl-person-name` | no | percent-encoded UTF-8 (RFC 3986 `%XX`; `+` is a plus), ≤ 200 bytes on the wire, ≤ 120 characters decoded, no control characters | never refused: undecodable, oversize, empty or control-bearing → the name falls back to the id and `whoami.warnings` says why |
| `x-wadl-roles` | no | comma-separated role codes from §3; whitespace around a code is ignored | never refused: unknown codes are ignored and reported in `whoami.warnings` (`x-wadl-roles named an unknown role "welder" — ignored`); absent in proxy mode → `WADL_DEFAULT_ROLES` if set, else `reader`; absent on the dev shim → every capability, with the warning `demo mode: no x-wadl-roles — every door is open` |

The proxy **strips all six** from inbound client traffic before setting its
own values. Without the key a client-set header is refused anyway; stripping
is the second layer.

Environment on the binary's side (documented in `crates/wadl-api/src/bin/serve.rs`):

- `WADL_PROXY_KEY` — arms proxy mode. Empty → the binary refuses to boot.
- `WADL_DEFAULT_ROLES` — role codes granted to a proxy-authenticated person
  who arrives with no `x-wadl-roles` (a proxy that cannot map groups). Ignored
  on the dev shim. An unknown code → the binary refuses to boot. When it
  applies, `whoami.warnings` carries `no x-wadl-roles asserted —
  WADL_DEFAULT_ROLES grants planner`.
- `WADL_MARKINGS` — `|`-separated handling markings the shell's band wears,
  served as `whoami.markings`. Unset → the prototype's own three strings,
  which are a statement about the demo data, not about any yard's.

## 3. Roles and capabilities

One table, `roles::MATRIX`, served verbatim as `whoami.role_matrix`. `read`
is implicit for every authenticated caller and never gated.

| Role code | Yard word | raise_hazard | clear_hazard | commit_document | propose | decide |
|---|---|---|---|---|---|---|
| `planner` | Planner | ✓ | | ✓ | ✓ | ✓ |
| `ship_super` | Ship Super | ✓ | ✓ | | ✓ | ✓ |
| `safety` | Safety | ✓ | ✓ | | | ✓ |
| `zone_manager` | Zone Manager | ✓ | | | | ✓ |
| `production_super` | Production Super | ✓ | | | | ✓ |
| `foreman` | Foreman | ✓ | | | | |
| `project_manager` | Project Manager | | | | | ✓ |
| `reader` | Reader | | | | | |

The deeds, in the words a refusal uses: `raise_hazard` — raise a field
condition; `clear_hazard` — record a clearance; `commit_document` — commit or
revert a document; `propose` — propose a schedule change; `decide` — answer
for an option or an issue. Roles are per session, not per hull: a person who
is Safety on one hull is Safety on every hull in `x-assigned-vessels`. Several
codes may be asserted; the capabilities are the union.

Gated routes (`roles::GATED`; every POST in the route inventory is here, and
a unit test refuses a POST that is in neither this table nor the empty
`FREE_POSTS`):

| Capability | Routes under `/api/vessels/:id` |
|---|---|
| `raise_hazard` | `POST /hazards`, `POST /hazards/import` |
| `clear_hazard` | `POST /hazards/clear` |
| `decide` | `POST /compartments/:no/decision`, `POST /issues/acknowledge` |
| `propose` | `POST /schedule-proposals`, `POST /schedule-proposals/withdraw` |
| `commit_document` | `POST` and `POST …/revert` for `register`, `couplings`, `zones`, `geometry`, `schedule-of-record`, `manning-book`, `budget-book`, `yard-clock` |

The gate is one `route_layer` middleware in front of the handler. Its
ordering is deliberate: `?dry_run=true` is never gated (anyone may preview);
an identity that fails to resolve passes through so the handler refuses it
identically (401 before anything); a hull outside `x-assigned-vessels` passes
through so the handler's 404 comes first (a capability is never judged on a
hull the caller cannot see). Only then is the capability judged.

## 4. What the binary does with each header

| Header | Used for | Where |
|---|---|---|
| `x-wadl-proxy-key` | the trust gate; nothing else is read until it matches | `auth.rs` `trust_gate` |
| `x-org-id` | the tenant of every read and write (`TenantScope.org`); on PostgreSQL `SET LOCAL app.org_id` and row-level security on every tenant table; the `org` field on every line of the HTTP audit stream | `auth.rs`; `wadl-store` `with_tenant`; `hardening.rs` |
| `x-assigned-vessels` | the hull list: `GET /api/vessels` and `whoami.hulls` list only these; any other hull is 404 on every route | `TenantScope.assigned_vessels` |
| `x-wadl-person` | the person on every ledger row: `TenantScope.actor`, hashed into the row's chain hash (chain format 2, migration `0017_ledger_actor.sql`), served as `whoami.person.id`, shown in the ledger's **By** column, written as `person` on the audit line | `auth.rs` `resolve_person`; `wadl-store` `ledger.rs`; `hardening.rs` |
| `x-wadl-person-name` | display only: `whoami.person.name`, the role button, the **By** column; stored beside the id on the row and hashed with it so a later rename does not rewrite history; never used to decide anything | `auth.rs` `resolve_name` |
| `x-wadl-roles` | the capability set through the matrix; the gate; `whoami.roles` and `whoami.capabilities`; the shell greys the doors the person may not open | `auth.rs` `resolve_roles`; `roles.rs` |

`whoami.person.source` says where the person came from: `proxy`, `dev-shim`
(a person header on the shim), or `dev-shim-anonymous` (no person header on
the shim; the id is `dev:anonymous`). Ledger rows written by the binary
itself (boot loaders, the CLI) carry `system:…` ids.

## 5. What the binary answers

`GET /api/whoami` (proxy mode, a Safety session):

```json
{ "identity_mode": "proxy-asserted",
  "org": "00000000-0000-0000-0000-000000000001",
  "assigned_vessels": ["00000000-0000-0000-0000-000000000073"],
  "person": { "id": "1234567890", "name": "R. Alvarez", "source": "proxy" },
  "roles": ["safety"],
  "capabilities": ["read", "raise_hazard", "clear_hazard", "decide"],
  "hulls": [ { "vessel_id": "…0073", "hull_no": "CVN-73", "availability_code": "PIA-26", … } ],
  "role_matrix": { "planner": ["raise_hazard", "commit_document", "propose", "decide"], … },
  "warnings": [],
  "markings": ["CUI//SP-CTI", "Decision support only"],
  "decision_support_only": true }
```

`GET /health` carries `"identity_mode"` beside the store's health. A refused
write is `application/problem+json`:

```json
{ "type": "about:blank", "title": "forbidden", "status": 403,
  "detail": "Foreman may not record a clearance — clear_hazard is held by Ship Super and Safety",
  "capability": "clear_hazard", "roles": ["foreman"] }
```

Nothing is written on a 403 — no document, no ledger row. Every ledger row
written from then on carries `actor_id`, `actor_name` and `chain_version: 2`;
rows from before carry nulls and `chain_version: 1` and keep verifying in the
same chain (`GET …/ledger` re-hashes end to end on every read; `wadl
verify-ledger` reads exports of either shape).

## 6. What the binary refuses

| Condition | Answer |
|---|---|
| `WADL_PROXY_KEY` set to the empty string | refuses to boot |
| `WADL_DEFAULT_ROLES` names a code that is not a role | refuses to boot |
| no key or wrong key (proxy mode) | 401 before any identity header is read |
| `x-org-id` missing or not a uuid | 401 |
| proxy mode, `x-wadl-person` absent | 401, `detail` `"the proxy asserted no person (x-wadl-person)"` |
| `x-wadl-person` outside the charset (either mode) | 401 |
| hull not in `x-assigned-vessels` | 404, the same body as a hull that does not exist — before any capability is judged |
| role lacks the capability for a write route | 403 with the sentence, `capability` and `roles`; nothing written |
| `?dry_run=true` on any door | never refused for capability |
| body over the ceiling | 413 (256 MB at the import doors, after the scope check) |

Every refusal is a line in the HTTP audit stream (stdout → journal) carrying
`org` and `person` from the raw headers (`-` when absent), at least as loud
as a success.

## 7. The shell's half

The shell reads `/health` first and asserts nothing until it knows the mode.
Behind the proxy it sends **no identity headers** — the proxy asserts them
on its hop and would strip the shell's anyway — and shows the person and
roles `whoami` returned, read-only. On the dev shim it sends the five
identity headers itself, a demo person per chosen role (`x-wadl-person:
dev:safety`, `x-wadl-person-name: Demo%20Safety%20Officer%20(Y-1007)`,
`x-wadl-roles: safety`; hyphens where a role code has an underscore, because
the charset has none), and wears an amber `DEMO MODE · dev identity` badge.
Either way the hull picker is `whoami.hulls` (plus, in demo mode only, two
unassigned demo hulls so the 404 stays demonstrable), the handling band is
`whoami.markings` (amber `HANDLING MARKINGS NOT RECEIVED — DO NOT SCREENSHOT`
without them), and a door the person's capabilities do not cover is greyed
with the refusal sentence — worded from `role_matrix` exactly as the server
would word it — as its tooltip. A 403 that still arrives is shown beside the
button in the server's words. `shell-web/src/identity.ts` is the whole of
it; `identity.test.ts` pins the headers, `can()`, the hull list and the
sentence.

## 8. The staging test

Run by the proxy owner against a staging instance booted with
`WADL_PROXY_KEY` set, through the proxy, with a real CAC session. Every line
is pass/fail; the output is filed with the pilot record.

```sh
# 1. Through the proxy, authenticated: the resolved person, not an echo.
curl -s https://yard-host/api/whoami
#    expect: "identity_mode":"proxy-asserted", "person":{"id":"<EDIPI or badge>","name":"…","source":"proxy"},
#            "roles":[…], "capabilities":[…], "hulls":[ the pilot hull ], "warnings":[]

# 2. Straight at the binary's port from the proxy host, no key: refused before identity.
curl -s -o /dev/null -w '%{http_code}\n' -H "x-org-id: <pilot org uuid>" -H "x-wadl-person: 1" http://127.0.0.1:8080/api/vessels
#    expect: 401

# 3. Header laundering: client-set identity headers must not survive the proxy.
curl -s -H "x-org-id: ffffffff-ffff-ffff-ffff-ffffffffffff" -H "x-wadl-person: attacker" -H "x-wadl-roles: planner" https://yard-host/api/whoami
#    expect: the pilot org uuid, your own person id, your own roles — none of the client's values

# 4. A hull outside the assignment is absent, not forbidden.
curl -s -o /dev/null -w '%{http_code}\n' https://yard-host/api/vessels/ffffffff-ffff-ffff-ffff-ffffffffffff
#    expect: 404

# 5. A session whose proxy asserts no person is refused (proxy owner: forward one request with x-wadl-person removed).
#    expect: 401, "detail":"the proxy asserted no person (x-wadl-person)"

# 6. A role without the capability is refused with a sentence, and writes nothing.
#    As a Foreman session, with a live hazard's compartment and kind:
curl -s -X POST -H 'content-type: application/json' \
  -d '{"compartment":"3-148-2-E","kind":"energised_bus","basis":"staging test"}' \
  https://yard-host/api/vessels/<hull>/hazards/clear
#    expect: 403, "detail":"Foreman may not record a clearance — clear_hazard is held by Ship Super and Safety",
#            "capability":"clear_hazard","roles":["foreman"]; GET …/ledger unchanged

# 7. A Safety session clears it; the ledger names the person.
#    expect: 200; GET …/ledger → "verified":true and the newest entry has
#            "actor_id":"<your person id>", "actor_name":"<your name>", "chain_version":2

# 8. A dry run is open to anyone; the commit is not.
curl -s -o /dev/null -w '%{http_code}\n' -X POST -H 'content-type: application/json' -d @register.json \
  'https://yard-host/api/vessels/<hull>/register?dry_run=true'      # as a Reader session
#    expect: 200 (a preview); the same without ?dry_run=true → 403; nothing stored, no ledger row

# 9. The runnable checklist, through the proxy.
BASE=https://yard-host ORG=<pilot org uuid> VESSELS=<hull uuid> scripts/self-assessment.sh
#    expect: no FAIL; WADL-SA-05 PASS "proxy-asserted identity is armed";
#            WADL-SA-11 PASS "whoami names a person (<your person id>)"; no WARN

# 10. Idle past the proxy's timeout, then:
curl -s -o /dev/null -w '%{http_code}\n' https://yard-host/api/whoami
#    expect: the PIN challenge or 401 — never data
```

On the dev shim the same checklist reports WADL-SA-05 and WADL-SA-11 as WARN
(`dev shim person (dev:anonymous)`), which is POA&M items 1 and 6 and is the
expected reading on a developer's loopback.

## 9. Not in this contract

- A `person` row per proxy subject (`audit_entry.by_person uuid` stays
  reserved; `actor_id text` is the record until the pilot has a directory).
- Per-hull roles (`x-wadl-roles` is per session; `person_assignment` is per
  hull; the pilot is one hull).
- Session, logout and idle timeout — the proxy's (`deploy/README.md`).
- A request id on the audit line and in problem bodies (S16).

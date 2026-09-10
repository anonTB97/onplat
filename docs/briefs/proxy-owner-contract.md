# Brief for the yard's identity-proxy owner

The product does not authenticate anyone. CAC/PIV terminates at the yard's
accredited reverse proxy, and the proxy asserts who the caller is on one
private hop to a binary that binds loopback and holds no session. This brief
is what the proxy owner needs to implement that hop: the headers, their
formats, what the product does with each, what it refuses, the session and
timeout rules that live on the proxy because nothing lives on the binary,
the questions only the yard can settle, and a test the proxy owner runs
against a staging instance to prove the pairing. The three-header contract
is in the code today (`crates/wadl-api/src/auth.rs`, `deploy/README.md`);
the person and role headers are slice S12
(`docs/programme/s12-person-in-the-ledger.md`), which publishes the normative
`docs/identity-proxy-contract.md` when it lands. Every statement below says
which of the two it belongs to.

Sections: 1 the shape · 2 the headers · 3 what the product does with each ·
4 what it refuses · 5 sessions and timeouts · 6 header hygiene · 7 questions
to settle · 8 the staging test · 9 defaults until settled.

## 1. The shape

- One TCP listener, plain HTTP, `127.0.0.1:8080` by default (`WADL_BIND`
  widens it, and only in the unit file). TLS is the proxy's.
- The proxy sets the identity headers on every request it forwards, after
  authenticating the client, and adds a shared key that proves the request
  came through it. The binary compares the key in constant time before it
  reads any identity header.
- The binary is stateless per request. There is no login route, no cookie,
  no session store, no logout. A request without freshly asserted headers is
  an unauthenticated request.
- `GET /api/whoami` returns what the binary resolved from the headers — not
  an echo — so the pairing is verifiable with one call.

## 2. The headers

| Header | In code today | Required | Format | Refused when |
|---|---|---|---|---|
| `x-wadl-proxy-key` | yes | yes when `WADL_PROXY_KEY` is set (always, in the yard) | the shared secret, from the proxy's secret store | absent or not equal (constant-time compare) → 401 before identity is read |
| `x-org-id` | yes | yes | uuid; the pilot's one tenant | absent or not a uuid → 401 |
| `x-assigned-vessels` | yes | present, may be empty | comma-separated uuids of the hulls the person may see | never refused; an unparseable entry is dropped; a hull not listed is not-found (404) on every route |
| `x-wadl-person` | S12 | yes in proxy mode | `[A-Za-z0-9._:@/-]{1,128}`; the proxy's **stable** subject for the person (EDIPI from the certificate, or the badge number) | absent → 401 `"the proxy asserted no person (x-wadl-person)"`; outside the charset → 401 |
| `x-wadl-person-name` | S12 | no | percent-encoded UTF-8, ≤ 200 bytes on the wire, ≤ 120 characters decoded, no control characters | never refused: undecodable → the name falls back to the id and `whoami` carries a warning |
| `x-wadl-roles` | S12 | no | comma-separated role codes from the eight below; absent → `WADL_DEFAULT_ROLES` if the deployment sets it, else `reader` | never refused: unknown codes are ignored and reported in `whoami.warnings` |

Role codes (S12; the yard word in brackets): `planner` (Planner),
`ship_super` (Ship Super), `safety` (Safety), `zone_manager` (Zone Manager),
`production_super` (Production Super), `foreman` (Foreman),
`project_manager` (Project Manager), `reader` (Reader). Roles are per
session, not per hull; the pilot is one hull.

## 3. What the product does with each header

| Header | Used for | Where |
|---|---|---|
| `x-wadl-proxy-key` | the trust gate: nothing else is read until it matches | `auth.rs` `trust_gate`; `WADL_PROXY_KEY` in the unit's environment |
| `x-org-id` | the tenant of every read and write: `TenantScope.org`; on PostgreSQL it becomes `SET LOCAL app.org_id` and row-level security filters every tenant table by it (`docs/adr/0003`); it is the `org` field on every line of the HTTP audit stream | `auth.rs`; `wadl-store` `with_tenant`; `hardening.rs` `audited` |
| `x-assigned-vessels` | the hull list: `GET /api/vessels` lists only these; any other hull id is 404 on every route, indistinguishable from absent | `TenantScope.assigned_vessels`; `scoped_vessel` / `pg_get_vessel` |
| `x-wadl-person` | the person on every ledger row: hashed into the row's chain hash (chain format 2), served in `whoami.person.id`, shown in the ledger's **By** column, written as `person` on the audit line; it is the name a board of inquiry gets | S12: `TenantScope.actor`, `ledger.rs` v2, migration `0017_ledger_actor.sql`, `hardening.rs` |
| `x-wadl-person-name` | display only: the role button, the signed-in block, the ledger **By** column; stored beside the id on the row; never used to decide anything | S12 |
| `x-wadl-roles` | the capability set: each role maps to capabilities in one table (`roles.rs`); every write route is gated by capability (403 with a sentence naming who may); `whoami` serves roles, capabilities and the matrix; the shell greys the buttons the person may not use; a dry run is never gated | S12 |

Capabilities and who holds them (S12): `raise_hazard` (all but Reader and
Project Manager), `clear_hazard` (Ship Super, Safety), `commit_document`
(Planner), `propose` (Planner, Ship Super), `decide` (Planner, Ship Super,
Safety, Zone Manager, Production Super, Project Manager), `read` (everyone).
The yard signs this matrix; in particular who may **record a clearance** and
who may **commit a document** on data-load day.

## 4. What the product refuses

| Condition | Answer | Today / S12 |
|---|---|---|
| `WADL_PROXY_KEY` set to the empty string | the binary refuses to boot; there is no state in which an empty key admits anyone | today (`auth.rs` `proxy_key_is_empty`; `serve.rs` boot check) |
| No key or wrong key on a request | 401 `application/problem+json` before any identity header is read | today |
| Key present, `x-org-id` missing or not a uuid | 401 | today |
| Key present, org present, hull id not in `x-assigned-vessels` | 404, the same body as a hull that does not exist | today; WADL-SA-04 |
| Proxy mode, `x-wadl-person` absent | 401 with the detail sentence | S12 |
| `x-wadl-person` outside the charset (any mode) | 401 | S12 |
| Person present, role lacks the capability for a write route | 403 problem+json: `"Foreman may not record a clearance — clear_hazard is held by Safety and Ship Super"`, plus `capability` and `roles`; nothing is written, no ledger row | S12 |
| Same, on a hull the person is not assigned | 404 first; a capability is never judged on a hull the caller cannot see | S12 |
| `?dry_run=true` on any door | never refused for capability; anyone may preview | S12 |
| Request bodies over the ceiling | 413 at every route but the import doors; 256 MB there, after the scope check | today; WADL-SA-08 |
| Anything the binary cannot serve | `application/problem+json` with no SQL, path or stack detail | today; WADL-SA-09/10 |

Every refusal is a line in the HTTP audit stream (stdout → journal), at
least as loud as a success.

## 5. Sessions and timeouts — the proxy's share

The binary holds no session, so every lifetime rule is enforced on the proxy
and takes effect on the binary instantly. From `deploy/README.md` (AC-11 /
AC-12), the proxy configuration must carry, per site policy:

- **Idle timeout**, typically ≤ 15 minutes, and an **absolute session cap**,
  typically ≤ 12 hours; after either, re-authentication (PIN for CAC), no
  silent renewal.
- **Revocation checking** (OCSP or CRL) on every new session.
- On logout or timeout the proxy **stops asserting** the identity headers;
  there is nothing to invalidate on the binary.
- Verify: an idle session past the timeout gets the PIN challenge, not
  data; `/api/whoami` without a fresh session is 401.

The proxy's access log is the login record for the pilot (the binary logs
the asserted org and, after S12, the person on every `/api` line, but it
never sees the certificate). Its retention is the yard's, and the ATO
package cites it (`docs/ato-package.md` §3, AU-2).

## 6. Header hygiene

- **Strip all six headers from inbound client traffic** before setting the
  proxy's own values. Without the key a client-set identity header is refused
  anyway; stripping is the second layer.
- The key comes from the proxy's secret store, never from a config file
  checked into anything; rotation is a change to the unit's environment and
  the proxy's store at the same time (the binary reads the key once at
  boot, so rotation is a restart).
- `x-wadl-person-name` is bytes on the wire: percent-encode it. In nginx a
  `map` over `$ssl_client_s_dn_cn` is the usual way; any proxy that cannot
  percent-encode should omit the header and the ledger shows the id.
- Header size: keep the name under 200 bytes; the assigned-hull list is one
  uuid in the pilot.
- The binary never redirects to a login page and never sets a cookie; the
  proxy owns the browser's session entirely.

## 7. Questions to settle

Each with why it is the yard's and what the answer feeds.

| # | Question | Feeds |
|---|---|---|
| Q1 | **CAC/PIV → person id.** Which stable subject the terminator can assert: the EDIPI from the certificate's subject or SAN, or a badge number from the directory. It must be the same string for the same person across sessions and certificate renewals, because it is hashed into the ledger. | `x-wadl-person`; the PTA (`docs/ato-package.md`, A14) |
| Q2 | **Display name.** Can the proxy assert one (from the certificate CN or the directory), and percent-encode it? | `x-wadl-person-name` |
| Q3 | **Where hull assignment comes from.** A directory group per hull, a list the proxy owner maintains, or the product's `person_assignment` table (seeded in `pg_seed.sql`, read by nothing today). For the pilot: one hull, one uuid, asserted for every pilot user. | `x-assigned-vessels` |
| Q4 | **The org uuid.** One tenant for the pilot. Who mints it, and it must equal the organisation row the DBA bootstraps on PostgreSQL (`docs/pilot-playbook.md` §1) or every request is 401 or empty. | `x-org-id` |
| Q5 | **Roles.** Can the proxy map directory groups to the eight role codes; if not, the deployment sets `WADL_DEFAULT_ROLES` (S12; SSP-visible) and every pilot user gets that role. Who signs the group → role map. | `x-wadl-roles` |
| Q6 | **Key custody.** Where the key is stored on the proxy, who can read it, how it is rotated, and who is told when it is. | `x-wadl-proxy-key` |
| Q7 | **Timeouts.** The site's idle and absolute values, and the revocation source. | §5 |
| Q8 | **Whether person ids may appear on screen and in the ledger export.** The ledger is exported for `verify-ledger` and the evidence bundle; an EDIPI on it is a PII question for the ISSO. | the PTA; `WADL_MARKINGS` |
| Q9 | **Header limits and proxy behaviour on oversize values** (the proxy's own, before the binary's). | §6 |
| Q10 | **Staging.** A staging proxy in front of a staging binary, reachable by the proxy owner and the engineer, before the yard's PostgreSQL is connected. | §8 |

## 8. The staging test

Run by the proxy owner against a staging instance booted with
`WADL_PROXY_KEY` set, through the proxy, with a real CAC session. Every line
is pass/fail; the output is filed with the pilot record.

**Today's contract (three headers):**

```sh
# 1. Through the proxy, authenticated: the resolved scope, not an echo.
curl -s https://yard-host/api/whoami
#    expect: {"org":"<pilot org uuid>","assigned_vessels":["<hull uuid>"],"identity_mode":"proxy-asserted",…}

# 2. Straight at the binary's port from the proxy host, no key: refused before identity.
curl -s -o /dev/null -w '%{http_code}\n' -H "x-org-id: <pilot org uuid>" http://127.0.0.1:8080/api/vessels
#    expect: 401

# 3. Header laundering: a client-set org header must not survive the proxy.
curl -s -H "x-org-id: ffffffff-ffff-ffff-ffff-ffffffffffff" https://yard-host/api/whoami
#    expect: the pilot org uuid, not the client's value

# 4. A hull outside the assignment is absent, not forbidden.
curl -s -o /dev/null -w '%{http_code}\n' https://yard-host/api/vessels/ffffffff-ffff-ffff-ffff-ffffffffffff
#    expect: 404

# 5. The runnable checklist, through the proxy.
BASE=https://yard-host ORG=<pilot org uuid> VESSELS=<hull uuid> scripts/self-assessment.sh
#    expect: no FAIL; WADL-SA-05 PASS "proxy-asserted identity is armed"; no WARN
```

**After S12 (six headers), in addition:**

```sh
# 6. The person is resolved, named, and given roles and capabilities.
curl -s https://yard-host/api/whoami
#    expect: "person":{"id":"<EDIPI or badge>","name":"…","source":"proxy"}, "roles":[…], "capabilities":[…], "identity_mode":"proxy-asserted"

# 7. A session whose proxy asserts no person is refused.
#    (proxy owner: forward a request with x-wadl-person removed)
#    expect: 401, detail "the proxy asserted no person (x-wadl-person)"

# 8. A role without the capability is refused with a sentence and writes nothing.
#    as a Foreman session: POST https://yard-host/api/vessels/<hull>/hazards/clear with a live hazard's body
#    expect: 403, detail names the role and who holds clear_hazard; GET …/ledger unchanged

# 9. A Safety session clears it; the ledger names the person.
#    expect: 200; newest ledger entry actor_id = the person id, chain_version 2, verified true

# 10. Idle past the timeout, then:
curl -s -o /dev/null -w '%{http_code}\n' https://yard-host/api/whoami
#    expect: the PIN challenge or 401 — never data
```

WADL-SA-11 (S12) reports `whoami names a person` on the proxy-armed
instance; the self-assessment is re-run after S12 lands.

## 9. Defaults until settled

| Not settled | In force | Recorded where |
|---|---|---|
| Q1 person id (S12 not landed) | every ledger row is `unattributed`; `whoami` carries no person | the data-load record carries the person against every ledger seq (`docs/pilot-playbook.md` §8); a hard no-go line at week 4 |
| Q1 person id (S12 landed, proxy cannot assert one) | proxy mode refuses every request; the pilot cannot start | the charter's risk row: fall back to the mapped subject in `x-org-id`'s companion and log the gap in the POA&M |
| Q2 display name | the ledger and the chrome show the id | none needed |
| Q3 hull assignment | the proxy asserts the one pilot hull for every user | the header contract |
| Q5 roles | `WADL_DEFAULT_ROLES=planner` for everyone, which opens every door but `clear_hazard` to everyone; **or** `reader` for everyone, which closes every door | POA&M (POAM-6) and the SSP env line; the yard chooses which, in writing |
| Q7 timeouts | the deploy README's typical values | the proxy configuration, cited in the SSP (AC-11/12) |
| Q8 ids on screen | shown | the PTA decides; if refused, the shell shows the name only (a one-line change to the **By** column's title) |

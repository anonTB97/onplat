# Deploying Shipyard AI Onboard

One artifact, one unit file, one reverse proxy. The policy behind every choice
here is `docs/production-posture.md`; this page is just the hands-on order of
operations.

## Build the artifact

```sh
# The shell, content-hashed and minified:
cd shell-web && npm ci && npx vite build && cd ..
# The binary (release profile: thin LTO, one codegen unit, line tables kept).
# --features postgres compiles the production store in; without it the binary
# cannot open a database at all:
cargo build --locked --release -p wadl-api --bin serve --features postgres
```

Prepare the database once (`DATABASE_URL` set): `wadl migrate && wadl seed`
(or your own data load). At runtime, `DATABASE_URL` in the unit's environment
selects the PostgreSQL store — row-level security armed per request — and its
absence falls back to the in-memory demo world, which the startup banner
states plainly.

The deployable set is exactly two things: `target/release/serve` and
`shell-web/dist/`. Checksum both at build time and verify at install.

## Install

Follow the header of [`wadl.service`](./wadl.service) — binary and dist under
`/opt/wadl`, the unit into `/etc/systemd/system`, then
`systemctl enable --now wadl`. The unit runs the process as a transient
unprivileged user with a strict filesystem/`seccomp` sandbox; every directive
in it is load-bearing and the service runs with all of them on.

## Put the accredited terminator in front

The binary binds loopback and speaks plain HTTP on purpose: TLS and CAC/PIV
belong to the yard's existing accredited terminator (nginx, HAProxy, an
appliance). The contract between the proxy and the binary is six headers on
a private hop — the normative statement, formats, refusals and the staging
test are `docs/identity-proxy-contract.md`; this is the summary:

| Header | Set by | Meaning |
|---|---|---|
| `x-wadl-proxy-key` | proxy, from its secret store | proves the request came through the proxy (arms when `WADL_PROXY_KEY` is set; compared in constant time before anything else is read) |
| `x-org-id` | proxy, from the authenticated session | the caller's tenant |
| `x-assigned-vessels` | proxy, from the authenticated session | comma-separated hull assignments; any other hull is 404 |
| `x-wadl-person` | proxy, from the certificate or the directory | the person's **stable** subject (EDIPI or badge), `[A-Za-z0-9._:@/-]{1,128}`; required — hashed into every ledger row and shown in the ledger's By column |
| `x-wadl-person-name` | proxy, optional | display name, percent-encoded UTF-8; falls back to the id with a `whoami` warning |
| `x-wadl-roles` | proxy, from directory groups | comma-separated role codes (`planner ship_super safety zone_manager production_super foreman project_manager reader`); absent → `WADL_DEFAULT_ROLES`, else `reader` |

The proxy must **strip** all six headers from incoming client traffic before
setting its own values — standard header-laundering hygiene; without the key a
request's identity headers are refused anyway, which is the point of the key.

Two environment decisions belong in the unit file beside the key:
`WADL_DEFAULT_ROLES` (for a proxy that cannot map groups on day one — SSP
visible, and the binary refuses to boot on a code it does not know) and
`WADL_MARKINGS` (the `|`-separated handling markings the shell's band wears;
without them the band reads the prototype's own strings).

Verify the pairing end to end with one call:

```sh
curl -s https://yard-host/api/whoami   # via the proxy, authenticated
# → {"identity_mode":"proxy-asserted","person":{"id":"1234567890","name":"R. Alvarez","source":"proxy"},
#    "roles":["safety"],"capabilities":["read","raise_hazard","clear_hazard","decide"],"hulls":[…],…}
```

and, from the proxy host, the same hop by hand — the binary answers to the
headers, not to the shell:

```sh
curl -s -H "x-wadl-proxy-key: $KEY" -H "x-org-id: <org uuid>" -H "x-assigned-vessels: <hull uuid>" \
  -H "x-wadl-person: 1234567890" -H "x-wadl-person-name: R.%20Alvarez" -H "x-wadl-roles: foreman" \
  http://127.0.0.1:8080/api/whoami
# → "person":{"id":"1234567890","name":"R. Alvarez","source":"proxy"}, "roles":["foreman"], "capabilities":["read","raise_hazard"]
```

A role that lacks a door's capability is refused with a sentence — 403
`{"detail":"Foreman may not record a clearance — clear_hazard is held by Ship
Super and Safety","capability":"clear_hazard","roles":["foreman"]}` — and
nothing is written; a `?dry_run=true` preview is never refused.

## Session lifetime (AC-11 / AC-12 — the terminator's share)

The binary is stateless per request: it holds no session, so every lifetime
rule is enforced where the session actually lives — at the CAC terminator or
identity broker — and takes effect here instantly, because a request without
freshly asserted identity headers is just an unauthenticated request. The
proxy configuration must carry, per site policy:

- **Idle timeout** (typically ≤ 15 min) and an **absolute session cap**
  (typically ≤ 12 h), after which re-authentication (PIN for CAC) is
  required — no silent renewal.
- **Certificate revocation checking** (OCSP/CRL) on every new session, so a
  revoked credential stops asserting identity at the next handshake.
- On logout or timeout, the proxy stops asserting the identity headers;
  there is nothing to invalidate server-side.

Verify after configuring: an idle session past the timeout must get the
login/PIN challenge, not data; `/api/whoami` without a fresh session must
be 401.

## Run the self-assessment

`scripts/self-assessment.sh` is the runnable STIG-style checklist — the same
script CI runs against every build. Point it at the deployed instance
(through the proxy, authenticated) and read the verdicts; WARNs cite the
`docs/poam.md` entry they correspond to:

```sh
BASE=https://yard-host ORG=<org-uuid> VESSELS=<hull-uuid,…> \
  scripts/self-assessment.sh
```

In production, WADL-SA-05 must report `proxy-asserted` and WADL-SA-11 must
report `whoami names a person` — a `dev header shim` or `dev shim person`
WARN on a reachable instance is POA&M items 1 and 6 and blocks exposure.

## Watch it run

The audit stream is one JSON object per request on stdout, which the unit
sends to the journal:

```sh
journalctl -u wadl -o cat | jq 'select(.audit=="http" and .status>=400)'
```

Refusals (401/403/404/413/422/503) are logged as loudly as successes — a
quiet log under attack is the failure mode. Every `/api` line carries the
asserted `org` and `person` (`-` when absent), so the journal is the login
record's companion: who asked, for what, and what the binary answered. Backend errors appear on stderr as
`{"event":"backend_error",…}` lines.

## Stop it

`systemctl stop wadl` sends SIGTERM; the process drains in-flight requests
before exiting, so a deploy never truncates an import mid-commit.

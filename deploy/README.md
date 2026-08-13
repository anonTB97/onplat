# Deploying Shipyard AI Onboard

One artifact, one unit file, one reverse proxy. The policy behind every choice
here is `docs/production-posture.md`; this page is just the hands-on order of
operations.

## Build the artifact

```sh
# The shell, content-hashed and minified:
cd shell-web && npm ci && npx vite build && cd ..
# The binary (release profile: thin LTO, one codegen unit, line tables kept):
cargo build --locked --release -p wadl-api --bin serve
```

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
appliance). The contract between the proxy and the binary is three headers on
a private hop:

| Header | Set by | Meaning |
|---|---|---|
| `x-wadl-proxy-key` | proxy, from its secret store | proves the request came through the proxy (arms when `WADL_PROXY_KEY` is set) |
| `x-org-id` | proxy, from the authenticated session | the caller's tenant |
| `x-assigned-vessels` | proxy, from the authenticated session | comma-separated hull assignments |

The proxy must **strip** all three headers from incoming client traffic before
setting its own values — standard header-laundering hygiene; without the key a
request's identity headers are refused anyway, which is the point of the key.

Verify the pairing end to end with one call:

```sh
curl -s https://yard-host/api/whoami   # via the proxy, authenticated
# → {"org":"…","assigned_vessels":[…],"identity_mode":"proxy-asserted",…}
```

## Watch it run

The audit stream is one JSON object per request on stdout, which the unit
sends to the journal:

```sh
journalctl -u wadl -o cat | jq 'select(.audit=="http" and .status>=400)'
```

Refusals (401/404/413/422/503) are logged as loudly as successes — a quiet
log under attack is the failure mode. Backend errors appear on stderr as
`{"event":"backend_error",…}` lines.

## Stop it

`systemctl stop wadl` sends SIGTERM; the process drains in-flight requests
before exiting, so a deploy never truncates an import mid-commit.

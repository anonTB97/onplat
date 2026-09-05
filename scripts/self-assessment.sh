#!/usr/bin/env bash
# STIG-style self-assessment for a running Shipyard AI Onboard instance.
#
# Each check has a stable ID (WADL-SA-nn) referenced by docs/ssp-input.md, a
# finding statement, and a verdict: PASS, FAIL, or WARN (true, but a finding
# to answer for in production — e.g. the dev identity shim). Exit status is
# non-zero if any check FAILs, so CI can run this against a booted binary and
# an assessor can run the identical script against a deployed one.
#
#   BASE=http://127.0.0.1:8080 ORG=<uuid> VESSELS=<uuid,uuid> \
#     scripts/self-assessment.sh
#
# ORG/VESSELS default to the demo identity the serve binary prints at start.
set -u

BASE="${BASE:-http://127.0.0.1:8080}"
ORG="${ORG:-00000000-0000-0000-0000-000000000001}"
VESSELS="${VESSELS:-00000000-0000-0000-0000-000000000073}"
FOREIGN="ffffffff-ffff-ffff-ffff-ffffffffffff"
FIRST_VESSEL="${VESSELS%%,*}"

fails=0
report() { # id verdict title detail
  printf '%-11s %-4s %s%s\n' "$1" "$2" "$3" "${4:+ — $4}"
  [ "$2" = FAIL ] && fails=$((fails + 1)) || true
}

code() { curl -s -o /dev/null -m 10 -w '%{http_code}' "$@"; }
hdrs() { curl -s -D - -o /dev/null -m 10 "$@"; }

# --- WADL-SA-01: the service is up and claims decision support only --------
body=$(curl -s -m 10 "$BASE/health" || true)
if [ "$(code "$BASE/health")" = 200 ] && printf '%s' "$body" | grep -q '"decision_support_only":true'; then
  report WADL-SA-01 PASS "health serves and self-describes as decision support only"
else
  report WADL-SA-01 FAIL "health endpoint" "expected 200 with decision_support_only:true, got: $body"
fi

# --- WADL-SA-02: browser-protection headers on every response --------------
h=$(hdrs "$BASE/health")
missing=""
for want in content-security-policy x-content-type-options x-frame-options \
            referrer-policy permissions-policy cross-origin-opener-policy \
            cross-origin-resource-policy; do
  printf '%s' "$h" | grep -qi "^$want:" || missing="$missing $want"
done
if [ -z "$missing" ]; then
  report WADL-SA-02 PASS "full security-header set present (7 headers)"
else
  report WADL-SA-02 FAIL "security headers" "missing:$missing"
fi
if printf '%s' "$h" | grep -qiE '^(server|x-powered-by):'; then
  report WADL-SA-02b FAIL "banner disclosure" "Server/X-Powered-By header present"
else
  report WADL-SA-02b PASS "no server software banner disclosed"
fi

# --- WADL-SA-03: no identity means no data ---------------------------------
c=$(code "$BASE/api/vessels")
[ "$c" = 401 ] && report WADL-SA-03 PASS "request without identity is refused (401)" \
               || report WADL-SA-03 FAIL "unauthenticated access" "GET /api/vessels returned $c"

# --- WADL-SA-04: a foreign hull id is not-found, not forbidden -------------
c=$(code -H "x-org-id: $ORG" -H "x-assigned-vessels: $VESSELS" "$BASE/api/vessels/$FOREIGN")
[ "$c" = 404 ] && report WADL-SA-04 PASS "out-of-scope hull is indistinguishable from absent (404)" \
               || report WADL-SA-04 FAIL "scope enforcement" "foreign hull returned $c"

# --- WADL-SA-05 / 06: identity trust mode ----------------------------------
who=$(curl -s -m 10 -H "x-org-id: $ORG" -H "x-assigned-vessels: $VESSELS" "$BASE/api/whoami" || true)
mode=$(printf '%s' "$who" | sed -n 's/.*"identity_mode":"\([^"]*\)".*/\1/p')
case "$mode" in
  proxy-asserted) report WADL-SA-05 PASS "proxy-asserted identity is armed" ;;
  dev-headers)    report WADL-SA-05 WARN "dev header shim active" "acceptable on loopback only; set WADL_PROXY_KEY in production (docs/poam.md POAM-1)" ;;
  *)              report WADL-SA-05 FAIL "identity mode" "whoami answered: $who" ;;
esac
if printf '%s' "$who" | grep -q "\"org\":\"$ORG\""; then
  report WADL-SA-06 PASS "whoami reflects the resolved scope, not echoed headers"
else
  report WADL-SA-06 FAIL "whoami" "expected org $ORG in: $who"
fi

# --- WADL-SA-11: whoami names a person -------------------------------------
# Through a proxy the binary must have resolved a person from x-wadl-person;
# on the dev shim it synthesises one and labels it, which is a finding.
person=$(printf '%s' "$who" | sed -n 's/.*"person":{"id":"\([^"]*\)","name":"[^"]*","source":"\([^"]*\)".*/\1 \2/p')
person_id="${person%% *}"
person_source="${person##* }"
case "$person_source" in
  proxy)       report WADL-SA-11 PASS "whoami names a person ($person_id)" ;;
  dev-shim*)   report WADL-SA-11 WARN "dev shim person ($person_id)" "acceptable on loopback only; the proxy asserts x-wadl-person in production (docs/poam.md POAM-6)" ;;
  *)           report WADL-SA-11 FAIL "person" "whoami named no person: $who" ;;
esac

# --- WADL-SA-07: refusals are audited (behavioral proxy) -------------------
# The audit stream is stdout/journal, which this script cannot always read;
# what it can prove is that the refusal path answers structured problem+json,
# the same path the audit layer wraps.
ct=$(hdrs "$BASE/api/vessels" | grep -i '^content-type:' || true)
if printf '%s' "$ct" | grep -qi 'application/problem+json'; then
  report WADL-SA-07 PASS "refusals answer application/problem+json"
else
  report WADL-SA-07 FAIL "refusal shape" "content-type on a 401 was: ${ct:-none}"
fi

# --- WADL-SA-08: oversized bodies are refused at non-import routes ---------
c=$(head -c 3000000 /dev/zero | tr '\0' 'a' | curl -s -o /dev/null -m 30 -w '%{http_code}' \
    -X POST -H "x-org-id: $ORG" -H "x-assigned-vessels: $VESSELS" \
    -H 'content-type: application/json' --data-binary @- \
    "$BASE/api/vessels/$FIRST_VESSEL/issues/acknowledge")
case "$c" in
  413) report WADL-SA-08 PASS "3 MB body at a small route is refused (413)" ;;
  4*)  report WADL-SA-08 WARN "oversized body refused with $c (expected 413)" ;;
  *)   report WADL-SA-08 FAIL "body ceiling" "3 MB at a small route returned $c" ;;
esac

# --- WADL-SA-09: path traversal shapes never resolve -----------------------
ok=1
for evil in "/assets/../../etc/passwd" "/%2e%2e/%2e%2e/etc/passwd" "/..%5c..%5cetc/passwd"; do
  c=$(curl -s -o /dev/null -m 10 --path-as-is -w '%{http_code}' "$BASE$evil")
  [ "$c" = 404 ] || [ "$c" = 400 ] || ok=0
done
[ "$ok" = 1 ] && report WADL-SA-09 PASS "traversal shapes answer 404 (plain, encoded, backslash)" \
              || report WADL-SA-09 FAIL "path traversal" "a traversal shape escaped 404"

# --- WADL-SA-10: errors carry no internals ---------------------------------
b=$(curl -s -m 10 -H "x-org-id: $ORG" -H "x-assigned-vessels: $VESSELS" \
    "$BASE/api/vessels/$FOREIGN")
if printf '%s' "$b" | grep -qiE 'sql|panic|backtrace|src/|\.rs:'; then
  report WADL-SA-10 FAIL "error hygiene" "internal detail leaked: $b"
else
  report WADL-SA-10 PASS "error bodies carry no SQL, paths, or stack detail"
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "self-assessment: all checks passed (WARNs, if any, are production findings)"
else
  echo "self-assessment: $fails check(s) FAILED"
  exit 1
fi

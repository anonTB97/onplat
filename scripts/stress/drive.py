#!/usr/bin/env python3
"""The stress driver: import the scaled schedule, then measure the API.

Phases (each prints a markdown-ready row):
  1. import      — POST the XER through the door, dry-run then commit, timed.
  2. latency     — sequential p50/p95 per hot endpoint, with payload sizes.
  3. concurrency — N workers hammering the two heaviest reads for a fixed
                   wall-time; throughput and error count.
  4. shed        — with WADL_MAX_IN_FLIGHT set low by the harness, prove the
                   semaphore refuses cleanly (503s, no hangs, no 5xx noise).

Stdlib only (urllib + threads), so the harness runs anywhere the repo does.

Usage: drive.py <base_url> <vessel_id> <xer_path> [phase...]
"""

import json
import statistics
import sys
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor

BASE = sys.argv[1]
VESSEL = sys.argv[2]
XER = sys.argv[3]
PHASES = set(sys.argv[4:]) or {"import", "latency", "concurrency", "shed"}

HEADERS = {
    "x-org-id": "00000000-0000-0000-0000-000000000001",
    "x-assigned-vessels": "00000000-0000-0000-0000-000000000073",
}


def req(method: str, path: str, body: bytes | None = None, timeout: float = 300.0):
    r = urllib.request.Request(
        f"{BASE}{path}",
        data=body,
        method=method,
        headers={**HEADERS, **({"content-type": "application/json"} if body else {})},
    )
    t0 = time.perf_counter()
    try:
        with urllib.request.urlopen(r, timeout=timeout) as resp:
            payload = resp.read()
            return resp.status, time.perf_counter() - t0, len(payload), payload
    except urllib.error.HTTPError as e:
        payload = e.read()
        return e.code, time.perf_counter() - t0, len(payload), payload


def mb(n: int) -> str:
    return f"{n / 1_048_576:.1f} MB" if n >= 1_048_576 else f"{n / 1024:.0f} KB"


if "import" in PHASES:
    xer_text = open(XER, encoding="utf-8", errors="replace").read()
    body = json.dumps({"label": "stress-40k.xer", "xer": xer_text}).encode()
    print(f"import body: {mb(len(body))}")
    st, dt, size, payload = req(
        "POST", f"/api/vessels/{VESSEL}/schedule-of-record?dry_run=true", body
    )
    doc = json.loads(payload)
    print(
        f"| import dry-run | {st} | {dt:.2f}s | activities {doc.get('activities')} "
        f"| refused {len(doc.get('refusals', []))} |"
    )
    st, dt, size, payload = req("POST", f"/api/vessels/{VESSEL}/schedule-of-record", body)
    doc = json.loads(payload)
    print(f"| import commit | {st} | {dt:.2f}s | activities {doc.get('activities')} |")

ENDPOINTS = [
    ("activities", f"/api/vessels/{VESSEL}/activities"),
    ("deck-states", f"/api/vessels/{VESSEL}/deck-states"),
    ("work-conflicts", f"/api/vessels/{VESSEL}/work-conflicts"),
    ("readiness", f"/api/vessels/{VESSEL}/readiness"),
    ("issues", f"/api/vessels/{VESSEL}/issues"),
    ("schedule-alternatives", f"/api/vessels/{VESSEL}/schedule-alternatives"),
    ("work-orders", f"/api/vessels/{VESSEL}/work-orders"),
    ("leverage", f"/api/vessels/{VESSEL}/leverage"),
    ("compartments", f"/api/vessels/{VESSEL}/compartments"),
    ("packages", f"/api/vessels/{VESSEL}/packages"),
]

if "latency" in PHASES:
    print("\n| endpoint | p50 | p95 | worst | payload | status |")
    print("|---|---|---|---|---|---|")
    for name, path in ENDPOINTS:
        times, sizes, status = [], 0, 200
        for _ in range(12):
            st, dt, size, _ = req("GET", path)
            times.append(dt)
            sizes = size
            status = st
        times.sort()
        p50 = statistics.median(times)
        p95 = times[int(len(times) * 0.95) - 1]
        print(
            f"| {name} | {p50 * 1000:.0f} ms | {p95 * 1000:.0f} ms "
            f"| {times[-1] * 1000:.0f} ms | {mb(sizes)} | {status} |"
        )

if "concurrency" in PHASES:
    WORKERS, SECONDS = 64, 12
    hot = [ENDPOINTS[0][1], ENDPOINTS[1][1]]
    stop_at = time.perf_counter() + SECONDS
    results: list[tuple[int, float]] = []

    def worker(i: int) -> None:
        n = 0
        while time.perf_counter() < stop_at:
            st, dt, _, _ = req("GET", hot[(i + n) % 2])
            results.append((st, dt))
            n += 1

    with ThreadPoolExecutor(max_workers=WORKERS) as ex:
        list(ex.map(worker, range(WORKERS)))
    ok = sum(1 for st, _ in results if st == 200)
    errs = [st for st, _ in results if st != 200]
    lat = sorted(dt for _, dt in results)
    print(
        f"\n| concurrency {WORKERS}w×{SECONDS}s | {len(results)} reqs "
        f"| {len(results) / SECONDS:.0f} rps | p50 {lat[len(lat) // 2] * 1000:.0f} ms "
        f"| p95 {lat[int(len(lat) * 0.95)] * 1000:.0f} ms | non-200: {len(errs)} |"
    )

if "shed" in PHASES:
    # The harness boots this phase's server with WADL_MAX_IN_FLIGHT=4: with 32
    # workers on the slowest endpoint, most must be refused 503 — cleanly, not
    # by hanging. Proves the mechanism without needing 512 live sockets.
    codes: list[int] = []

    def one(_: int) -> None:
        st, _, _, _ = req("GET", ENDPOINTS[0][1], timeout=120)
        codes.append(st)

    with ThreadPoolExecutor(max_workers=32) as ex:
        list(ex.map(one, range(64)))
    shed = sum(1 for c in codes if c == 503)
    served = sum(1 for c in codes if c == 200)
    other = [c for c in codes if c not in (200, 503)]
    print(f"\n| shed (cap 4, 32 workers) | served {served} | shed 503 {shed} | other {other} |")

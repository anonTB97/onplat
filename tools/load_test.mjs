#!/usr/bin/env node
// The load harness behind docs/stress-test.md and
// docs/council/3-data-and-performance.md: per-endpoint p50/p95 at 1 and at
// N concurrent clients, the schedule-of-record door timed, a hazard clear
// timed while readers are in flight, and the run-to-run diff — against a
// running `serve`, memory or PostgreSQL store alike. Node's own http and
// zlib only (no dependency; the repo's posture, docs/production-posture.md
// Pillar 1). Prints markdown rows so the numbers paste into the documents.
//
// Usage:
//   node tools/load_test.mjs [--base URL] [--vessel UUID] [--org UUID]
//       [--conc 1,10] [--samples 8] [--xer path] [--as-of ms]
//       [--clear COMPARTMENT:KIND] [--only ep,ep] [--timeout ms]
//       phase...
// Phases: latency (default), import, clear, diff, all.
//
// The identity is the dev shim's (x-org-id / x-assigned-vessels), as
// scripts/stress/drive.py sends it; behind a proxy set WADL_LOAD_HEADERS to
// a JSON object of extra headers (the proxy key and person).

import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import { performance } from "node:perf_hooks";

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : dflt;
};
const BASE = new URL(opt("base", "http://127.0.0.1:8080"));
const VESSEL = opt("vessel", "00000000-0000-0000-0000-000000000073");
const ORG = opt("org", "00000000-0000-0000-0000-000000000001");
const CONC = opt("conc", "1,10").split(",").map(Number);
const SAMPLES = Number(opt("samples", "8"));
const XER = opt("xer", null);
const AS_OF = opt("as-of", null);
const CLEAR = opt("clear", null);
const ONLY = opt("only", null)?.split(",") ?? null;
const TIMEOUT = Number(opt("timeout", "120000"));
const PHASES = new Set(args.filter((a, i) => !a.startsWith("--") && (i === 0 || !args[i - 1].startsWith("--"))));
if (PHASES.size === 0 || PHASES.has("all")) ["latency", ...(PHASES.has("all") ? ["import", "clear", "diff"] : [])].forEach((p) => PHASES.add(p));

const EXTRA = process.env.WADL_LOAD_HEADERS ? JSON.parse(process.env.WADL_LOAD_HEADERS) : {};
const HEADERS = {
  "x-org-id": ORG,
  "x-assigned-vessels": VESSEL,
  "accept-encoding": "gzip",
  ...EXTRA,
};
const agent = new http.Agent({ keepAlive: true, maxSockets: 64 });

const withAsOf = (path) => (AS_OF ? `${path}${path.includes("?") ? "&" : "?"}as_of=${AS_OF}` : path);

/** One request: status, seconds, wire bytes, decoded body (Buffer). */
function req(method, path, body) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const r = http.request(
      { agent, hostname: BASE.hostname, port: BASE.port, path, method, headers: { ...HEADERS, ...(body ? { "content-type": "application/json", "content-length": Buffer.byteLength(body) } : {}) }, timeout: TIMEOUT },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const wire = Buffer.concat(chunks);
          const decoded = res.headers["content-encoding"] === "gzip" ? zlib.gunzipSync(wire) : wire;
          resolve({ status: res.statusCode, secs: (performance.now() - t0) / 1000, wire: wire.length, bytes: decoded.length, body: decoded });
        });
      },
    );
    r.on("timeout", () => r.destroy(new Error("timeout")));
    r.on("error", (e) => resolve({ status: 0, secs: (performance.now() - t0) / 1000, wire: 0, bytes: 0, body: Buffer.from(String(e)) }));
    if (body) r.write(body);
    r.end();
  });
}

const pct = (sorted, p) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))];
const ms = (s) => `${Math.round(s * 1000)} ms`;
const size = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`);

/** `n` requests to `path` with `conc` in flight at once. */
async function hammer(path, n, conc) {
  const out = [];
  let next = 0;
  const worker = async () => {
    while (next < n) {
      next += 1;
      out.push(await req("GET", path));
    }
  };
  const t0 = performance.now();
  await Promise.all(Array.from({ length: conc }, worker));
  const wall = (performance.now() - t0) / 1000;
  const ok = out.filter((r) => r.status === 200);
  const lat = out.map((r) => r.secs).sort((a, b) => a - b);
  return { n: out.length, ok: ok.length, non200: out.filter((r) => r.status !== 200).map((r) => r.status), p50: pct(lat, 0.5), p95: pct(lat, 0.95), max: lat[lat.length - 1], wall, rps: out.length / wall, wire: ok[0]?.wire ?? 0, bytes: ok[0]?.bytes ?? 0 };
}

const V = `/api/vessels/${VESSEL}`;
const ENDPOINTS = [
  ["deck-states", withAsOf(`${V}/deck-states`)],
  ["readiness", withAsOf(`${V}/readiness`)],
  ["compartments", `${V}/compartments`],
  ["compartment state", withAsOf(`${V}/compartments/4-116-0-E/state`)],
  ["zones/Z4/adjacent", withAsOf(`${V}/zones/Z4/adjacent`)],
  ["hazards", withAsOf(`${V}/hazards`)],
  ["activities", withAsOf(`${V}/activities`)],
  ["work-conflicts", withAsOf(`${V}/work-conflicts`)],
  ["issues", withAsOf(`${V}/issues`)],
  ["leverage", withAsOf(`${V}/leverage`)],
  ["schedule-alternatives", withAsOf(`${V}/schedule-alternatives`)],
  ["ledger", `${V}/ledger`],
  ["schedule-runs", `${V}/schedule-runs`],
];

async function latency() {
  const eps = ENDPOINTS.filter(([name]) => !ONLY || ONLY.includes(name));
  console.log(`\n### Latency (${SAMPLES} samples per endpoint per level; clients ${CONC.join(", ")})\n`);
  console.log(`| endpoint | clients | p50 | p95 | max | rps | payload (wire / raw) | non-200 |`);
  console.log(`|---|---|---|---|---|---|---|---|`);
  for (const [name, path] of eps) {
    for (const conc of CONC) {
      const r = await hammer(path, Math.max(SAMPLES, conc), conc);
      console.log(`| ${name} | ${conc} | ${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.max)} | ${r.rps.toFixed(1)} | ${size(r.wire)} / ${size(r.bytes)} | ${r.non200.length ? r.non200.join(",") : "0"} |`);
    }
  }
}

async function importDoor() {
  if (!XER) {
    console.log("\n(import: no --xer given, skipped)");
    return;
  }
  const xer = fs.readFileSync(XER, "utf8");
  const body = JSON.stringify({ label: XER.split("/").pop(), xer });
  console.log(`\n### Schedule-of-record door (body ${size(Buffer.byteLength(body))})\n`);
  console.log(`| phase | status | time | activities |`);
  console.log(`|---|---|---|---|`);
  const dry = await req("POST", `${V}/schedule-of-record?dry_run=true`, body);
  const dj = dry.status === 200 ? JSON.parse(dry.body) : {};
  console.log(`| dry run | ${dry.status} | ${ms(dry.secs)} | ${dj.activities ?? "-"} |`);
  const commit = await req("POST", `${V}/schedule-of-record`, body);
  const cj = commit.status === 200 ? JSON.parse(commit.body) : {};
  console.log(`| commit | ${commit.status} | ${ms(commit.secs)} | ${cj.activities ?? "-"} |`);
}

async function clearDuringReads() {
  const [compartment, kind] = (CLEAR ?? "").split(":");
  if (!compartment || !kind) {
    console.log("\n(clear: no --clear COMPARTMENT:KIND given, skipped)");
    return;
  }
  const conc = Math.max(...CONC);
  console.log(`\n### Hazard clear with ${conc} deck-states readers in flight\n`);
  const readers = hammer(withAsOf(`${V}/deck-states`), conc * 3, conc);
  await new Promise((r) => setTimeout(r, 200));
  const clear = await req("POST", `${V}/hazards/clear`, JSON.stringify({ compartment, kind, basis: "load test: verified clear by the harness" }));
  const r = await readers;
  console.log(`| what | value |\n|---|---|`);
  console.log(`| POST hazards/clear ${compartment} ${kind} | ${clear.status} in ${ms(clear.secs)} |`);
  console.log(`| deck-states readers during the clear | ${r.n} reads, p50 ${ms(r.p50)}, p95 ${ms(r.p95)}, non-200 ${r.non200.length} |`);
}

async function diff() {
  const runs = await req("GET", `${V}/schedule-runs`);
  if (runs.status !== 200) {
    console.log(`\n(diff: schedule-runs → ${runs.status}, skipped)`);
    return;
  }
  const list = JSON.parse(runs.body);
  const rows = Array.isArray(list) ? list : (list.runs ?? []);
  if (rows.length < 2) {
    console.log(`\n(diff: ${rows.length} run(s) on the hull; run the import phase first)`);
    return;
  }
  const [a, b] = rows;
  console.log(`\n### schedule-runs/diff (run #${a.seq ?? "?"} against #${b.seq ?? "?"})\n`);
  console.log(`| clients | p50 | p95 | max | non-200 |\n|---|---|---|---|---|`);
  for (const conc of CONC) {
    const r = await hammer(`${V}/schedule-runs/diff?run=${a.run_id}&against=${b.run_id}`, Math.max(SAMPLES, conc), conc);
    console.log(`| ${conc} | ${ms(r.p50)} | ${ms(r.p95)} | ${ms(r.max)} | ${r.non200.length ? r.non200.join(",") : "0"} |`);
  }
}

const order = ["import", "latency", "clear", "diff"];
for (const phase of order) {
  if (!PHASES.has(phase)) continue;
  if (phase === "latency") await latency();
  if (phase === "import") await importDoor();
  if (phase === "clear") await clearDuringReads();
  if (phase === "diff") await diff();
}
agent.destroy();

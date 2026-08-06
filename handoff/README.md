# Shipyard AI Onboard + WADL — prototype repository

## What this repo is

A working prototype of an operational planning and work-authorization platform
for naval shipyards. Two products, one system:

- **Shipyard AI Onboard** — the planning and operating shell. Daily Ops, Deck
  Explorer, Sequence Board, Conflicts & Risk, Work Orders, Distributed Packages,
  Deconfliction Cascade, Configuration & History.
- **WADL** (Work Authorization Deconfliction Layer) — the compartment-level
  safety and quality authorization engine underneath it, with a field app and a
  console.

## Repository layout

```
/reference/            The HTML prototypes. READ THESE FIRST.
  Shipyard Onboard Shell.dc.html      the planning shell
  WADL Field App.dc.html              the phone surface
  WADL Console.dc.html                the desk surface
  shipyard-context.js                 shared vessel/persona context
  wadl-config.js                      rule anchors and standards config
  assets/                             deck drawings, logo, radiograph
/docs/                 Specifications. Read in this order.
  01-index-and-delivery-plan.pdf       the document set, epics, NFRs, glossary
  02-platform-data-model.pdf           tenancy, class/hull, rules-as-data
  03-rule-engine.pdf                  the core algorithm
  07-architecture-and-deployment.pdf  service boundaries, sovereignty
  09-offline-sync.pdf                 re-check never replay
  10-security-and-rbac.pdf            capability model, ledger
  steering-pack.pdf                   rule table, taxonomy, 20 scenarios
/handoff/
  01-rule-table.csv                   R01–R23 as rows
  02-standards-registry-seed.csv
  03-p6-field-crosswalk.csv
  04-platform-schema.sql              PostgreSQL DDL
  BUILD-PROMPT-shell.md               paste this into your coding agent
/src/                  Implementation. Empty until milestone 1.
```

## The prototypes are the specification of intent

Where a written spec and the HTML prototype disagree, **the prototype is the
more reliable statement of what was meant** — it was built by iterating on the
actual interaction, and it has been exercised. Where the prototype and the specs
agree, that behaviour is settled. Where the specs mark something as an open
question, it is genuinely unresolved and must not be guessed.

The prototypes are Design Components (`.dc.html`). Open one directly in a
browser to run it. They are single-file React-ish documents with an inline
template and a logic class — read them as behaviour references, not as code to
port.

## Language

**Rust.** The engine, the backend, the CLI and the ingest path are Rust; see
`handoff/BUILD-PROMPT-shell.md` for the crate layout, the enforced lint set and
the testing standard. `wadl-engine` is a pure crate with no I/O and no time
source, compiled to native for the server, to wasm32 for the browser, and via
UniFFI for mobile — so every surface runs the same decision code.

## Non-negotiables

Five invariants. Each is cheap to honour now and a rewrite to retrofit:

1. **The rule engine is a library, not a service.** A suspension must commit in
   the same database transaction as the hazard that caused it. The same engine
   build runs on the server and in the field client.
2. **Rules are versioned data.** No threshold, hold time or hop limit in code.
   Every decision stores the `rule_version_id` that produced it.
3. **Never grant offline.** A device may stop work and may record anything. Only
   the server grants. Queued actions are re-evaluated at sync, never replayed.
4. **Nothing is deleted.** Supersession is a state. The audit ledger is
   append-only and hash-chained.
5. **Class holds the template, hull holds the truth.** Compartments, adjacency
   and drawings are authored per ship class; per-hull divergence is a delta.

## Where to start

Read `handoff/BUILD-PROMPT-shell.md` and paste it into your coding agent.

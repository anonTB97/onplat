# Reference — the behaviour specification of intent

Per `handoff/README.md`: **where a written spec and the prototype disagree, the
prototype is the more reliable statement of what was meant.** Read these first.

## What's here

The original deliverable is a single-file "Design Component" bundle
(`Shipyard AI Onboard.html`, ~18 MB) whose payload is packed into a
`__bundler/*` manifest with every asset inlined as base64. That bundle is not
committed — 18 MB of embedded PNGs is not source. Instead its two source
artefacts are extracted here verbatim:

| File | What it is |
| --- | --- |
| `shipyard-onboard-shell.template.html` | The inline view template. A custom DSL: `{{ expr }}` interpolation, `<sc-if>` / `<sc-for>` control flow, `sc-camel-on-click` handlers. |
| `shipyard-onboard-shell.logic.js` | The `Component extends DCLogic` class — all state, seed data, and the derivation methods each view reads (`dpVals`, `csVals`, stranded-hours, cascade, …). |

These are **behaviour references, not code to port.** The prototype is a
single-file document; its structure is not the architecture. Read it to settle
questions of layout, density, interaction, copy, and — most usefully — the seed
data and the exact shape of derived numbers (e.g. how stranded man-hours are
computed in `logic.js`).

## How the Rust build uses it

Seed data in `crates/wadl-store` (once populated) and the acceptance scenarios
mirror the vessels, personas, decks, compartments, work orders and coupling
relationships defined in `logic.js`, so the running system tells the same story
the prototype does.

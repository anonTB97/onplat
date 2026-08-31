# Geometry accuracy: how a compartment gets a true position

Status: design + first layer implemented (surveyed geometry register).
Owner: the deck views and every rollup keyed on where a space is.

## The problem, stated against what the tool does today

Every board that draws a ship draws the same guess:

- **Fore-and-aft** — the frame station is parsed out of the placard number
  (`3-148-2-E` → frame 148) and mapped to plate pixels through a single
  linear fit per plate (`pxPerFrame`, `frame0X`). Two errors hide here: the
  placard frame is the compartment's **forward boundary**, not its centre,
  and we draw it as a point — a 60-foot machinery room and a 8-foot fan room
  render identically; and a linear fit cannot absorb scan skew, so residual
  error varies along the plate and is measured nowhere.
- **Athwartships** — the number's third digit is reduced to port/starboard
  parity and the pin is placed at 45% of the measured local half-beam.
  `deckSheets.ts` says it plainly: "a legible placement, not a position."
  The digit's actual meaning — the Nth compartment outboard of centreline —
  is discarded, and no source of true offsets exists in the system.
- **Vertically** — decks are ordinals. Nothing records where a deck
  physically exists, so a platform that only runs frames 60–180 is treated
  as spanning the hull, and "the space directly above" is ordinal
  arithmetic that silently crosses gaps where the intermediate deck is not
  there at all.

The saving grace, and the foundation this design builds on: the tool
already grades geometry (`geometry_source: register | parsed | unknown`)
and already refuses to invent a position when the number will not parse.
Accuracy here is not a rendering project — it is a **data provenance
project**, the same shape as every other truth in this codebase.

## The coordinate system is the ship's own

A ship carries its own datum, and everything below commits to it:

- **Longitudinal**: the frame number. Frames are physical, numbered
  stations (CVN-68 class: 4-ft spacing); every drawing, placard and work
  document speaks in them. Pixels are presentation; frames are truth.
- **Transverse**: offset from centreline, signed (port negative by
  convention), in feet — with the placard's third digit as a weaker,
  ordinal statement of the same axis.
- **Vertical**: the deck/level ordinal (ascending downward, negatives
  above the main deck), plus, when known, the deck's height datum.

The placard number is a lossy projection of all three axes — deck, forward
boundary frame, transverse ordinal, use — which is precisely why it can
seed a position AND why it can *check* one: an authored geometry that
disagrees with the number one of them is wrong, and the disagreement is
computable.

## The ladder of geometry provenance

Each compartment's geometry sits on exactly one rung, is served with its
rung, and is drawn differently per rung. Climbing the ladder is always an
import, never an inference.

1. **`unknown`** — the number does not parse and no register carries the
   space. Drawn in the unlocated tray, never on the plate.
2. **`parsed`** — today's floor. Deck + forward-boundary frame + side
   parity from the placard number. Honest longitudinal datum, no extent,
   no transverse position. Drawn as a point pin.
3. **`registered`** — the class register carries frame/side columns of its
   own (the PostgreSQL store's `compartment` table). Same information
   content as `parsed`, but authored rather than derived.
4. **`surveyed`** — an imported geometry register (this layer): forward
   AND aft boundary frames per space, per-deck coverage bands, later
   transverse offsets and polygons. Drawn as a frame-extent band; the pin
   becomes a footprint.

Sources for rung 4, in increasing fidelity: the ship's **Booklet of
General Plans** (frame bounds read off the plates), the **Compartment &
Access (C&A) drawings** (authoritative per-space boundaries, the natural
CSV export), and eventually the **NAVSEA product model / CAD extract**
(true polygons and heights). The import door does not care which produced
the file; the label says, and the ledger remembers.

## Deck delineation

A deck is not a number — it is a set of frame intervals where plating
actually exists. The geometry register therefore carries, per deck code,
one or more **coverage bands** (`lo_frame..hi_frame`). Delineation buys
three things:

- **Validation**: a surveyed space whose extent leaves its deck's coverage
  is a named finding — someone transcribed the wrong deck or the wrong
  frames, and the door says so at preview.
- **Honest plates**: the plan view shades the regions of a plate where the
  deck does not exist, so an empty area reads as "no deck here", not
  "nothing scheduled here".
- **A correct "above"**: the vertical trace can stop treating ordinals as
  adjacency. The space above a 1st-platform compartment at a frame where
  no 1st platform exists is on the deck above *that* — a traversal over
  coverage, not arithmetic. (Roadmap; the data now exists to do it.)

## Truth checks the geometry door runs

Refused whole (the file is malformed): unordered extents (`fwd > aft`),
negative frames, duplicate space rows, unordered or duplicate deck bands,
an empty document.

Stored but **served as findings** (the file is well-formed and disagrees
with something — that disagreement is the value):

- **Placard disagreement**: the number encodes the forward boundary; a
  surveyed `fwd_frame` that differs from the parsed placard frame is
  either a renumbered space or a transcription error. Either way a person
  should look. Served per space, with both numbers.
- **Outside deck coverage**: a space extent not fully inside its deck's
  bands (checked only when the deck has bands).
- **Unknown spaces**: geometry rows naming compartments the register does
  not contain — counted and exampled, never silently dropped.
- **Coverage**: how much of the register the survey actually covers, so
  "surveyed" never quietly means "some of it".

The same checks run at dry-run (before Confirm) and on every read of the
register (`GET /geometry`), so the findings cannot go stale against a
re-imported schedule.

## Plate calibration is measurement, not configuration (roadmap)

The per-plate linear fit (`pxPerFrame`, `frame0X`) came from
`scripts/extract-deck-sheets.py` and is good to a few frames. The upgrade
path, deliberately data-first:

1. Store per-plate **control points** (`pixel_x ↔ frame`, several per
   plate, clicked on the plate's own printed ruler) instead of two fitted
   constants.
2. Map frames through a **piecewise-linear** fit over the control points;
   report the fit's **max residual** on the plate itself ("ruler
   calibrated to ±0.6 fr"). A position claim without an error bar is a
   guess with confidence.
3. Same for the transverse axis when offsets arrive: `pixel_y ↔ feet off
   centreline` control pairs per frame band.

The principle: the plate is a *projection surface*. All truth lives in
frame/offset coordinates; a plate that cannot be calibrated (the island
plate has no single frame axis) simply cannot host surveyed geometry, and
says so.

## What was built in this layer

- The **geometry register** document (`{label, spaces, decks}`): per-space
  `fwd_frame`/`aft_frame`, per-deck coverage bands. Same all-or-nothing
  door as every served document: previewed with findings, committed whole,
  reverted whole; memory and PostgreSQL stores carry it identically
  (migration 0014).
- **Serving**: compartments overlay their surveyed extent and are graded
  `surveyed`; the findings ride `GET /geometry`.
- **Drawing**: the deck plan renders surveyed spaces as frame-extent bands
  on the plate's ruler, keeps placard-parsed spaces as pins, and shades
  plate regions outside the deck's coverage. The provenance is in the
  marker's title, per rung.

## What is deliberately next, not now

- Transverse offsets and polygons (needs a C&A/CAD source to import).
- Control-point plate calibration with residual reporting.
- Deck height datum + coverage-aware vertical adjacency.
- Zone membership validation against surveyed extents (the zone chart
  audit today runs on raw extents; surveyed extents will sharpen it).

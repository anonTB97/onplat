# The zone scheme — how the hull is delineated

Zones and compartments are the base layer: every schedule row locates to a
compartment, every compartment sits in exactly one zone, and every screen
answers "where" through them. This note records how the demo hull is cut up,
what that rests on, and what a real yard replaces.

## Compartments: the USN numbering scheme

A placard reads `deck-frame-position-usage`, e.g. `3-148-2-E`:

| Field | Meaning | On this hull |
|---|---|---|
| deck | Deck the compartment's floor is on. Main deck is `1`; decks below count up (`2`, `3`, …); levels above count up with a leading zero (`01`, `02`, `03`, `04`). On a carrier the **hangar deck is the main deck** and the **flight deck is the 04 level**, with the gallery deck (03 level) directly beneath it. | `04` flight · `03` gallery · `02` · `01` · `1` main · `2` … `8` inner bottom |
| frame | The frame of the compartment's **forward** bulkhead. Frames number from the bow, one per 4 ft on this class. | 0 at the forward perpendicular; the hull ends near 265, the flight-deck overhang near 273 |
| position | `0` on the centreline; odd numbers to starboard, even to port, counting outboard (`1`/`2` the first tier, `3`/`4` the next). | the plates pin port above and starboard below the keel line |
| usage | One or two letters: `A` stowage · `C` control · `E` machinery · `F` fuel · `J` JP-5 · `K` chemicals · `L` living (berthing, messes, medical, offices) · `M` ammunition · `Q` miscellaneous (shops, galleys, pump rooms, IC rooms) · `T` trunks and passages · `V` voids · `W` water | as generated |

The placard is a **claim about the forward boundary only**. True extents come
from the geometry register (`docs/geometry-accuracy.md`); the plates draw the
placard frame as a pin and the surveyed extent as a band, and say which is
which.

## Zones: a 3-D partition, not stripes

A carrier availability is run by **zone managers**, each owning every trade's
work inside one physical region of the ship. The regions are cut by **deck
band and frame band together** — the flight deck is one zone end to end, the
propulsion plant is a block of decks amidships that reaches down to the inner
bottom, the forward and aft below-decks regions sit either side of it. A
frame-only chart cannot say that: it would put the flight deck over the
reactor compartments in the same zone.

The zone chart therefore carries **blocks**: `zone, lo_frame, hi_frame,
top_deck, bottom_deck`. A zone may own several blocks; the blocks of all zones
partition every deck. A compartment is in bounds when any block of its zone
contains its deck and frame. The demo scheme:

| Zone | Name | Blocks (frames inclusive) | What lives there |
|---|---|---|---|
| Z1 | Flight Deck & Island | flight 0–273 | catapults, arresting gear, elevators, non-skid, the island's levels |
| Z2 | Hangar & Gallery | gallery→main 44–232 | hangar bays 1–3, gallery-deck ready rooms and CVIC, 02/01-level sponson spaces, aircraft-elevator machinery, AIMD shops |
| Z3 | Forward Below-Decks | gallery→main 0–43 · 2nd→2nd platform 0–95 | forecastle and anchor windlass, forward berthing and messes, forward magazines, forward JP-5 pump rooms |
| Z4 | Propulsion Plant & Midships | 2nd→2nd platform 96–191 · hold→inner bottom 116–175 | reactor compartments (restricted), main and auxiliary machinery rooms, switchgear, evaporators, main galley and medical above them |
| Z5 | Aft Below-Decks | gallery→main 233–273 · 2nd→2nd platform 192–273 | fantail, steering gear, shaft alleys, aft berthing, aft magazines, aft JP-5 |
| Z6 | Tanks, Voids & Inner Bottom | hold→inner bottom 0–115 · hold→inner bottom 176–273 | JP-5 storage, potable and ballast water, voids, cofferdams — tank-entry work |

The names and the block edges are **this project's reasoning from the
class's public general arrangement** (hangar and flight-deck extents,
machinery amidships, magazines fore and aft, tanks in the double bottom), not
a yard's chart. Yards differ in how many zones they run and where they cut;
the scheme is deliberately a document (`reference/cvn73/CVN73-zones.csv`) so
the yard's own chart replaces it through the zone door and every screen
follows. What does not change with the chart: zones are blocks, a
compartment has one zone, and disagreement between chart and register is
served as a finding, never smoothed.

### What "adjacent" means

Zone-focused screens blot out everything outside the zone and keep
**next-door work** visible, because the hazards that stop a zone's crews
usually start next door. A space outside the zone is adjacent when it is:

- **across the frame boundary** — within eight frames (32 ft, about two
  compartments) of a zone space on the same deck;
- **on the deck directly above or below** a zone deck, inside the zone's
  frame extent on that deck;
- **coupled** — joined to a zone space by a coupling the rules bind to (a
  deck penetration, a shared bulkhead, an exhaust trunk, an electrical bus).

The server computes this once from the register, the chart and the coupling
graph (`GET /api/vessels/:id/zones/:zone/adjacent`) and says which of the
three reasons applies; the screens draw it, they never re-derive it.

## The register at scale

The seeded demo register is a 24-space slice — enough to prove the engine,
far too thin to look like a carrier. A Nimitz-class hull carries roughly
3,000 compartments; a PIA plans several thousand activities across them. The
demo hull is therefore delivered **as documents at a believable scale** —
about 480 compartments on twelve decks, a coupling register, a zone chart, a
geometry register, a morning's field-condition log and a schedule of record
of several thousand activities — generated deterministically by
`tools/gen_cvn73_hull.py` and `tools/gen_full_xer.py`, and loaded at boot
through the same doors a yard uses (`WADL_DEMO_DOCS`). The names are
plausible for the class (reactor compartments, main machinery rooms,
switchgear rooms, ready rooms, arresting-gear engine rooms, JP-5 pump rooms,
berthing by the dozen); the frames follow the layout above; the numbers are
invented. Every screen says so: the register card in Data Sources names the
document, and the plates keep their "notional demo data" footer.

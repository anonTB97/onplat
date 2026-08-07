# Deck plates

Thirteen scanned plates from the **USS John F. Kennedy (CV-67) Booklet of
General Plans**, 2011 reissue. Public scan:
<https://archive.org/details/cv67bogp2011>. A Booklet of General Plans is a US
Navy work prepared for public release; these are the unclassified general
arrangement drawings, not a ship's damage-control or security plan.

They arrived here from the prototype's single-file HTML export, which embedded
them. `scripts/extract-deck-sheets.py` is what pulled them out, recompressed
them, and derived the calibration in `shell-web/src/deckSheets.json`. Read that
script's docstring before touching either — the calibration is per-plate, and
the reason why is documented there.

## What is real here and what is not

The **plates are real**. The **compartment register drawn on top of them is
not**: it is the notional demo seed in `wadl-store`, invented to exercise the
rule engine. A pin therefore marks a frame station on a real drawing; it does
not mark a space you will find under that number on this ship. The Deck
Explorer says so under every sheet, and the app-wide banner says
ILLUSTRATIVE / NOTIONAL DATA.

A real deployment does not use these at all. The schema models drawings as
customer-uploaded (`drawing_sheet.file_uri`, migration 0002), and a yard brings
its own plates for its own hulls.

## Why they are committed rather than fetched

The platform makes no outbound calls — that is a standing constraint, not a
convenience. A deck plan that only renders when archive.org is reachable is not
a deck plan you can plan an availability with.

## Regenerating

    scripts/extract-deck-sheets.py path/to/Shipyard_AI_Onboard.html --measure --verify

`--measure` re-derives the frames-per-pixel from each plate's ruler and prints
it against the committed table. `--verify` writes check images with the
predicted frame lines drawn over the drawing, so the calibration can be
confirmed by eye rather than trusted.

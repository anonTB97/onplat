#!/usr/bin/env python3
"""Extract the CV-67 deck sheets from the prototype bundle and calibrate them.

    scripts/extract-deck-sheets.py path/to/Shipyard_AI_Onboard.html

The prototype ships thirteen scanned plates from the *USS John F. Kennedy
(CV-67) Booklet of General Plans* (2011 reissue; the public scan lives at
https://archive.org/details/cv67bogp2011) embedded as base64 in a
`<script type="__bundler/manifest">` block. This pulls them out, recompresses
them, and writes them to shell-web/public/decks/ together with the calibration
the Deck Explorer needs to place a compartment on the right plate at the right
frame.

Run it once; the outputs are committed. It exists so the numbers below are
reproducible and auditable rather than magic constants — a wrong frame
calibration puts a hazard marker in the wrong compartment, which is exactly the
failure this whole application is meant to prevent.

## Why the calibration is a table and not a formula

Every plate is 7000 px wide, but they are *not* drawn to a common scale. The
flight deck plate runs 23.546 px per frame; the fourth deck runs 20.453. Nor do
they share an origin: frame 0 (the forward perpendicular) falls at x=6772 on
the fourth deck and x=6352 on the flight deck. A single shared mapping — which
is what the prototype used — is out by up to fifteen frames on some plates.

So each plate carries its own `px_per_frame` and `frame0_x`:

    x_px(frame) = frame0_x - px_per_frame * frame

Frames descend toward the bow, so x *increases* as the frame number falls, and
the bow is on the right of every plate.

## How the numbers were obtained

* `px_per_frame` — the frame ruler on each plate is a train of evenly spaced
  ticks along the centreline. Taking the ink profile of a band across the
  centreline, high-passing it to kill the dash-dot baseline, and reading the
  dominant spatial frequency gives the period to about a hundredth of a pixel.
  That is `--measure` below; it is more accurate than measuring tick positions
  individually, because it uses the whole ruler at once.
* `frame0_x` — the period fixes the spacing but not the origin, and nothing in
  the image says which tick is frame 140. That anchor was read off the plate's
  printed frame numbers by eye, once per plate.
* `centreline_y` — the strongest horizontal line inside the hull, excluding
  rows that also carry ink in the sheet margins (those are the drawing's own
  border rulings, not the ship).

Every plate was then checked by rendering the predicted frame lines back over
the drawing and confirming they land on the printed ticks. `--verify` regenerates
those check images.

`deck_island` is deliberately uncalibrated: it is not a deck plan but a sheet of
separate small plans of the island levels, so it has no single frame axis. It is
still extracted, and the UI shows it as a reference sheet with no overlay.
"""

from __future__ import annotations

import argparse
import base64
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT_IMAGES = REPO / "shell-web" / "public" / "decks"
OUT_CALIBRATION = REPO / "shell-web" / "src" / "deckSheets.json"

# Recompression. The plates are line drawings whose whole value is the small
# lettering — compartment numbers, frame numbers — so they are kept at full
# width and 4:4:4 chroma. Downscaling to 4000 px halves the bytes and makes the
# compartment numbers unreadable, which defeats the point of showing the sheet.
JPEG_QUALITY = 75
JPEG_WIDTH = 7000

# Half-beam is sampled every this many frames; the UI interpolates between.
HALF_BEAM_STEP = 5

# id -> (px_per_frame, frame0_x, centreline_y). See the module docstring.
CALIBRATION: dict[str, tuple[float, float, int] | None] = {
    "deck_flight": (23.546, 6351.7, 1385),
    "deck_island": None,  # separate island-level plans; no single frame axis
    "deck_o2": (21.214, 6471.8, 723),
    "deck_o1": (21.485, 6526.4, 637),
    "deck_gallery": (21.252, 6434.7, 803),
    "deck_main": (20.934, 6525.4, 515),
    "deck_2nd": (20.877, 6513.2, 478),
    "deck_3rd": (20.470, 6785.6, 443),
    # Measured tick-by-tick over a 155-frame baseline rather than spectrally;
    # the two agree to 0.4 of a frame and the long baseline wins.
    "deck_4th": (20.453, 6772.5, 362),
    "deck_1stplat": (22.236, 6609.8, 464),
    "deck_2ndplat": (22.240, 6616.6, 389),
    "deck_hold": (21.026, 6634.8, 348),
    "deck_db": (21.021, 6621.9, 366),
}

# Ordered top-down. `deck_code` is the register's deck code — it MUST match
# `CLASS_DECKS` in wadl-store's memory seed (and `class_deck.code` in the
# schema), because that string is the only thing joining a deck to its plate.
#
# `deck_island` is the one plate with no deck code, and that is not an omission:
# it is a sheet of separate small plans of the island levels rather than one
# deck, so it has neither a single ordinal nor a frame axis to place a marker on.
SHEETS = [
    ("deck_flight", "Flight Deck", "flight"),
    ("deck_island", "Island Levels", None),
    ("deck_o2", "O-2 Level", "o2"),
    ("deck_o1", "O-1 Level", "o1"),
    ("deck_gallery", "Gallery Deck", "gallery"),
    ("deck_main", "Main Deck", "Main"),
    ("deck_2nd", "Second Deck", "2nd"),
    ("deck_3rd", "Third Deck", "3rd"),
    ("deck_4th", "Fourth Deck", "4th"),
    ("deck_1stplat", "First Platform", "1stplat"),
    ("deck_2ndplat", "Second Platform", "2ndplat"),
    ("deck_hold", "Hold", "hold"),
    ("deck_db", "Inner Bottom", "db"),
]


def read_bundle(html: Path) -> dict[str, bytes]:
    """Pulls the `deck_*` assets out of the prototype's asset manifest."""
    manifest: dict | None = None
    ext: list | None = None
    with html.open(encoding="utf-8") as fh:
        want = None
        for line in fh:
            stripped = line.strip()
            if stripped.startswith("<script type=\"__bundler/manifest\">"):
                want = "manifest"
                continue
            if stripped.startswith("<script type=\"__bundler/ext_resources\">"):
                want = "ext"
                continue
            if want == "manifest":
                manifest = json.loads(line)
                want = None
            elif want == "ext":
                ext = json.loads(line)
                want = None
            if manifest is not None and ext is not None:
                break
    if manifest is None or ext is None:
        raise SystemExit(f"{html}: no bundler manifest — is this the prototype export?")

    out: dict[str, bytes] = {}
    for entry in ext:
        if not entry["id"].startswith("deck_"):
            continue
        asset = manifest[entry["uuid"]]
        if asset.get("compressed"):
            raise SystemExit(f"{entry['id']}: compressed assets are not handled")
        out[entry["id"]] = base64.b64decode(asset["data"])
    return out


def measure(path: Path, centreline_y: int) -> float:
    """Frames-per-pixel from the spatial frequency of the ruler's tick train."""
    from PIL import Image
    import numpy as np

    grey = np.asarray(Image.open(path).convert("L"))
    band = (grey[centreline_y - 7 : centreline_y + 8, :] < 150).sum(axis=0).astype(float)
    band = band[1200:6900]
    band -= np.convolve(band, np.ones(61) / 61, mode="same")  # drop the dash-dot baseline
    spectrum = np.abs(np.fft.rfft(band * np.hanning(len(band))))
    freq = np.fft.rfftfreq(len(band))
    window = (freq > 1 / 30.0) & (freq < 1 / 15.0)  # plausible frame spacings
    peak = np.arange(len(freq))[window][np.argmax(spectrum[window])]
    y0, y1, y2 = spectrum[peak - 1], spectrum[peak], spectrum[peak + 1]
    delta = 0.5 * (y0 - y2) / (y0 - 2 * y1 + y2)  # sub-bin interpolation
    return float(len(band) / (peak + delta))


def hull_profile(path: Path, cal: tuple[float, float, int], step: int = 5) -> list[int]:
    """Half-beam in pixels, sampled every `step` frames from frame 0 aft.

    The register records which *side* a compartment is on but not how far off
    the centreline it sits, so a marker has to be placed at some fraction of the
    local half-beam. A fixed offset would work at midships and put bow
    compartments outside the hull, which on a drawing reads as an error.

    Taken as a percentile of the column's ink extent rather than its outermost
    pixel: dimension notes and deck titles are printed outside the hull on
    several plates, and the outermost pixel would find those instead.
    """
    from PIL import Image
    import numpy as np

    px_per_frame, frame0_x, centreline_y = cal
    grey = np.asarray(Image.open(path).convert("L"))
    dark = grey < 150
    out: list[int] = []
    for frame in range(0, 285, step):
        x = int(round(frame0_x - px_per_frame * frame))
        if x < 4 or x >= grey.shape[1] - 4:
            out.append(0)
            continue
        rows = np.where(dark[:, x - 3 : x + 4].any(axis=1))[0]
        if len(rows) < 8:
            out.append(0)
            continue
        spread = np.abs(rows - centreline_y)
        out.append(int(np.percentile(spread, 97)))

    # Median-filter the samples. A leader line or a note that happens to cross
    # one sampled column throws that single sample by a hundred pixels, and a
    # hull does not change beam by a hundred pixels in five frames. Zeros are
    # left alone: they mean the deck has ended, which is a real edge, not noise.
    raw = list(out)
    for i, value in enumerate(raw):
        if value == 0:
            continue
        window = [v for v in raw[max(0, i - 2) : i + 3] if v > 0]
        out[i] = int(np.median(window))
    return out


def verify(out_dir: Path, sheets: list[dict]) -> None:
    """Draws the predicted frame lines back onto each plate, for eyeballing."""
    from PIL import Image, ImageDraw

    check = out_dir.parent / "_calibration-check"
    check.mkdir(exist_ok=True)
    for sheet in sheets:
        cal = sheet.get("calibration")
        if not cal:
            continue
        im = Image.open(out_dir / sheet["file"]).convert("RGB")
        draw = ImageDraw.Draw(im)
        draw.line([(0, cal["centrelineY"]), (im.width, cal["centrelineY"])], fill=(255, 0, 0), width=3)
        for frame in range(0, 301):
            x = cal["frame0X"] - cal["pxPerFrame"] * frame
            if 0 <= x < im.width and frame % 5 == 0:
                draw.line([(x, 0), (x, im.height)], fill=(0, 140, 255), width=2)
        im.save(check / f"{sheet['id']}.jpg", "JPEG", quality=60)
    print(f"  wrote calibration check images to {check}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("html", type=Path, help="the prototype's single-file HTML export")
    ap.add_argument("--measure", action="store_true", help="re-derive px_per_frame and print it")
    ap.add_argument("--verify", action="store_true", help="render frame lines over each plate")
    args = ap.parse_args()

    from PIL import Image

    OUT_IMAGES.mkdir(parents=True, exist_ok=True)
    assets = read_bundle(args.html)
    missing = [i for i, _, _ in SHEETS if i not in assets]
    if missing:
        raise SystemExit(f"bundle is missing {missing}")

    sheets = []
    for sheet_id, label, deck_code in SHEETS:
        raw = assets[sheet_id]
        tmp = OUT_IMAGES / f".{sheet_id}.orig"
        tmp.write_bytes(raw)
        im = Image.open(tmp)
        if im.width != JPEG_WIDTH:
            im = im.resize((JPEG_WIDTH, round(im.height * JPEG_WIDTH / im.width)), Image.LANCZOS)
        name = f"{sheet_id}.jpg"
        im.save(OUT_IMAGES / name, "JPEG", quality=JPEG_QUALITY, optimize=True,
                progressive=True, subsampling=0)
        tmp.unlink()

        cal = CALIBRATION[sheet_id]
        if cal and args.measure:
            measured = measure(OUT_IMAGES / name, cal[2])
            print(f"  {sheet_id:<14} table {cal[0]:7.3f}  measured {measured:7.3f}"
                  f"  Δ {abs(measured - cal[0]) / cal[0] * 100:.2f}%")
        sheets.append({
            "id": sheet_id,
            "label": label,
            "deckCode": deck_code,
            "file": name,
            "width": im.width,
            "height": im.height,
            "calibration": None if cal is None else {
                "pxPerFrame": cal[0], "frame0X": cal[1], "centrelineY": cal[2],
                "halfBeamStep": HALF_BEAM_STEP,
                "halfBeam": hull_profile(OUT_IMAGES / name, cal, HALF_BEAM_STEP),
            },
        })
        size_kb = (OUT_IMAGES / name).stat().st_size / 1024
        print(f"  {name:<20} {im.width}x{im.height}  {size_kb:6.0f} KB"
              f"  {'calibrated' if cal else 'no frame axis'}")

    OUT_CALIBRATION.write_text(json.dumps({
        "source": "USS John F. Kennedy (CV-67) Booklet of General Plans, 2011 reissue",
        "sourceUrl": "https://archive.org/details/cv67bogp2011",
        "note": "Frames descend toward the bow: x_px(frame) = frame0X - pxPerFrame * frame.",
        "sheets": sheets,
    }, indent=2) + "\n")
    print(f"  wrote {OUT_CALIBRATION.relative_to(REPO)}")

    if args.verify:
        verify(OUT_IMAGES, sheets)
    return 0


if __name__ == "__main__":
    sys.exit(main())

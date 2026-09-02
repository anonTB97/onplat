#!/usr/bin/env python3
"""Generates the CVN-73 demo hull as documents, at a believable scale.

Writes reference/cvn73/:
  CVN73-register.csv   the compartment register — twelve decks, ~480 spaces
  CVN73-zones.csv      the zone chart as 3-D blocks (deck band × frame band)
  CVN73-couplings.csv  the authored couplings (bulkheads, trunks, buses);
                       deck penetrations are derived by the door
  CVN73-geometry.csv   deck coverage bands and surveyed extents
  CVN73-hazards.csv    a morning's field-condition log

docs/zone-scheme.md records the scheme this follows. Every number here is
invented for the demo; the arrangement is the class's public one in outline.

Deterministic: same seed, same files. Regenerate with
    python3 tools/gen_cvn73_hull.py
then python3 tools/gen_full_xer.py, which reads the register.
"""

import random
from pathlib import Path

random.seed(1973)

OUT = Path(__file__).resolve().parent.parent / "reference/cvn73"
OUT.mkdir(parents=True, exist_ok=True)

HULL_AFT = 265      # aft-most hull frame (4 ft spacing)
FLIGHT_AFT = 273    # the flight deck's overhang

# code, label, ordinal (ascending downward, levels above main negative), USN digit
DECKS = [
    ("flight", "Flight Deck (04 level)", -4, "04"),
    ("gallery", "Gallery Deck (03 level)", -3, "03"),
    ("o2", "02 Level", -2, "02"),
    ("o1", "01 Level", -1, "01"),
    ("Main", "Main Deck (hangar)", 1, "1"),
    ("2nd", "Second Deck", 2, "2"),
    ("3rd", "Third Deck", 3, "3"),
    ("4th", "Fourth Deck", 4, "4"),
    ("1stplat", "First Platform", 5, "5"),
    ("2ndplat", "Second Platform", 6, "6"),
    ("hold", "Hold", 7, "7"),
    ("db", "Inner Bottom", 8, "8"),
]
ORD = {c: o for c, _, o, _ in DECKS}
DIGIT = {c: d for c, _, _, d in DECKS}

# The zone chart: (zone, lo_frame, hi_frame, top_deck, bottom_deck). The
# blocks of all zones partition every deck — see docs/zone-scheme.md.
BLOCKS = [
    ("Z1", 0, 273, "flight", "flight"),
    ("Z2", 44, 232, "gallery", "Main"),
    ("Z3", 0, 43, "gallery", "Main"),
    ("Z3", 0, 95, "2nd", "2ndplat"),
    ("Z4", 96, 191, "2nd", "2ndplat"),
    ("Z4", 116, 175, "hold", "db"),
    ("Z5", 233, 273, "gallery", "Main"),
    ("Z5", 192, 273, "2nd", "2ndplat"),
    ("Z6", 0, 115, "hold", "db"),
    ("Z6", 176, 273, "hold", "db"),
]
ZONE_NAMES = {
    "Z1": "Zone 1 — Flight Deck & Island",
    "Z2": "Zone 2 — Hangar & Gallery",
    "Z3": "Zone 3 — Forward Below-Decks",
    "Z4": "Zone 4 — Propulsion Plant & Midships",
    "Z5": "Zone 5 — Aft Below-Decks",
    "Z6": "Zone 6 — Tanks, Voids & Inner Bottom",
}


def zone_of(deck, frame):
    for z, lo, hi, top, bot in BLOCKS:
        if ORD[top] <= ORD[deck] <= ORD[bot] and lo <= frame <= hi:
            return z
    raise ValueError(f"no zone block covers {deck} fr {frame}")


# --- the register ----------------------------------------------------------

SIDE_WORD = {0: "centreline", 1: "starboard", 2: "port", 3: "starboard", 4: "port"}
spaces = []          # dicts: no, name, deck, zone, category, frame, side, fwd, aft, usage
placards = set()


def add(deck, frame, side, usage, name, category, length=None):
    """One compartment. A placard collision shifts the frame aft by one."""
    frame = max(0, min(frame, FLIGHT_AFT if deck == "flight" else HULL_AFT))
    while f"{DIGIT[deck]}-{frame}-{side}-{usage}" in placards:
        frame += 1
    no = f"{DIGIT[deck]}-{frame}-{side}-{usage}"
    placards.add(no)
    length = length or random.choice([2, 3, 3, 4, 4, 5, 6, 8])
    spaces.append({
        "no": no, "name": name, "deck": deck, "zone": zone_of(deck, frame),
        "category": category, "frame": frame, "side": SIDE_WORD[side],
        "fwd": frame, "aft": min(frame + length, HULL_AFT), "usage": usage,
    })
    return no


def run(deck, lo, hi, step, sides, pool, category, usage, numbered=True, jitter=1):
    """Fills a stretch of a deck with spaces from a pool, one per `step` frames
    per side. Names are numbered so no two read the same."""
    counters = {}
    f = lo
    while f <= hi:
        for side in sides:
            base = random.choice(pool)
            n = counters.get(base, 0) + 1
            counters[base] = n
            name = f"{base} No. {n}" if numbered else base
            add(deck, f + random.randint(0, jitter), side, usage, name, category)
        f += step


# Flight deck — Z1. Work areas rather than rooms, but the yard schedules
# against them (non-skid, catapult tracks, arresting gear, elevators).
add("flight", 20, 1, "Q", "Catapult No. 1 track", "Aviation", 80)
add("flight", 24, 2, "Q", "Catapult No. 2 track", "Aviation", 80)
add("flight", 132, 2, "Q", "Catapult No. 3 track", "Aviation", 76)
add("flight", 150, 4, "Q", "Catapult No. 4 track", "Aviation", 76)
add("flight", 100, 1, "Q", "Jet blast deflector No. 1", "Aviation", 3)
add("flight", 104, 2, "Q", "Jet blast deflector No. 2", "Aviation", 3)
add("flight", 208, 2, "Q", "Jet blast deflector No. 3", "Aviation", 3)
add("flight", 226, 4, "Q", "Jet blast deflector No. 4", "Aviation", 3)
add("flight", 90, 1, "Q", "Aircraft elevator No. 1 platform", "Aviation", 14)
add("flight", 140, 1, "Q", "Aircraft elevator No. 2 platform", "Aviation", 14)
add("flight", 190, 1, "Q", "Aircraft elevator No. 3 platform", "Aviation", 14)
add("flight", 150, 2, "Q", "Aircraft elevator No. 4 platform", "Aviation", 14)
add("flight", 214, 0, "Q", "Arresting gear wire area", "Aviation", 26)
add("flight", 240, 2, "Q", "LSO platform", "Aviation", 4)
add("flight", 44, 0, "Q", "Bow non-skid field", "Aviation", 50)
add("flight", 168, 0, "Q", "Waist non-skid field", "Aviation", 46)
add("flight", 246, 0, "Q", "Fantail non-skid field", "Aviation", 27)
add("flight", 246, 1, "Q", "Fantail arresting gear sheave space", "Aviation", 8)

# Gallery deck (03 level) — cat machinery forward, ready rooms and CVIC amidships,
# arresting-gear engine rooms aft.
add("gallery", 10, 1, "Q", "Catapult No. 1 launch valve room", "Aviation", 8)
add("gallery", 12, 2, "Q", "Catapult No. 2 launch valve room", "Aviation", 8)
add("gallery", 20, 1, "Q", "Catapult No. 1 machinery room", "Machinery / operational", 14)
add("gallery", 22, 2, "Q", "Catapult No. 2 machinery room", "Machinery / operational", 14)
add("gallery", 36, 0, "T", "Gallery deck passage No. 1", "Passage / trunk", 8)
add("gallery", 118, 2, "Q", "Catapult No. 3 machinery room", "Machinery / operational", 14)
add("gallery", 136, 4, "Q", "Catapult No. 4 machinery room", "Machinery / operational", 14)
add("gallery", 98, 1, "Q", "Jet blast deflector No. 1 machinery room", "Machinery / operational", 4)
add("gallery", 102, 2, "Q", "Jet blast deflector No. 2 machinery room", "Machinery / operational", 4)
add("gallery", 112, 0, "C", "Combat Direction Center", "Command & surveillance", 16)
add("gallery", 128, 0, "C", "Carrier Intelligence Center (CVIC)", "Command & surveillance", 12)
add("gallery", 140, 0, "C", "Flag plot", "Command & surveillance", 8)
add("gallery", 148, 0, "C", "Strike operations", "Command & surveillance", 8)
add("gallery", 156, 0, "T", "Gallery deck passage No. 2", "Passage / trunk", 12)
for i, f in enumerate(range(150, 222, 8), start=1):
    add("gallery", f, 1 if i % 2 else 2, "L", f"Ready Room No. {i}", "Living", 8)
add("gallery", 168, 3, "Q", "Squadron maintenance control No. 1", "Aviation", 6)
add("gallery", 184, 3, "Q", "Squadron maintenance control No. 2", "Aviation", 6)
add("gallery", 176, 4, "Q", "Air wing ordnance shop", "Aviation", 8)
add("gallery", 196, 4, "L", "Air wing offices", "Living", 10)
add("gallery", 206, 0, "T", "Gallery deck passage No. 3", "Passage / trunk", 10)
for i, f in enumerate([222, 226, 232, 236], start=1):
    add("gallery", f, 1 if i % 2 else 2, "Q", f"Arresting gear engine room No. {i}", "Machinery / operational", 6)
add("gallery", 244, 0, "Q", "Barricade stanchion machinery room", "Machinery / operational", 6)
add("gallery", 250, 1, "Q", "Arresting gear sheave room, starboard", "Machinery / operational", 8)
add("gallery", 250, 2, "Q", "Arresting gear sheave room, port", "Machinery / operational", 8)
run("gallery", 60, 100, 12, [1, 2], ["Avionics shop", "Aviation storeroom", "Squadron ready storeroom"], "Aviation", "Q")

# 02 level — forecastle forward, sponson spaces down both sides, aircraft
# elevator machinery, air operations.
add("o2", 8, 0, "Q", "Forecastle & anchor windlass room", "Machinery / operational", 28)
add("o2", 36, 0, "Q", "Boatswain's stores, forecastle", "Stowage", 6)
add("o2", 40, 1, "Q", "Catapult No. 1 steam accumulator room", "Machinery / operational", 6)
add("o2", 40, 2, "Q", "Catapult No. 2 steam accumulator room", "Machinery / operational", 6)
add("o2", 60, 0, "C", "Air operations", "Command & surveillance", 10)
add("o2", 72, 0, "C", "Carrier air traffic control center (CATCC)", "Command & surveillance", 10)
for i, f in enumerate([86, 136, 186, 146], start=1):
    add("o2", f, 1 if i < 4 else 2, "Q", f"Aircraft elevator No. {i} machinery room", "Machinery / operational", 8)
for i, f in enumerate(range(96, 232, 24), start=1):
    add("o2", f, 3, "Q", f"Weapons elevator No. {i} machinery room, starboard", "Machinery / operational", 6)
    add("o2", f + 8, 4, "Q", f"Weapons elevator No. {i} machinery room, port", "Machinery / operational", 6)
run("o2", 56, 228, 16, [1, 2], ["Sponson storeroom", "Life raft stowage", "Hose reel locker", "Ordnance ready service locker"], "Stowage", "A")
add("o2", 240, 1, "J", "JP-5 filling station, aft starboard", "Fuel / JP-5", 4)
add("o2", 240, 2, "J", "JP-5 filling station, aft port", "Fuel / JP-5", 4)
add("o2", 250, 0, "T", "02 level passage, aft", "Passage / trunk", 8)

# 01 level — the hangar's shoulders: AIMD shops, tool issue, boat davits.
add("o1", 16, 0, "L", "Chief petty officer mess, forward", "Living", 12)
add("o1", 30, 1, "L", "Forward officers' berthing No. 1", "Living", 8)
add("o1", 30, 2, "L", "Forward officers' berthing No. 2", "Living", 8)
for i, (f, s, name) in enumerate([
    (64, 1, "Jet engine shop"), (80, 1, "Hydraulics shop"), (96, 1, "Avionics repair shop"),
    (112, 1, "Tire & wheel shop"), (128, 2, "Airframes shop"), (144, 2, "Power plants shop"),
    (160, 2, "Aviation electricians' shop"), (176, 1, "Ground support equipment shop"),
    (192, 2, "Composite repair shop"), (208, 1, "Survival equipment shop"),
], start=1):
    add("o1", f, s, "Q", f"AIMD {name}", "Aviation", 12)
run("o1", 60, 224, 20, [3, 4], ["Tool issue room", "Squadron storeroom", "Aviation supply storeroom", "Flammable liquids storeroom"], "Stowage", "A")
add("o1", 140, 1, "Q", "Boat davit machinery, starboard", "Machinery / operational", 6)
add("o1", 140, 2, "Q", "Boat davit machinery, port", "Machinery / operational", 6)
add("o1", 236, 0, "T", "01 level passage, aft", "Passage / trunk", 8)
add("o1", 248, 1, "Q", "Aft mooring station, starboard", "Machinery / operational", 8)
add("o1", 248, 2, "Q", "Aft mooring station, port", "Machinery / operational", 8)

# Main deck — the hangar, its side spaces, the fantail.
add("Main", 12, 0, "A", "Chain locker access & bosun storeroom", "Stowage", 12)
add("Main", 28, 0, "T", "Main deck passage, forward", "Passage / trunk", 14)
add("Main", 60, 0, "Q", "Hangar Bay 1", "Aviation", 60)
add("Main", 120, 0, "Q", "Hangar Bay 2", "Aviation", 60)
add("Main", 180, 0, "Q", "Hangar Bay 3", "Aviation", 52)
add("Main", 118, 0, "Q", "Hangar bay divisional door No. 1", "Machinery / operational", 2)
add("Main", 178, 0, "Q", "Hangar bay divisional door No. 2", "Machinery / operational", 2)
for i, f in enumerate([70, 130, 190], start=1):
    add("Main", f, 1, "C", f"Conflagration station No. {i}", "Command & surveillance", 4)
add("Main", 136, 1, "C", "Hangar deck control", "Command & surveillance", 6)
for i, f in enumerate([86, 136, 186, 146], start=1):
    add("Main", f, 1 if i < 4 else 2, "T", f"Aircraft elevator No. {i} trunk", "Passage / trunk", 14)
run("Main", 64, 224, 16, [1, 2], ["Hangar bay fire station", "Hangar deck storeroom", "Ordnance staging area", "Aircraft tie-down locker", "Hangar bay workshop"], "Aviation", "Q")
add("Main", 234, 0, "Q", "Fantail", "Aviation", 30)
add("Main", 238, 1, "Q", "Jet engine test cell", "Aviation", 12)
add("Main", 252, 2, "Q", "Aft mooring gear room", "Machinery / operational", 8)

# Second deck — the damage-control deck: berthing, messes, galley, medical,
# repair lockers, shops, the passages that tie it together.
run("2nd", 18, 94, 12, [1, 2], ["Crew berthing", "Crew washroom & head"], "Living", "L", jitter=2)
add("2nd", 62, 0, "L", "Forward mess deck", "Living", 30)
add("2nd", 40, 0, "Q", "Ship's laundry", "Machinery / operational", 12)
for i, f in enumerate([40, 100, 160, 220], start=2):
    add("2nd", f, 0, "Q", f"Damage control repair locker No. {i}", "Command & surveillance", 4)
add("2nd", 106, 0, "Q", "Main galley", "Living", 20)
add("2nd", 126, 0, "Q", "Scullery", "Living", 6)
add("2nd", 132, 0, "L", "Enlisted mess decks", "Living", 40)
add("2nd", 140, 1, "L", "Sick bay", "Living", 14)
add("2nd", 154, 1, "L", "Intensive care & ward", "Living", 8)
add("2nd", 162, 1, "Q", "Pharmacy & medical storeroom", "Stowage", 4)
add("2nd", 166, 1, "L", "Dental", "Living", 6)
add("2nd", 140, 2, "Q", "Ship's store", "Stowage", 8)
add("2nd", 150, 2, "Q", "Post office", "Stowage", 4)
add("2nd", 156, 2, "L", "Disbursing & personnel office", "Living", 8)
add("2nd", 166, 2, "Q", "Barber shop", "Living", 4)
add("2nd", 176, 0, "L", "Chief petty officer mess, aft", "Living", 16)
add("2nd", 196, 0, "Q", "Machine shop", "Machinery / operational", 14)
add("2nd", 212, 0, "Q", "Electrical repair shop", "Electrical", 10)
add("2nd", 224, 0, "Q", "Aft galley", "Living", 10)
run("2nd", 186, 252, 12, [1, 2], ["Crew berthing", "Crew washroom & head"], "Living", "L", jitter=2)
for i, f in enumerate(range(24, 260, 24), start=1):
    add("2nd", f, 0, "T", f"Second deck passage No. {i}", "Passage / trunk", 20)

# Third deck — berthing by the dozen, offices, AC plants, storerooms.
run("3rd", 20, 92, 10, [1, 2], ["Crew berthing", "Crew berthing", "Crew washroom & head", "Division office"], "Living", "L", jitter=2)
add("3rd", 40, 0, "C", "Forward IC & gyro room", "Command & surveillance", 8)
add("3rd", 60, 0, "A", "Refrigerated stores No. 1", "Stowage", 10)
add("3rd", 72, 0, "A", "Dry provisions storeroom No. 1", "Stowage", 12)
for i, f in enumerate([96, 128, 172, 204], start=1):
    add("3rd", f, 1 if i % 2 else 2, "E", f"Air conditioning plant No. {i}", "Machinery / electrical", 8)
add("3rd", 100, 0, "T", "Third deck passage, midships", "Passage / trunk", 90)
add("3rd", 108, 0, "A", "Refrigerated stores No. 2", "Stowage", 10)
add("3rd", 120, 0, "L", "Supply department office", "Living", 8)
add("3rd", 140, 0, "Q", "Cableway trunk Fr 140", "Passage / trunk", 4)
add("3rd", 148, 0, "L", "Chief Petty Officer Berthing", "Living", 10)
add("3rd", 148, 2, "E", "Switchgear Room No. 2", "Electrical", 8)
add("3rd", 152, 0, "Q", "Cableway Trunk Zone 3 overhead", "Passage / trunk", 4)
add("3rd", 156, 2, "Q", "Auxiliary Machinery Room No. 4", "Machinery / electrical", 10)
add("3rd", 160, 2, "Q", "Passage & Trunk", "Passage / trunk", 4)
add("3rd", 164, 2, "Q", "Ship's Store", "Stowage", 6)
add("3rd", 172, 0, "M", "AC Plant No. 2", "Machinery / electrical", 8)
add("3rd", 184, 0, "Q", "AC Plant No. 2 Machinery Room", "Machinery / electrical", 8)
add("3rd", 185, 0, "L", "CPO Living Space", "Living", 10)
add("3rd", 192, 2, "E", "IC Terminal Room", "Electrical", 6)
run("3rd", 190, 250, 10, [1, 2], ["Crew berthing", "Crew berthing", "Crew washroom & head", "Division office"], "Living", "L", jitter=2)
add("3rd", 230, 0, "A", "Dry provisions storeroom No. 2", "Stowage", 12)
add("3rd", 246, 0, "Q", "Aft IC room", "Command & surveillance", 6)
for i, f in enumerate(range(30, 250, 40), start=1):
    add("3rd", f, 3, "T", f"Third deck trunk No. {i}", "Passage / trunk", 2)

# Fourth deck — the plant. Reactor compartments are restricted; machinery
# rooms are where the hot work lives.
add("4th", 12, 0, "V", "Chain locker", "Tanks & voids", 10)
add("4th", 30, 1, "J", "Forward JP-5 pump room, starboard", "Fuel / JP-5", 6)
add("4th", 30, 2, "J", "Forward JP-5 pump room, port", "Fuel / JP-5", 6)
add("4th", 40, 1, "E", "Emergency diesel generator room No. 1", "Machinery / electrical", 10)
add("4th", 40, 2, "E", "Emergency diesel generator room No. 2", "Machinery / electrical", 10)
add("4th", 52, 0, "Q", "High-pressure air compressor room, forward", "Machinery / electrical", 8)
add("4th", 60, 1, "M", "Forward magazine No. 1, upper level", "Magazine", 12)
add("4th", 60, 2, "M", "Forward magazine No. 2, upper level", "Magazine", 12)
add("4th", 74, 0, "Q", "Forward pump room", "Machinery / electrical", 8)
add("4th", 84, 0, "T", "Fourth deck passage, forward", "Passage / trunk", 12)
add("4th", 96, 0, "E", "Main Machinery Room No. 1, upper level", "Machinery / electrical", 20)
add("4th", 100, 1, "E", "Switchgear Room No. 1", "Electrical", 8)
add("4th", 102, 2, "E", "Switchboard Room No. 1", "Electrical", 8)
add("4th", 110, 2, "W", "Reserve Feed Water Tank", "Tanks & voids", 6)
add("4th", 116, 0, "E", "Reactor Compartment No. 1, upper level", "Reactor plant (restricted)", 24)
add("4th", 120, 4, "Q", "Fan Room", "Machinery / electrical", 4)
add("4th", 118, 1, "Q", "Reactor auxiliaries room No. 1", "Reactor plant (restricted)", 10)
add("4th", 130, 1, "E", "Evaporator room No. 1", "Machinery / electrical", 10)
add("4th", 140, 0, "E", "Main Machinery Room No. 2, upper level", "Machinery / electrical", 12)
add("4th", 141, 0, "C", "Aft IC & Gyro Room", "Command & surveillance", 6)
add("4th", 149, 2, "Q", "Forced Draft Blower Room No. 3", "Machinery / electrical", 6)
add("4th", 152, 0, "E", "Reactor Compartment No. 2, upper level", "Reactor plant (restricted)", 24)
add("4th", 154, 1, "Q", "Reactor auxiliaries room No. 2", "Reactor plant (restricted)", 10)
add("4th", 160, 2, "Q", "Pump Room No. 2", "Machinery / electrical", 8)
add("4th", 164, 2, "Q", "Cable Trunk & IC Space", "Electrical", 4)
add("4th", 166, 1, "E", "Evaporator room No. 2", "Machinery / electrical", 10)
add("4th", 176, 0, "E", "Main Machinery Room No. 3, upper level", "Machinery / electrical", 16)
add("4th", 180, 2, "E", "Switchgear Room No. 3", "Electrical", 8)
add("4th", 184, 1, "E", "Ship's service turbine generator room No. 3", "Machinery / electrical", 8)
add("4th", 192, 0, "Q", "Auxiliary Machinery Room No. 5", "Machinery / electrical", 12)
add("4th", 204, 1, "Q", "High-pressure air compressor room, aft", "Machinery / electrical", 8)
add("4th", 204, 2, "Q", "Low-pressure air compressor room", "Machinery / electrical", 8)
add("4th", 214, 0, "T", "Fourth deck passage, aft", "Passage / trunk", 20)
add("4th", 220, 1, "J", "Aft JP-5 pump room, starboard", "Fuel / JP-5", 6)
add("4th", 220, 2, "J", "Aft JP-5 pump room, port", "Fuel / JP-5", 6)
add("4th", 228, 1, "M", "Aft magazine No. 1, upper level", "Magazine", 10)
add("4th", 228, 2, "M", "Aft magazine No. 2, upper level", "Magazine", 10)
add("4th", 236, 1, "E", "Emergency diesel generator room No. 3", "Machinery / electrical", 10)
add("4th", 236, 2, "E", "Emergency diesel generator room No. 4", "Machinery / electrical", 10)
add("4th", 248, 1, "E", "Steering gear room, starboard", "Machinery / electrical", 12)
add("4th", 248, 2, "E", "Steering gear room, port", "Machinery / electrical", 12)
run("4th", 62, 92, 10, [3, 4], ["Storeroom", "Fan room", "Electrical distribution room"], "Machinery / electrical", "Q")
run("4th", 200, 244, 12, [3, 4], ["Storeroom", "Fan room", "Electrical distribution room"], "Machinery / electrical", "Q")

# First platform — lower levels of the plant, pump rooms, magazines, shaft alleys.
add("1stplat", 24, 0, "Q", "Bow thruster & sonar dome access", "Machinery / operational", 8)
add("1stplat", 44, 0, "Q", "Forward fire pump room", "Machinery / electrical", 8)
add("1stplat", 60, 1, "M", "Forward magazine No. 1, lower level", "Magazine", 12)
add("1stplat", 60, 2, "M", "Forward magazine No. 2, lower level", "Magazine", 12)
add("1stplat", 76, 0, "M", "Forward missile magazine", "Magazine", 12)
add("1stplat", 96, 0, "E", "Main Machinery Room No. 1, lower level", "Machinery / electrical", 20)
add("1stplat", 116, 0, "E", "Reactor Compartment No. 1, lower level", "Reactor plant (restricted)", 24)
add("1stplat", 130, 1, "Q", "Seawater service pump room No. 1", "Machinery / electrical", 8)
add("1stplat", 140, 0, "E", "Main Machinery Room No. 2, lower level", "Machinery / electrical", 12)
add("1stplat", 152, 0, "E", "Reactor Compartment No. 2, lower level", "Reactor plant (restricted)", 24)
add("1stplat", 166, 2, "Q", "Seawater service pump room No. 2", "Machinery / electrical", 8)
add("1stplat", 176, 0, "E", "Main Machinery Room No. 3, lower level", "Machinery / electrical", 16)
add("1stplat", 192, 0, "Q", "Aft fire pump room", "Machinery / electrical", 8)
for i, f in enumerate([196, 196, 212, 212], start=1):
    add("1stplat", f, 1 if i % 2 else 2, "Q", f"Shaft alley No. {i}", "Machinery / electrical", 40)
add("1stplat", 228, 1, "M", "Aft magazine No. 1, lower level", "Magazine", 10)
add("1stplat", 228, 2, "M", "Aft magazine No. 2, lower level", "Magazine", 10)
add("1stplat", 240, 0, "Q", "Aft bilge & ballast pump room", "Machinery / electrical", 8)
run("1stplat", 30, 92, 12, [3, 4], ["Storeroom", "Pump room", "Void"], "Tanks & voids", "V")
run("1stplat", 200, 244, 12, [3, 4], ["Storeroom", "Pump room", "Void"], "Tanks & voids", "V")

# Second platform — magazines' lowest levels, JP-5 service, sea chests.
add("2ndplat", 40, 0, "M", "Forward magazine No. 3", "Magazine", 12)
add("2ndplat", 56, 1, "J", "JP-5 service tank No. 1", "Fuel / JP-5", 8)
add("2ndplat", 56, 2, "J", "JP-5 service tank No. 2", "Fuel / JP-5", 8)
add("2ndplat", 72, 0, "Q", "Forward JP-5 transfer pump room", "Fuel / JP-5", 8)
add("2ndplat", 100, 1, "Q", "Sea chest & strainer room No. 1", "Machinery / electrical", 6)
add("2ndplat", 100, 2, "Q", "Sea chest & strainer room No. 2", "Machinery / electrical", 6)
add("2ndplat", 130, 0, "Q", "Reactor plant cooling water pump room No. 1", "Reactor plant (restricted)", 10)
add("2ndplat", 166, 0, "Q", "Reactor plant cooling water pump room No. 2", "Reactor plant (restricted)", 10)
add("2ndplat", 180, 1, "Q", "Sea chest & strainer room No. 3", "Machinery / electrical", 6)
add("2ndplat", 180, 2, "Q", "Sea chest & strainer room No. 4", "Machinery / electrical", 6)
add("2ndplat", 200, 0, "Q", "Aft JP-5 transfer pump room", "Fuel / JP-5", 8)
add("2ndplat", 216, 1, "J", "JP-5 service tank No. 3", "Fuel / JP-5", 8)
add("2ndplat", 216, 2, "J", "JP-5 service tank No. 4", "Fuel / JP-5", 8)
add("2ndplat", 236, 0, "M", "Aft magazine No. 3", "Magazine", 12)
run("2ndplat", 24, 92, 14, [3, 4], ["Cofferdam", "Void", "Potable water pump room"], "Tanks & voids", "V")
run("2ndplat", 190, 246, 14, [3, 4], ["Cofferdam", "Void", "Ballast pump room"], "Tanks & voids", "V")

# Hold and inner bottom — tanks and voids, the reactor plant's footprint.
for i, f in enumerate(range(32, 112, 16), start=1):
    add("hold", f, 1, "J", f"JP-5 storage tank No. {2 * i - 1}", "Tanks & voids", 14)
    add("hold", f, 2, "J", f"JP-5 storage tank No. {2 * i}", "Tanks & voids", 14)
add("hold", 116, 0, "E", "Reactor Compartment No. 1, hold level", "Reactor plant (restricted)", 24)
add("hold", 152, 0, "E", "Reactor Compartment No. 2, hold level", "Reactor plant (restricted)", 24)
add("hold", 140, 0, "V", "Void between reactor compartments", "Tanks & voids", 12)
for i, f in enumerate(range(180, 244, 16), start=1):
    add("hold", f, 1, "W", f"Potable water tank No. {2 * i - 1}", "Tanks & voids", 14)
    add("hold", f, 2, "W", f"Potable water tank No. {2 * i}", "Tanks & voids", 14)
add("hold", 244, 0, "V", "Aft peak void", "Tanks & voids", 12)
add("hold", 40, 0, "V", "Forward peak void", "Tanks & voids", 12)
for i, f in enumerate(range(36, 116, 20), start=1):
    add("db", f, 1, "W", f"Ballast tank No. {2 * i - 1}", "Tanks & voids", 18)
    add("db", f, 2, "W", f"Ballast tank No. {2 * i}", "Tanks & voids", 18)
add("db", 116, 0, "V", "Reactor compartment No. 1 inner-bottom void", "Reactor plant (restricted)", 24)
add("db", 152, 0, "V", "Reactor compartment No. 2 inner-bottom void", "Reactor plant (restricted)", 24)
for i, f in enumerate(range(176, 232, 20), start=1):
    add("db", f, 1, "V", f"Inner bottom void No. {2 * i - 1}", "Tanks & voids", 18)
    add("db", f, 2, "V", f"Inner bottom void No. {2 * i}", "Tanks & voids", 18)

# The seeded slice's placards keep their names so the seeded work orders,
# packages and hazards still land on spaces the register carries.
SEEDED = [
    ("1-136-0-Q", "Hangar Bay 2 (elevator No. 2 bay)", "Main", "Aviation"),
    ("2-160-2-Q", "Uptake Space No. 3", "2nd", "Machinery / electrical"),
    ("1-160-0-Q", "Hangar Bay 3 (uptake bay)", "Main", "Aviation"),
    ("2-152-0-Q", "Scullery No. 2", "2nd", "Living"),
    ("2-160-1-Q", "Mess Decks, starboard", "2nd", "Living"),
    ("2-176-0-Q", "Wardroom Terminal Space", "2nd", "Living"),
    ("3-148-0-L", "Chief Petty Officer Berthing", "3rd", "Living"),
]
for no, name, deck, category in SEEDED:
    if no in placards:
        continue
    d, f, s, u = no.split("-")
    placards.add(no)
    spaces.append({
        "no": no, "name": name, "deck": deck, "zone": zone_of(deck, int(f)),
        "category": category, "frame": int(f), "side": SIDE_WORD[int(s)],
        "fwd": int(f), "aft": int(f) + 8, "usage": u,
    })

spaces.sort(key=lambda s: (ORD[s["deck"]], s["frame"], s["no"]))

# --- couplings ---------------------------------------------------------------
# Authored: shared bulkheads between frame-neighbours on one deck and side;
# the uptake trunk stack under the island; electrical buses from each
# switchgear room to the machinery it feeds. Deck penetrations are the
# door's to derive from deck order and frame overlap.
couplings = []
by_deck_side = {}
for s in spaces:
    by_deck_side.setdefault((s["deck"], s["side"]), []).append(s)
for group in by_deck_side.values():
    group.sort(key=lambda s: s["frame"])
    for a, b in zip(group, group[1:]):
        if b["frame"] - a["aft"] <= 2 and a["deck"] != "flight":
            couplings.append((a["no"], b["no"], "shared_bulkhead", "yes"))

uptakes = [s for s in spaces if "Uptake" in s["name"] or "Main Machinery Room" in s["name"]]
stack = sorted(uptakes, key=lambda s: ORD[s["deck"]])
for lower, upper in zip(stack[1:], stack):
    if ORD[lower["deck"]] > ORD[upper["deck"]]:
        couplings.append((lower["no"], upper["no"], "exhaust_trunk", "no"))

switchgear = [s for s in spaces if "Switchgear" in s["name"] or "Switchboard" in s["name"]]
for sg in switchgear:
    fed = [
        s for s in spaces
        if s["no"] != sg["no"]
        and abs(ORD[s["deck"]] - ORD[sg["deck"]]) <= 1
        and abs(s["frame"] - sg["frame"]) <= 36
        and s["category"] in ("Machinery / electrical", "Electrical", "Command & surveillance", "Machinery / operational")
    ]
    for s in fed[:9]:
        couplings.append((sg["no"], s["no"], "electrical_bus", "no"))

# --- hazards: a morning's log -------------------------------------------------
def pick(pred, n):
    pool = [s for s in spaces if pred(s)]
    random.shuffle(pool)
    return pool[:n]

hazards = []
for s in pick(lambda s: "Main Machinery Room" in s["name"] or "Auxiliary Machinery" in s["name"] or "Shaft alley" in s["name"], 6):
    hazards.append((s["no"], "hot_work_live", f"HW permit {random.randint(2600, 2699)} · weld repair, {s['name']}"))
for s in pick(lambda s: s["category"] == "Living" and "berthing" in s["name"].lower(), 5):
    hazards.append((s["no"], "coating_open", f"CT-{s['frame']}{random.randint(1, 9)} · deck coat curing, {s['name']}"))
for s in pick(lambda s: "JP-5" in s["name"] and "tank" in s["name"].lower(), 4):
    hazards.append((s["no"], "flammable_stow", f"Tank entry · {s['name']} gas-freed for coating, vapour present"))
for s in pick(lambda s: "Switchgear" in s["name"] or "Emergency diesel" in s["name"], 4):
    hazards.append((s["no"], "energised_bus", f"Bus live · {s['name']} — no verified zero-energy state"))
for s in pick(lambda s: "magazine" in s["name"].lower(), 2):
    hazards.append((s["no"], "stop_work", f"Weapons dept stop-work · {s['name']} pending ordnance inspection"))
for s in pick(lambda s: "Catapult" in s["name"] and "track" in s["name"], 2):
    hazards.append((s["no"], "hot_work_live", f"HW permit {random.randint(2700, 2799)} · track weld, {s['name']}"))
for s in pick(lambda s: "Arresting gear engine" in s["name"], 1):
    hazards.append((s["no"], "coating_open", f"CT-AG{random.randint(1, 4)} · engine room preservation curing"))
for s in pick(lambda s: "Ready Room" in s["name"], 2):
    hazards.append((s["no"], "coating_open", f"CT-RR · overhead coat curing, {s['name']}"))
for s in pick(lambda s: "Hangar Bay" in s["name"] and "door" not in s["name"], 1):
    hazards.append((s["no"], "hot_work_live", f"HW permit {random.randint(2800, 2899)} · padeye repair, {s['name']}"))

# --- emit --------------------------------------------------------------------
def esc(v):
    # The documents are plain comma-separated; a comma inside a name would
    # split the row, so names carry an en dash where prose would put one.
    return v.replace(", ", " – ").replace(",", " –")

lines = [
    "# CVN-73 compartment register — generated by tools/gen_cvn73_hull.py (docs/zone-scheme.md).",
    "# ILLUSTRATIVE: names plausible for the class, frames per the demo scheme, numbers invented.",
    "# deck,<code>,<label>,<ordinal>",
    "# space,<compartment_no>,<name>,<deck_code>,<zone>,<category>[,<frame>,<side>]",
]
for code, label, ordinal, _ in DECKS:
    lines.append(f"deck,{code},{label},{ordinal}")
for s in spaces:
    lines.append(f"space,{s['no']},{esc(s['name'])},{s['deck']},{s['zone']},{esc(s['category'])},{s['frame']},{s['side']}")
(OUT / "CVN73-register.csv").write_text("\n".join(lines) + "\n")

lines = [
    "# CVN-73 zone chart — 3-D blocks: a zone owns a frame band on a band of decks.",
    "# zone,lo_frame,hi_frame,top_deck,bottom_deck  (frames inclusive; decks by register code)",
    "# The blocks of all zones partition every deck — see docs/zone-scheme.md.",
]
for z, lo, hi, top, bot in BLOCKS:
    lines.append(f"{z},{lo},{hi},{top},{bot}")
(OUT / "CVN73-zones.csv").write_text("\n".join(lines) + "\n")

lines = [
    "# CVN-73 coupling register — the paths a hazard can travel, authored.",
    "# from,to,code[,symmetric]   deck penetrations are derived by the door from deck order and frame overlap",
]
for a, b, code, sym in couplings:
    lines.append(f"{a},{b},{code},{sym}")
(OUT / "CVN73-couplings.csv").write_text("\n".join(lines) + "\n")

COVERAGE = {
    "flight": (0, 273), "gallery": (4, 262), "o2": (6, 262), "o1": (8, 262), "Main": (10, 265),
    "2nd": (10, 262), "3rd": (12, 258), "4th": (12, 256), "1stplat": (16, 252),
    "2ndplat": (22, 248), "hold": (30, 250), "db": (34, 236),
}
lines = [
    "# CVN-73 geometry register — deck coverage bands and surveyed extents.",
    "# deck,<deck_code>,<lo_frame>,<hi_frame>   space,<compartment_no>,<fwd_frame>,<aft_frame>",
    "# ILLUSTRATIVE: extents follow the generated register; the bands trim the plates at bow and stern.",
]
for code, (lo, hi) in COVERAGE.items():
    lines.append(f"deck,{code},{lo},{hi}")
for s in spaces:
    if s["aft"] > s["fwd"]:
        lines.append(f"space,{s['no']},{s['fwd']},{s['aft']}")
(OUT / "CVN73-geometry.csv").write_text("\n".join(lines) + "\n")

lines = [
    "# CVN-73 field-condition log — the morning's tag-outs, permits, coating tickets and stop-works.",
    "# compartment,kind,label[,since]   kinds: hot_work_live coating_open energised_bus flammable_stow stop_work",
]
for no, kind, label in hazards:
    lines.append(f"{no},{kind},{esc(label)}")
(OUT / "CVN73-hazards.csv").write_text("\n".join(lines) + "\n")

by_zone = {}
by_deck = {}
for s in spaces:
    by_zone[s["zone"]] = by_zone.get(s["zone"], 0) + 1
    by_deck[s["deck"]] = by_deck.get(s["deck"], 0) + 1
print(f"register: {len(spaces)} spaces on {len(DECKS)} decks")
print("  by zone: " + " · ".join(f"{z} {n}" for z, n in sorted(by_zone.items())))
print("  by deck: " + " · ".join(f"{d} {by_deck.get(d, 0)}" for d, _, _, _ in DECKS))
print(f"couplings: {len(couplings)} authored · hazards: {len(hazards)}")

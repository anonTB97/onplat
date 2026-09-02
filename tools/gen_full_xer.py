#!/usr/bin/env python3
"""Generates a large, realistic P6 XER export for the demo hull's availability.

Writes reference/p6-sample/CVN73-PIA26-full.xer: a CVN Planned Incremental
Availability at roughly production scale — thousands of activities across the
hull's six zones, phase-staged (survey → strip → repair → install → test →
close-out), statused against a data date, with dependency logic including a
handful of deliberate negative lags (overlaps written into the schedule's own
logic — findings, not errors).

The file exercises every grading path the ingest carries:
  * most work locates through the compartment UDF (authored),
  * some locates only through a placard written in the task name (derived),
  * zone-level services carry no compartment at all but sit under their zone's
    WBS node (a zone HINT, never a location),
  * a small crosswalk-gap chain locates to spaces this hull's register does
    not carry (the unknown-space finding),
  * and general-services work is honestly unlocatable.

Deterministic: same seed, same file, byte for byte. Regenerate with
    python3 tools/gen_full_xer.py
"""

import random
from datetime import datetime, timedelta
from pathlib import Path

random.seed(73)

OUT = Path(__file__).resolve().parent.parent / "reference/p6-sample/CVN73-PIA26-full.xer"

AV_START = datetime(2026, 7, 27, 6, 0)
AV_END = datetime(2027, 1, 23, 18, 0)
DATA_DATE = datetime(2026, 8, 10, 6, 0)

# The hull's compartment register — the crosswalk the yard actually holds —
# read from the generated document so the schedule locates to the spaces the
# hull serves (tools/gen_cvn73_hull.py, docs/zone-scheme.md). Each entry is
# (compartment, zone, name, category); the category sets how much work a
# space attracts and which systems it attracts.
REGISTER = Path(__file__).resolve().parent.parent / "reference/cvn73/CVN73-register.csv"
SPACES = []
for line in REGISTER.read_text().splitlines():
    if not line or line.startswith("#"):
        continue
    cols = line.split(",")
    if cols[0] == "space":
        SPACES.append((cols[1], cols[4], cols[2], cols[5]))

ZONES = {
    "Z1": "Zone 1 — Flight Deck & Island",
    "Z2": "Zone 2 — Hangar & Gallery",
    "Z3": "Zone 3 — Forward Below-Decks",
    "Z4": "Zone 4 — Propulsion Plant & Midships",
    "Z5": "Zone 5 — Aft Below-Decks",
    "Z6": "Zone 6 — Tanks, Voids & Inner Bottom",
}

# How many work chains a space attracts and which systems, by category. A
# machinery room in a PIA carries a dozen jobs; a void carries a tank entry
# and a coat. Weights index into SYSTEMS by SWLIN.
CATEGORY_PROFILE = {
    "Machinery / electrical": ((3, 6), {"560": 4, "505": 3, "300": 2, "512": 2, "130": 1, "631": 1, "508": 1}),
    "Machinery / operational": ((2, 5), {"560": 3, "505": 2, "300": 2, "130": 2, "631": 1, "512": 1}),
    "Electrical": ((2, 4), {"300": 5, "430": 2, "512": 1, "631": 1}),
    "Reactor plant (restricted)": ((1, 3), {"560": 2, "505": 2, "300": 1, "130": 1}),
    "Living": ((1, 3), {"631": 3, "512": 2, "300": 1, "430": 1, "508": 1}),
    "Aviation": ((1, 4), {"130": 3, "631": 2, "560": 2, "505": 1, "300": 1}),
    "Command & surveillance": ((1, 2), {"430": 3, "300": 2, "512": 1}),
    "Stowage": ((0, 2), {"631": 3, "130": 1, "512": 1}),
    "Magazine": ((1, 2), {"631": 2, "512": 1, "300": 1, "130": 1}),
    "Passage / trunk": ((0, 2), {"631": 2, "508": 2, "512": 1, "300": 1}),
    "Tanks & voids": ((1, 2), {"631": 4, "130": 2, "505": 1}),
    "Fuel / JP-5": ((1, 3), {"505": 3, "631": 2, "130": 1, "560": 1}),
}

# Trades: (rsrc_id, short_name, long name, calendar)
TRADES = [
    (7001, "SM-PRES", "Preservation / Blast & Coat", 101),
    (7002, "SM-MECH", "Mechanical", 101),
    (7003, "SM-ELEC", "Electrical", 101),
    (7004, "SM-WELD", "Structural Welding", 102),
    (7005, "SM-SHTM", "Sheet Metal / HVAC", 101),
    (7006, "SM-PIPE", "Pipefitting", 101),
    (7007, "SM-RIGG", "Rigging & Weight Handling", 101),
    (7008, "SM-INSL", "Insulation & Lagging", 101),
    (7009, "SM-MACH", "Inside Machinist", 101),
    (7010, "SM-ICEN", "Interior Communications", 101),
]
TRADE_ID = {t[1]: t[0] for t in TRADES}

# System templates: (SWLIN, swlin name, trade, system-name templates, step templates).
# {sys} is replaced with the instance name. Phases index into the availability's
# waves so strip work fronts the schedule and testing backs it.
SYSTEMS = [
    ("512", "512 Ventilation & Uptakes", "SM-SHTM",
     ["vent branch {n}", "supply trunk {n}", "exhaust riser {n}"],
     [("Survey & mark {sys}", 0), ("Remove & tag {sys}", 0), ("Fab replacement duct — {sys}", 1),
      ("Install {sys}", 2), ("Duct leak test {sys}", 3), ("Close-out & QA {sys}", 4)]),
    ("631", "631 Preservation", "SM-PRES",
     ["deck coating {n}", "bilge preservation {n}", "overhead coating {n}"],
     [("Surface survey — {sys}", 0), ("Blast / mechanical prep {sys}", 1),
      ("Prime coat {sys}", 2), ("Top coat {sys}", 2), ("Cure & inspect {sys}", 3)]),
    ("300", "300 Electrical Distribution", "SM-ELEC",
     ["cable run {n}", "panel group {n}", "lighting circuit {n}"],
     [("Circuit survey — {sys}", 0), ("De-energize & tag out {sys}", 0), ("Pull & land cable — {sys}", 2),
      ("Megger & continuity test {sys}", 3), ("Energize & close-out {sys}", 4)]),
    ("505", "505 Piping Systems", "SM-PIPE",
     ["pipe spool group {n}", "valve bank {n}", "drain riser {n}"],
     [("Lay-up & drain {sys}", 0), ("Cut out {sys}", 1), ("Fab & fit {sys}", 1),
      ("Weld out {sys}", 2), ("Hydro test {sys}", 3), ("Flush & restore {sys}", 4)]),
    ("130", "130 Hull Structure", "SM-WELD",
     ["structural bay {n}", "foundation group {n}", "deck insert {n}"],
     [("NDT survey — {sys}", 0), ("Crop out {sys}", 1), ("Fit & weld {sys}", 2),
      ("NDT acceptance — {sys}", 3), ("Grind & dress {sys}", 3)]),
    ("560", "560 Aux Machinery", "SM-MECH",
     ["pump set {n}", "motor group {n}", "compressor {n}"],
     [("Open & inspect {sys}", 0), ("Remove {sys} for shop", 1), ("Shop overhaul — {sys}", 1),
      ("Reinstall & align {sys}", 2), ("Operational test {sys}", 3)]),
    ("508", "508 Insulation & Lagging", "SM-INSL",
     ["lagging section {n}", "hull board field {n}"],
     [("Strip lagging — {sys}", 0), ("Asbestos survey — {sys}", 0),
      ("Re-insulate {sys}", 2), ("Sheathing & finish {sys}", 3)]),
    ("430", "430 Interior Communications", "SM-ICEN",
     ["IC circuit {n}", "announcing group {n}"],
     [("Circuit trace — {sys}", 0), ("Rip out {sys}", 1), ("Install & terminate {sys}", 2),
      ("Ring-out & test {sys}", 3)]),
]

# Zone-level services: no compartment, honest zone hint through the WBS.
ZONE_SERVICES = [
    ("SM-RIGG", ["Stage scaffolding — {where} band {n}", "Rig access platforms — {where} band {n}",
                 "Strike scaffolding — {where} band {n}"]),
    ("SM-ELEC", ["Run temporary power — {where} feeder {n}", "Temp lighting string {n} — {where}",
                 "Recover temp services — {where} feeder {n}"]),
    ("SM-SHTM", ["Temp ventilation trunk {n} — {where}", "Reposition temp vent {n} — {where}"]),
    ("SM-RIGG", ["Material staging & lay-down {n} — {where}", "Clear lay-down {n} — {where}"]),
]

# The availability's phase waves, as (offset-days-from-start, spread-days).
WAVES = [(0, 25), (14, 45), (45, 70), (95, 60), (130, 45)]

SEEDED_WI = {"Z1": "WI-4471", "Z2": "WI-1905", "Z3": "WI-3318",
             "Z4": "WI-3905", "Z5": "WI-5571", "Z6": "WI-3402"}

lines = []
task_rows = []
pred_rows = []
rsrc_rows = []
udf_rows = []
wbs_rows = []

task_id = 900000
pred_id = 950000
udf_id = 970000
code_n = 10


def fmt(dt):
    return dt.strftime("%Y-%m-%d %H:%M")


def next_code():
    global code_n
    code_n += 10
    return f"A{code_n:05d}"


# ---- WBS ---------------------------------------------------------------
wbs_id = {"root": 9000}
wbs_rows.append((9000, "", "PIA26", "CVN-73 PIA-26"))
n = 9100
for z, zname in ZONES.items():
    wbs_id[z] = n
    wbs_rows.append((n, 9000, z, zname))
    n += 100
    for swlin, sname, _, _, _ in SYSTEMS:
        wbs_id[f"{z}/{swlin}"] = n
        wbs_rows.append((n, wbs_id[z], swlin, sname))
        n += 1
    wbs_id[f"{z}/SVC"] = n
    wbs_rows.append((n, wbs_id[z], "SVC", "Zone Services & Access"))
    n += 1
wbs_id["MSTN"] = 9990
wbs_rows.append((9990, 9000, "MSTN", "Key Events"))
wbs_id["GEN"] = 9991
wbs_rows.append((9991, 9000, "GEN", "General Services (ship-wide)"))


def add_task(name, wbs, trade, start, end, *, milestone=False, compartment=None,
             wi=None, second_trade=None):
    """One TASK row + its resource assignment(s) + UDFs. Returns (task_id, code)."""
    global task_id, udf_id
    task_id += 1
    tid = task_id
    code = next_code()
    dur_days = max((end - start).total_seconds() / 86400.0, 0.05)
    crew = random.choice([1, 1, 2, 2, 3, 4])
    budget = 0 if milestone else max(8, int(dur_days * crew * 8 * random.uniform(0.7, 1.15)))

    if milestone:
        status, act_s, act_e = ("TK_Complete", start, end) if end <= DATA_DATE else ("TK_NotStart", None, None)
        earned = 0
    elif end <= DATA_DATE:
        status, act_s, act_e, earned = "TK_Complete", start, end, budget
    elif start < DATA_DATE:
        frac = (DATA_DATE - start).total_seconds() / (end - start).total_seconds()
        # A slice of the active work runs behind: earned lags the calendar.
        lag = random.uniform(0.55, 1.0) if random.random() < 0.35 else random.uniform(0.9, 1.05)
        status, act_s, act_e = "TK_Active", start, None
        earned = min(budget, int(budget * frac * lag))
    else:
        status, act_s, act_e, earned = "TK_NotStart", None, None, 0

    pct = 100 if status == "TK_Complete" else (round(100 * earned / budget) if budget else 0)
    task_rows.append((
        tid, 4410, wbs, 101, code, name,
        "TT_Mile" if milestone else "TT_Task", status,
        fmt(start), fmt(end), fmt(start), fmt(end),
        fmt(act_s) if act_s else "", fmt(act_e) if act_e else "",
        "", "", pct,
    ))
    if not milestone:
        rid = TRADE_ID[trade]
        if second_trade:
            main = int(budget * 0.8)
            rsrc_rows.append((tid, rid, main, min(earned, main)))
            rsrc_rows.append((tid, TRADE_ID[second_trade], budget - main, max(0, earned - main)))
        else:
            rsrc_rows.append((tid, rid, budget, earned))
    if compartment:
        udf_id += 1
        udf_rows.append((901, tid, compartment))
    if wi:
        udf_id += 1
        udf_rows.append((902, tid, wi))
    return tid, code


def link(pred, succ, kind="PR_FS", lag_hr=0):
    global pred_id
    pred_id += 1
    pred_rows.append((pred_id, succ, pred, kind, lag_hr))


def wave_window(phase, dur_days):
    off, spread = WAVES[min(phase, len(WAVES) - 1)]
    start = AV_START + timedelta(days=off + random.uniform(0, spread), hours=random.choice([0, 2, 4]))
    end = start + timedelta(days=dur_days)
    return start, min(end, AV_END - timedelta(days=1))


# ---- Per-space work chains ---------------------------------------------
zone_last_steps = {z: [] for z in ZONES}
SYSTEM_BY_SWLIN = {s[0]: s for s in SYSTEMS}
for space, zone, space_name, category in SPACES:
    (lo, hi), weights = CATEGORY_PROFILE.get(category, ((1, 3), {"631": 2, "560": 1}))
    n_chains = random.randint(lo, hi)
    picks = random.choices(
        [SYSTEM_BY_SWLIN[k] for k in weights], weights=list(weights.values()), k=n_chains,
    )
    for ci, (swlin, _, trade, sys_names, steps) in enumerate(picks):
        sys_name = random.choice(sys_names).replace("{n}", f"{random.randint(1, 9)}{chr(65 + ci % 6)}")
        wi = SEEDED_WI[zone] if random.random() < 0.22 else f"WI-{random.randint(6000, 9899)}"
        # Location grading, per chain: most authored, some name-derived, some silent.
        grade = random.random()
        prev = None
        cursor = None
        for si, (tmpl, phase) in enumerate(steps):
            dur = random.uniform(2, 14)
            if cursor is None:
                start, end = wave_window(phase, dur)
            else:
                gap = timedelta(days=random.uniform(0, 3))
                start = cursor + gap
                end = start + timedelta(days=dur)
                if end >= AV_END:
                    end = AV_END - timedelta(days=1)
                    start = min(start, end - timedelta(days=1))
            cursor = end
            name = tmpl.replace("{sys}", sys_name)
            if grade < 0.85:
                comp, nm = space, f"{name} — {space_name}"
            elif grade < 0.93:
                comp, nm = None, f"{name} ({space})"  # placard in the name — derived
            else:
                comp, nm = None, f"{name} — {space_name}"  # unlocated; zone hint via WBS
            second = "SM-RIGG" if random.random() < 0.08 else None
            tid, code = add_task(nm, wbs_id[f"{zone}/{swlin}"], trade, start, end,
                                 compartment=comp, wi=wi if si == 0 or random.random() < 0.7 else None,
                                 second_trade=second)
            if prev:
                if random.random() < 0.025:
                    link(prev, tid, "PR_FS", -random.choice([8, 16, 24, 48]))
                elif random.random() < 0.06:
                    link(prev, tid, "PR_SS", random.choice([24, 48, 72]))
                else:
                    link(prev, tid, "PR_FS", random.choice([0, 0, 0, 8, 24]))
            prev = tid
        zone_last_steps[zone].append(prev)

# ---- Zone-level services (no compartment; zone hint through the WBS) ----
for zone in ZONES:
    for band in range(random.randint(8, 12)):
        trade, tmpls = random.choice(ZONE_SERVICES)
        prev = None
        cursor = None
        for si, tmpl in enumerate(random.sample(tmpls, k=min(len(tmpls), random.randint(2, 3)))):
            dur = random.uniform(2, 10)
            if cursor is None:
                start, end = wave_window(si, dur)
            else:
                start = cursor + timedelta(days=random.uniform(5, 40))
                end = start + timedelta(days=dur)
                if end >= AV_END:
                    end = AV_END - timedelta(days=1)
                    start = min(start, end - timedelta(days=1))
            cursor = end
            name = tmpl.replace("{where}", ZONES[zone].split("—")[1].strip()).replace("{n}", str(band + 1))
            wi = f"WI-{random.randint(6000, 9899)}" if random.random() < 0.4 else None
            tid, _ = add_task(name, wbs_id[f"{zone}/SVC"], trade, start, end, wi=wi)
            if prev:
                link(prev, tid, "PR_FS", 0)
            prev = tid

# ---- General services: honestly unlocatable, ship-wide ------------------
for i in range(24):
    dur = random.uniform(5, 30)
    start, end = wave_window(random.randint(0, 4), dur)
    name = random.choice([
        "Shore power monitoring & load checks", "Pier crane window — heavy lifts",
        "Firewatch rotation", "Tank sounding rounds", "Gas-free engineering surveys",
        "Housekeeping & debris removal", "Weapons elevator barrier watch",
    ]) + f" — period {i + 1}"
    add_task(name, wbs_id["GEN"], random.choice(["SM-RIGG", "SM-MECH"]), start, end)

# ---- The crosswalk gap: located, but to nowhere this hull's register knows.
gap_chain = None
for comp, nm in [("2-250-0-E", "Emergency Diesel Room (fwd)"),
                 ("5-300-1-T", "JP-5 Service Tank"),
                 ("3-88-0-Q", "Forward IC Gyro")]:
    for step in ["Open & inspect", "Repair & restore"]:
        start, end = wave_window(1, random.uniform(4, 10))
        tid, _ = add_task(f"{step} — {nm}", wbs_id["Z2/560"], "SM-MECH", start, end,
                          compartment=comp, wi=f"WI-{random.randint(6000, 9899)}")
        if gap_chain:
            link(gap_chain, tid)
        gap_chain = tid

# ---- Key events ----------------------------------------------------------
milestones = [
    ("Availability start", AV_START, "MSTN"),
    ("Production 25% review", AV_START + timedelta(days=45), "MSTN"),
    ("Production 50% review", AV_START + timedelta(days=90), "MSTN"),
    ("Production 75% review", AV_START + timedelta(days=135), "MSTN"),
    ("Light-off assessment", AV_END - timedelta(days=28), "MSTN"),
    ("Crew certification", AV_END - timedelta(days=14), "MSTN"),
    ("Fast cruise", AV_END - timedelta(days=5), "MSTN"),
    ("End of availability", AV_END, "MSTN"),
]
for z in ZONES:
    milestones.append((f"{z} zone close-out review", AV_END - timedelta(days=random.randint(18, 40)), "MSTN"))
mstn_ids = {}
for mname, when, bucket in milestones:
    tid, _ = add_task(mname, wbs_id[bucket], "SM-MECH", when, when, milestone=True)
    mstn_ids[mname] = tid
for z in ZONES:
    review = mstn_ids[f"{z} zone close-out review"]
    for last in random.sample(zone_last_steps[z], k=min(6, len(zone_last_steps[z]))):
        link(last, review)
    link(review, mstn_ids["Light-off assessment"])

# ---- Emit ---------------------------------------------------------------
w = lines.append
w("ERMHDR\t19.12\t2026-08-10\tProject\tadmin\tA.PLANNER\tShipyard Planning\tUSD")
w("%T\tCURRTYPE")
w("%F\tcurr_id\tcurr_type\tcurr_short_name\tdecimal_digit_cnt")
w("%R\t1\tUS Dollar\tUSD\t2")
w("%T\tCALENDAR")
w("%F\tclndr_id\tclndr_name\tday_hr_cnt\tweek_hr_cnt\tdefault_flag")
w("%R\t101\tYard 2-Shift 6-Day\t10\t60\tY")
w("%R\t102\tYard Round-the-Clock\t24\t168\tN")
w("%T\tPROJECT")
w("%F\tproj_id\tproj_short_name\tproj_name\tplan_start_date\tplan_end_date\tclndr_id\tlast_recalc_date")
w(f"%R\t4410\tCVN73-PIA26\tCVN-73 Planned Incremental Availability 2026\t{fmt(AV_START)}\t{fmt(AV_END)}\t101\t{fmt(DATA_DATE)}")
w("%T\tPROJWBS")
w("%F\twbs_id\tproj_id\tparent_wbs_id\twbs_short_name\twbs_name")
for wid, parent, short, name in wbs_rows:
    w(f"%R\t{wid}\t4410\t{parent}\t{short}\t{name}")
w("%T\tRSRC")
w("%F\trsrc_id\trsrc_short_name\trsrc_name\trsrc_type\tclndr_id")
for rid, short, name, cal in TRADES:
    w(f"%R\t{rid}\t{short}\t{name}\tRT_Labor\t{cal}")
w("%T\tUDFTYPE")
w("%F\tudf_type_id\tudf_type_name\tudf_type_label\tlogical_data_type")
w("%R\t901\tcompartment\tCompartment\tFT_TEXT")
w("%R\t902\twi_number\tWork Item\tFT_TEXT")
w("%T\tTASK")
w("%F\ttask_id\tproj_id\twbs_id\tclndr_id\ttask_code\ttask_name\ttask_type\tstatus_code"
  "\ttarget_start_date\ttarget_end_date\tearly_start_date\tearly_end_date"
  "\tact_start_date\tact_end_date\tcstr_type\tcstr_date\tphys_complete_pct")
for r in task_rows:
    w("%R\t" + "\t".join(str(x) for x in r))
w("%T\tTASKPRED")
w("%F\ttask_pred_id\ttask_id\tpred_task_id\tproj_id\tpred_proj_id\tpred_type\tlag_hr_cnt")
for pid, succ, pred, kind, lag in pred_rows:
    w(f"%R\t{pid}\t{succ}\t{pred}\t4410\t4410\t{kind}\t{lag}")
w("%T\tTASKRSRC")
w("%F\ttaskrsrc_id\ttask_id\tproj_id\trsrc_id\ttarget_qty\tact_reg_qty\tremain_qty")
for i, (tid, rid, budget, earned) in enumerate(rsrc_rows):
    w(f"%R\t{980000 + i}\t{tid}\t4410\t{rid}\t{budget}\t{earned}\t{max(0, budget - earned)}")
w("%T\tUDFVALUE")
w("%F\tudf_type_id\tfk_id\tproj_id\tudf_text")
for utype, tid, text in udf_rows:
    w(f"%R\t{utype}\t{tid}\t4410\t{text}")
w("%E")

OUT.write_text("\n".join(lines) + "\n")
n_tasks = len(task_rows)
n_miles = sum(1 for r in task_rows if r[6] == "TT_Mile")
print(f"{OUT.name}: {n_tasks} tasks ({n_miles} milestones) · {len(pred_rows)} relationships · "
      f"{len(rsrc_rows)} assignments · {len(udf_rows)} UDF values · {OUT.stat().st_size / 1048576:.1f} MB")
neg = sum(1 for p in pred_rows if p[4] < 0)
print(f"negative lags: {neg}")

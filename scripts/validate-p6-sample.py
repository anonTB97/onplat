#!/usr/bin/env python3
"""Validate the sample P6 XER export for internal consistency.

A sample schedule is a fixture, and a fixture nobody checks rots into a
plausible-looking file that teaches a parser the wrong lessons. Writing this
found two real defects in the first draft of the sample — an activity marked
not-started that carried 180 earned hours, and a cableway relationship modelled
finish-to-start whose own dates overlapped by 58 hours — and corrected a third
misreading: a negative lag was described as a logic violation when P6's
arithmetic in fact permits the overlap. That distinction is now modelled below,
because the two are found by different parts of the system.

It also doubles as the smallest honest reference parser. Note what it does NOT
do: index fields by position. Every value is resolved by name from the `%F` line
of its section, because XER field order is not stable across P6 versions or
export layouts, and a positional parser works until the first upgrade and then
silently reads the wrong column.

Usage:  python3 scripts/validate-p6-sample.py [path/to/export.xer]
Exit:   0 clean, 1 on any violation.
"""

from __future__ import annotations

import datetime as dt
import sys
from pathlib import Path

DEFAULT = Path(__file__).resolve().parent.parent / "reference/p6-sample/CVN73-PIA26.xer"
FMT = "%Y-%m-%d %H:%M"

# Two conditions the sample carries deliberately, and they are NOT the same kind
# of thing. Keeping the distinction is the point: they are found by different
# parts of the system, and one of them P6 cannot find at all.
#
# A schedule-logic violation: the dates contradict the stated relationship, so
# P6's own out-of-sequence report would flag it. Here the HVAC riser is scheduled
# to start a week before the cableway sharing that overhead finishes terminating,
# under a finish-to-start link with no lag.
INTENDED_LOGIC_INVERSIONS = {("A5020", "A4050")}

# A deliberate overlap that P6 is perfectly happy with. A negative lag *permits*
# the successor to start before the predecessor finishes, so the arithmetic checks
# out and no scheduling tool complains: the riser penetration is pulled into the
# coating cure it depends on, on purpose, to save a shift.
#
# This is the more valuable fixture. A conforming schedule that the deconfliction
# engine must still refuse is exactly the class of problem the platform exists for
# and a scheduler cannot see — hot work inside a curing coat is a rule outcome,
# not a date error.
INTENDED_OVERLAPS = {("A6010", "A4050")}


def parse(path: Path) -> dict[str, list[dict[str, str]]]:
    """Reads an XER file into {table: [row-as-dict]}, resolving fields by name."""
    tables: dict[str, list[dict[str, str]]] = {}
    current: str | None = None
    fields: list[str] | None = None
    for lineno, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        cells = raw.split("\t")
        tag = cells[0]
        if tag == "%T":
            current, fields = cells[1], None
            tables[current] = []
        elif tag == "%F":
            fields = cells[1:]
        elif tag == "%R":
            if current is None or fields is None:
                raise SystemExit(f"line {lineno}: %R before %T/%F")
            values = [c.strip() for c in cells[1:]]
            if len(values) != len(fields):
                raise SystemExit(
                    f"line {lineno}: {current} has {len(values)} values "
                    f"for {len(fields)} fields"
                )
            tables[current].append(dict(zip(fields, values)))
        elif tag == "%E":
            current, fields = None, None
    return tables


def when(value: str) -> dt.datetime | None:
    """An XER timestamp, or None. Empty and whitespace both mean absent."""
    return dt.datetime.strptime(value, FMT) if value else None


def check(tables: dict[str, list[dict[str, str]]]) -> list[str]:
    bad: list[str] = []
    tasks = {t["task_id"]: t for t in tables.get("TASK", [])}
    code = lambda tid: tasks[tid]["task_code"]  # noqa: E731

    # Referential integrity across sections.
    keysets = {
        "proj_id": {r["proj_id"] for r in tables.get("PROJECT", [])},
        "wbs_id": {r["wbs_id"] for r in tables.get("PROJWBS", [])},
        "clndr_id": {r["clndr_id"] for r in tables.get("CALENDAR", [])},
        "rsrc_id": {r["rsrc_id"] for r in tables.get("RSRC", [])},
        "udf_type_id": {r["udf_type_id"] for r in tables.get("UDFTYPE", [])},
    }
    for table, columns in (
        ("TASK", ("proj_id", "wbs_id", "clndr_id")),
        ("TASKRSRC", ("proj_id", "rsrc_id")),
        ("UDFVALUE", ("proj_id", "udf_type_id")),
    ):
        for row in tables.get(table, []):
            for column in columns:
                if row[column] not in keysets[column]:
                    bad.append(f"{table}: dangling {column}={row[column]!r}")
    for row in tables.get("PROJWBS", []):
        if row["parent_wbs_id"] and row["parent_wbs_id"] not in keysets["wbs_id"]:
            bad.append(f"PROJWBS {row['wbs_short_name']}: dangling parent")
    for row in tables.get("TASKPRED", []):
        for column in ("task_id", "pred_task_id"):
            if row[column] not in tasks:
                bad.append(f"TASKPRED: dangling {column}={row[column]!r}")
    for row in tables.get("TASKRSRC", []):
        if row["task_id"] not in tasks:
            bad.append(f"TASKRSRC: dangling task_id={row['task_id']!r}")
    for row in tables.get("UDFVALUE", []):
        if row["fk_id"] not in tasks:
            bad.append(f"UDFVALUE: dangling fk_id={row['fk_id']!r}")

    for task in tables.get("TASK", []):
        name = task["task_code"]
        # Dates parse, and no pair runs backwards.
        for start, finish in (
            ("target_start_date", "target_end_date"),
            ("early_start_date", "early_end_date"),
            ("act_start_date", "act_end_date"),
        ):
            a, b = when(task[start]), when(task[finish])
            if a and b and b < a:
                bad.append(f"{name}: {start} after {finish}")
        # A real activity always has the CPM pair — it is the one WADL works to.
        if task["task_type"] == "TT_Task" and not (
            task["early_start_date"] and task["early_end_date"]
        ):
            bad.append(f"{name}: task with no early_start/early_end")
        # Status must agree with the actuals. This is the check that caught a
        # not-started activity carrying 180 earned hours.
        status = task["status_code"]
        started, finished = task["act_start_date"], task["act_end_date"]
        if status == "TK_NotStart" and (started or finished):
            bad.append(f"{name}: TK_NotStart with actual dates")
        if status == "TK_Active" and (not started or finished):
            bad.append(f"{name}: TK_Active needs an actual start and no actual finish")
        if status == "TK_Complete" and not (started and finished):
            bad.append(f"{name}: TK_Complete without both actual dates")

    # Hours must add up, and agree with status.
    for row in tables.get("TASKRSRC", []):
        target, actual, remain = (
            float(row[k]) for k in ("target_qty", "act_reg_qty", "remain_qty")
        )
        name = code(row["task_id"])
        if abs((actual + remain) - target) > 0.5:
            bad.append(f"{name}: {actual} + {remain} != {target} units")
        status = tasks[row["task_id"]]["status_code"]
        if status == "TK_Complete" and remain != 0:
            bad.append(f"{name}: complete but {remain} units remain")
        if status == "TK_NotStart" and actual != 0:
            bad.append(f"{name}: not started but {actual} units earned")

    # Finish-to-start logic must be satisfied by the dates, bar the inversions the
    # fixture carries on purpose.
    for row in tables.get("TASKPRED", []):
        if row["pred_type"] != "PR_FS":
            continue
        pred, succ = tasks[row["pred_task_id"]], tasks[row["task_id"]]
        finish, start = when(pred["early_end_date"]), when(succ["early_start_date"])
        if not (finish and start):
            continue
        gap = (start - finish).total_seconds() / 3600
        lag = float(row["lag_hr_cnt"])
        pair = (pred["task_code"], succ["task_code"])
        if gap < lag - 0.01 and pair not in INTENDED_LOGIC_INVERSIONS:
            bad.append(
                f"{pair[0]} -> {pair[1]}: FS gap {gap:.0f}h is less than lag {lag:.0f}h"
            )

    # Both fixtures must still be what they claim, or the sample has quietly lost
    # a test case — which is worse than never having had it, because the file still
    # looks like it covers the ground.
    by_code = {t["task_code"]: t for t in tables.get("TASK", [])}

    def relationship(pred_code: str, succ_code: str) -> dict[str, str] | None:
        for row in tables.get("TASKPRED", []):
            if code(row["pred_task_id"]) == pred_code and code(row["task_id"]) == succ_code:
                return row
        return None

    for pred_code, succ_code in INTENDED_LOGIC_INVERSIONS:
        row = relationship(pred_code, succ_code)
        if row is None:
            bad.append(f"{pred_code} -> {succ_code}: intended inversion is missing")
            continue
        finish = when(by_code[pred_code]["early_end_date"])
        start = when(by_code[succ_code]["early_start_date"])
        lag = float(row["lag_hr_cnt"])
        if finish and start and (start - finish).total_seconds() / 3600 >= lag - 0.01:
            bad.append(
                f"{pred_code} -> {succ_code}: the dates no longer contradict the "
                "relationship; the fixture has lost this test case"
            )

    for pred_code, succ_code in INTENDED_OVERLAPS:
        row = relationship(pred_code, succ_code)
        if row is None:
            bad.append(f"{pred_code} -> {succ_code}: intended overlap is missing")
            continue
        lag = float(row["lag_hr_cnt"])
        finish = when(by_code[pred_code]["early_end_date"])
        start = when(by_code[succ_code]["early_start_date"])
        if lag >= 0:
            bad.append(f"{pred_code} -> {succ_code}: lag is no longer negative")
        elif finish and start:
            gap = (start - finish).total_seconds() / 3600
            if gap >= 0:
                bad.append(
                    f"{pred_code} -> {succ_code}: no longer overlaps "
                    f"(gap {gap:.0f}h); the fixture has lost this test case"
                )
            elif gap < lag - 0.01:
                # Overlapping by MORE than the lag permits would make this a logic
                # violation as well, muddying what the fixture is for.
                bad.append(
                    f"{pred_code} -> {succ_code}: overlap {gap:.0f}h exceeds the "
                    f"lag {lag:.0f}h, so it is now a logic violation too"
                )
            else:
                print(
                    f"  intended overlap intact: {pred_code} -> {succ_code} "
                    f"starts {-gap:.0f}h before its predecessor finishes, "
                    f"permitted by a {lag:.0f}h lag — P6 is satisfied, the engine "
                    "must not be"
                )

    # Compartment coverage, reported rather than enforced: the sample deliberately
    # leaves one activity without one so an ingest run meets the absent case.
    compartment_udf = next(
        (
            u["udf_type_id"]
            for u in tables.get("UDFTYPE", [])
            if u["udf_type_name"] == "compartment"
        ),
        None,
    )
    if compartment_udf is None:
        bad.append("UDFTYPE: no 'compartment' user-defined field")
    else:
        have = {
            u["fk_id"]
            for u in tables.get("UDFVALUE", [])
            if u["udf_type_id"] == compartment_udf
        }
        missing = [
            t["task_code"]
            for t in tables.get("TASK", [])
            if t["task_type"] == "TT_Task" and t["task_id"] not in have
        ]
        print(
            f"  activities with no compartment UDF: "
            f"{', '.join(missing) if missing else 'none'}"
            f"  ({len(missing)} of {sum(1 for t in tables.get('TASK', []) if t['task_type'] == 'TT_Task')} tasks)"
        )
        if not missing:
            bad.append(
                "every activity carries a compartment; the fixture no longer "
                "exercises the absent case"
            )

    return bad


def main() -> int:
    path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT
    tables = parse(path)
    print(f"{path.name}: " + ", ".join(f"{k}={len(v)}" for k, v in tables.items()))
    problems = check(tables)
    for line in problems:
        print(f"  FAIL  {line}")
    print("clean" if not problems else f"{len(problems)} problem(s)")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())

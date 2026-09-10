#!/usr/bin/env python3
"""Scale the reference XER into a stress-test schedule.

Clones the CVN-73 sample's TASK / TASKPRED / TASKRSRC / UDFVALUE tables K
times with offset ids and suffixed activity codes, producing a schedule of
~1,561*K activities at key-op grain over the same hull, same availability
window, same compartment register. Dates are kept as-is on purpose: tens of
thousands of concurrently-planned activities is the worst case for every
window computation, and a stress test that staggered them would be measuring
a kinder world than the one it claims to.

Usage: gen-xer.py <base.xer> <out.xer> [clones=26]
"""

import sys


def main() -> None:
    base_path, out_path = sys.argv[1], sys.argv[2]
    clones = int(sys.argv[3]) if len(sys.argv) > 3 else 26

    lines = open(base_path, encoding="utf-8", errors="replace").read().split("\n")

    # Partition the file: everything up to the first cloned table is shared
    # header (currencies, calendars, project, WBS, resources, UDF types).
    CLONED = {"TASK", "TASKPRED", "TASKRSRC", "UDFVALUE"}
    ID_OFFSET = 10_000_000  # per-clone id stride, far above the base ids

    out = []
    table = None
    fields: list[str] = []
    # Collect cloned-table rows to re-emit K times.
    rows: dict[str, list[list[str]]] = {t: [] for t in CLONED}
    headers: dict[str, str] = {}

    for line in lines:
        if line.startswith("%T"):
            table = line.split("\t")[1]
            if table in CLONED:
                headers[table] = line
                continue
        elif table in CLONED:
            if line.startswith("%F"):
                headers[table] += "\n" + line
                fields = line.split("\t")[1:]
                rows[table].append(["%FIELDS%"] + fields)
                continue
            if line.startswith("%R"):
                rows[table].append(line.split("\t")[1:])
                continue
            if not line.strip():
                continue
        out.append(line)

    def emit(table: str) -> None:
        out.append(headers[table])
        field_names = rows[table][0][1:]
        data = rows[table][1:]
        idx = {name: i for i, name in enumerate(field_names)}
        for k in range(clones):
            off = k * ID_OFFSET
            for r in data:
                r2 = list(r)
                for col in ("task_id", "task_pred_id", "pred_task_id", "taskrsrc_id", "fk_id"):
                    if col in idx and r2[idx[col]]:
                        r2[idx[col]] = str(int(r2[idx[col]]) + off)
                if k > 0 and "task_code" in idx:
                    r2[idx["task_code"]] = f"{r2[idx['task_code']]}C{k:02d}"
                out.append("%R\t" + "\t".join(r2))

    for t in ("TASK", "TASKPRED", "TASKRSRC", "UDFVALUE"):
        emit(t)

    open(out_path, "w", encoding="utf-8").write("\n".join(out) + "\n")
    n_tasks = (len(rows["TASK"]) - 1) * clones
    print(f"wrote {out_path}: {n_tasks} tasks ({clones} clones)")


if __name__ == "__main__":
    main()

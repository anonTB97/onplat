// The schedule door's pure parts: the decoder branch the browser reports,
// the words the field map, the quarantine and the runs read in, and the
// breadcrumb's sentence — pinned here so the card, the crumb and the server
// keep saying the same thing about the same run.

import { describe, expect, it } from "vitest";
import type { QuarantinedRow, ScheduleRunSummary } from "./api";
import {
  decodeXerBytes,
  exclusionSummary,
  fieldChoices,
  fieldMapSummary,
  foldRows,
  importedByWords,
  quarantineGroups,
  quarantineSummary,
  runLine,
  scheduleCrumb,
} from "./ingest";

// The literal shared with `wadl_ingest::encoding`: bytes 93 94 E9 96 80 are
// “ ” é – € in Windows-1252 and not valid UTF-8, so both decoders take the
// same branch on them.
const SHARED_BYTES = new Uint8Array([0x93, 0x94, 0xe9, 0x96, 0x80]);
const SHARED_TEXT = "“”é–€";

describe("decodeXerBytes", () => {
  it("decodes a windows-1252 export and says so", () => {
    const head = new TextEncoder().encode("%R\tA1\tCaf");
    const bytes = new Uint8Array([...head, ...SHARED_BYTES, ...new TextEncoder().encode(" prep\n")]);
    const { xer, encoding } = decodeXerBytes(bytes);
    expect(encoding).toBe("windows-1252");
    expect(xer).toBe(`%R\tA1\tCaf${SHARED_TEXT} prep\n`);
    // A whole tab-delimited line keeps its structure around the high bytes.
    expect(xer.split("\t")).toHaveLength(3);
  });

  it("a utf-8 export passes through as utf-8, with a byte-order mark stripped", () => {
    const plain = new TextEncoder().encode("%T\tTASK\n%R\tCafé\n");
    expect(decodeXerBytes(plain)).toEqual({ xer: "%T\tTASK\n%R\tCafé\n", encoding: "utf-8" });
    const withBom = new Uint8Array([0xef, 0xbb, 0xbf, ...plain]);
    const { xer, encoding } = decodeXerBytes(withBom.buffer);
    expect(encoding).toBe("utf-8");
    expect(xer.startsWith("%T")).toBe(true);
  });
});

const SEEN = {
  projects: [
    { id: "4410", short_name: "CVN73-PIA26", tasks: 14 },
    { id: "4411", short_name: "CVN73-DSRA27", tasks: 2 },
  ],
  udfs: [
    { name: "COMPT", label: "Location placard", table: "TASK", values: 8 },
    { name: "WI", label: "Work Item", table: "TASK", values: 8 },
  ],
  activity_code_types: [{ name: "LOC", values: 1 }],
  resource_types: { RT_Labor: 9, RT_Mat: 1, RT_Equip: 1 },
  has_rsrc_type: true,
  task_types: { TT_Task: 12, TT_Mile: 0, TT_FinMile: 1, TT_LOE: 3, TT_WBS: 1 },
  sections: { TASK: 17 },
};

describe("fieldChoices", () => {
  it("lists the file's own fields with their row counts and (none)", () => {
    const labels = fieldChoices(SEEN, "compartment").map((c) => c.label);
    expect(labels).toEqual([
      "(none)",
      "UDF: COMPT — Location placard (8 rows)",
      "UDF: WI — Work Item (8 rows)",
      "Activity code: LOC (1)",
    ]);
    // The trade slot alone offers the resource.
    expect(fieldChoices(SEEN, "trade")[1]?.label).toMatch(/^Resource \(RSRC/);
    expect(fieldChoices(SEEN, "work_item").some((c) => c.key === "resource")).toBe(false);
    // A stored choice the file does not carry keeps its option, marked.
    const kept = fieldChoices(SEEN, "compartment", { source: "udf", name: "compartment" });
    expect(kept.at(-1)?.label).toBe('UDF "compartment" — not in this file');
    // No file surveyed yet: only (none) — and the resource for the trade.
    expect(fieldChoices(null, "compartment").map((c) => c.key)).toEqual(["none"]);
  });
});

const ROW = (line: number, cls: string, table = "TASK"): QuarantinedRow => ({
  line,
  table,
  code: `A${line}`,
  class: cls,
  reason: `line ${line}`,
});

describe("the quarantine", () => {
  it("fieldMapSummary and quarantineSummary read in yard words", () => {
    expect(
      fieldMapSummary({
        compartment: { source: "udf", name: "COMPT" },
        work_item: { source: "udf", name: "WI" },
        work_type: { source: "none" },
        trade: { source: "resource" },
        projects: ["CVN73-PIA26"],
        placards_from_names: true,
      }),
    ).toBe(
      'compartment ← UDF "COMPT" · work item ← UDF "WI" · work type ← not carried · trade ← resource · projects: CVN73-PIA26 · placards read from task names',
    );
    expect(quarantineSummary([])).toBe("nothing quarantined");
    expect(
      quarantineSummary([
        ROW(44, "unparseable_date"),
        ROW(45, "width"),
        ROW(58, "cross_project_logic", "TASKPRED"),
        ROW(59, "cross_project_logic", "TASKPRED"),
        ROW(60, "cross_project_logic", "TASKPRED"),
        ROW(61, "unparseable_date"),
      ]),
    ).toBe("6 quarantined — 3 cross-project logic, 2 unparseable dates, 1 width");
    expect(
      exclusionSummary({ loe: ["A9001", "A9002", "A9003"], wbs: ["Z6-SUM"], project: [["D1010", "CVN73-DSRA27"], ["D1020", "CVN73-DSRA27"]] }),
    ).toBe("excluded: 3 level-of-effort (A9001, A9002, A9003) · 1 WBS summary (Z6-SUM) · 2 in project CVN73-DSRA27");
    expect(exclusionSummary({ loe: [], wbs: [], project: [] })).toBe("nothing excluded");
  });

  it("groups by class, largest first, and folds at 25 with the count behind the foot", () => {
    const rows = [
      ...Array.from({ length: 20 }, (_, i) => ROW(100 + i, "width")),
      ...Array.from({ length: 8 }, (_, i) => ROW(200 + i, "unparseable_date")),
      ROW(300, "cross_project_logic", "TASKPRED"),
    ];
    const groups = quarantineGroups(rows);
    expect(groups.map((g) => [g.class, g.rows.length])).toEqual([
      ["width", 20],
      ["unparseable_date", 8],
      ["cross_project_logic", 1],
    ]);
    const folded = foldRows(rows, false);
    expect(folded.shown).toHaveLength(25);
    expect(folded.hidden).toBe(4);
    expect(folded.shown[0]?.line).toBe(100);
    const all = foldRows(rows, true);
    expect(all.shown).toHaveLength(29);
    expect(all.hidden).toBe(0);
    // Under the limit there is no fold to speak of.
    expect(foldRows(rows.slice(0, 3), false)).toEqual({ shown: rows.slice(0, 3), hidden: 0 });
  });
});

const RUN = (over: Partial<ScheduleRunSummary> = {}): ScheduleRunSummary => ({
  run_id: "00000000-0000-8000-8000-000000000001",
  seq: 2,
  label: "CVN73-PIA26-yardshape.xer",
  // 2026-09-04 14:12:00Z
  imported_at_ms: Date.UTC(2026, 8, 4, 14, 12),
  imported_by: { org: "00000000-0000-0000-0000-000000000001", person: "dev:planner", via: "door" },
  encoding: "windows-1252",
  decoded_by: "browser",
  projects_served: ["CVN73-PIA26"],
  counts: {
    task_rows: 17, served: 9, work: 8, key_events: 1, quarantined: 3, excluded_loe: 3, excluded_wbs: 1,
    excluded_project: 2, edges: 4, edges_quarantined: 1, material_skipped: 1, equipment_skipped: 1,
  },
  field_map: {
    compartment: { source: "udf", name: "COMPT" },
    work_item: { source: "udf", name: "WI" },
    work_type: { source: "none" },
    trade: { source: "resource" },
    projects: ["CVN73-PIA26"],
    placards_from_names: true,
  },
  served: true,
  schema_version: 1,
  ...over,
});

describe("the breadcrumb and the runs", () => {
  it("names the export, when it came in and whose it is — never blank", () => {
    // Under the UTC default (no yard clock in these tests) the time carries Z.
    expect(scheduleCrumb(RUN())).toEqual({
      text: "reading CVN73-PIA26-yardshape.xer · imported 09/04 14:12Z by Demo Planner (Y-1001)",
      tone: "ok",
    });
    // A boot run has no person: the org, honestly, in amber.
    const boot = RUN({ seq: 1, label: "CVN73-PIA26-full.xer", imported_by: { org: "00000000-0000-0000-0000-000000000001", person: null, via: "boot" } });
    expect(scheduleCrumb(boot)).toEqual({
      text: "reading CVN73-PIA26-full.xer · imported 09/04 14:12Z by org …0001 (no person on record) · at boot",
      tone: "warn",
    });
    // A person the shell cannot name is shown as the id the proxy asserted.
    expect(importedByWords({ org: "x", person: "u:12345", via: "door" })).toBe("u:12345");
    expect(scheduleCrumb(null)).toEqual({ text: "reading the generated register", tone: "dim" });
    expect(scheduleCrumb("unavailable")).toEqual({ text: "schedule source unavailable", tone: "warn" });
  });

  it("writes one run's line for the history", () => {
    expect(runLine(RUN())).toBe(
      "#2 · CVN73-PIA26-yardshape.xer · 09/04 14:12Z · by Demo Planner (Y-1001) · 9 rows served · 3 quarantined · windows-1252",
    );
    expect(runLine(RUN({ seq: 1, counts: { ...RUN().counts, served: 5706, quarantined: 0 }, encoding: "utf-8" }))).toContain(
      "5,706 rows served · 0 quarantined · utf-8",
    );
  });
});

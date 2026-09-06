// What the door-side parsers are allowed to carry to the server.
//
// A parser that drops a row it did not understand imports "whole" minus the
// losses — the exact thing the all-or-nothing doors exist to prevent — so
// the refusals are pinned here alongside the shapes.

import { describe, expect, it } from "vitest";
import { deltaSummary, hazardKindFromLog, parseCouplingCsv, parseHazardLogCsv, parseRegisterCsv } from "./ingest";

describe("deltaSummary", () => {
  const base = {
    baseline: "CVN73-PIA26-full.xer",
    added: 0, removed: 0, retimed: 0, rehoused: 0,
    newly_refused: { count: 0, examples: [] },
    newly_clear: { count: 0 },
  };

  it("reads a re-import — and a run-to-run diff, which is the same shape — in one sentence", () => {
    expect(deltaSummary(base)).toBe("vs CVN73-PIA26-full.xer: no rows changed — no work moved into a refusal");
    expect(
      deltaSummary({
        ...base,
        added: 8, removed: 5697, retimed: 0, rehoused: 1,
        newly_refused: { count: 4, examples: [{ code: "A2010", space: "1-136-0-Q", rule: "R04" }] },
        newly_clear: { count: 2 },
      }),
    ).toBe("vs CVN73-PIA26-full.xer: +8 new · −5697 gone · 1 moved space — ⚠ 4 newly NOT executable (A2010 in 1-136-0-Q by R04, …) · 2 refusals cleared");
  });

  it("closes the loop on proposals when the board has any open", () => {
    expect(deltaSummary({ ...base, retimed: 2, proposals: { open: 2, reflected: ["A51350"], still_open: ["A51360"] } })).toBe(
      "vs CVN73-PIA26-full.xer: 2 retimed — no work moved into a refusal · proposals: 1 of 2 reflected (A51350), 1 still open",
    );
  });
});

describe("parseRegisterCsv", () => {
  it("carries decks and spaces, with the optional frame and side when present", () => {
    const { decks, spaces } = parseRegisterCsv(
      [
        "# CVN73 compartment list",
        "deck,3rd,Third Deck,3",
        "deck,2nd,,2",
        "space,3-148-2-E,Switchgear,3rd,Z5,Electrical,148,Port",
        "space,2-160-2-Q,Passage,2nd,Z6,Passage",
        "",
      ].join("\n"),
    );
    expect(decks).toEqual([
      { code: "3rd", label: "Third Deck", ordinal: 3 },
      { code: "2nd", label: "2nd", ordinal: 2 },
    ]);
    expect(spaces).toEqual([
      { compartment_no: "3-148-2-E", name: "Switchgear", deck_code: "3rd", zone: "Z5", category: "Electrical", frame: 148, side: "port" },
      { compartment_no: "2-160-2-Q", name: "Passage", deck_code: "2nd", zone: "Z6", category: "Passage" },
    ]);
  });

  it("refuses the file on a record kind it cannot carry", () => {
    expect(() => parseRegisterCsv("deck,3rd,Third,3\nbulkhead,x,y")).toThrow(/unrecognised record kind "bulkhead"/);
  });
});

describe("parseCouplingCsv", () => {
  it("reads authored edges and the symmetric flag in its yard spellings", () => {
    const rows = parseCouplingCsv("3-148-2-E,3-160-2-Q,shared_bulkhead,yes\n2-160-2-Q,3-160-2-Q,deck_penetration\n");
    expect(rows).toEqual([
      { from: "3-148-2-E", to: "3-160-2-Q", code: "shared_bulkhead", symmetric: true, provenance: "authored" },
      { from: "2-160-2-Q", to: "3-160-2-Q", code: "deck_penetration", symmetric: false, provenance: "authored" },
    ]);
  });
});

describe("parseHazardLogCsv", () => {
  it("accepts the engine's names and the yard's words for a kind", () => {
    expect(hazardKindFromLog("hot_work_live")).toBe("hot_work_live");
    expect(hazardKindFromLog("Hot work live")).toBe("hot_work_live");
    expect(hazardKindFromLog("STOP-WORK")).toBe("stop_work");
    expect(hazardKindFromLog("gremlins")).toBeNull();
  });

  it("keeps a label's commas and reads the trailing instant either way", () => {
    const rows = parseHazardLogCsv(
      [
        "3-148-2-E,energised_bus,Bus 3-SG-2 energised — no ZES,2026-09-02T06:00:00Z",
        "3-160-2-Q,Coating open,Deck coat, second pass,1756800000000",
        "5-140-0-JJ,flammable_stow,JP-5 open, tank 5-140-0-JJ",
      ].join("\n"),
    );
    expect(rows).toEqual([
      { compartment: "3-148-2-E", kind: "energised_bus", label: "Bus 3-SG-2 energised — no ZES", since_ms: Date.parse("2026-09-02T06:00:00Z") },
      { compartment: "3-160-2-Q", kind: "coating_open", label: "Deck coat, second pass", since_ms: 1756800000000 },
      { compartment: "5-140-0-JJ", kind: "flammable_stow", label: "JP-5 open, tank 5-140-0-JJ" },
    ]);
  });

  it("refuses the file on a kind the engine does not evaluate, naming the line", () => {
    expect(() => parseHazardLogCsv("3-148-2-E,energised_bus,ok\n3-160-2-Q,radiation,bad")).toThrow(/line 2: "radiation"/);
  });

  it("refuses a since column that looks like an instant but is not one", () => {
    expect(() => parseHazardLogCsv("3-148-2-E,stop_work,posted,2026-13-45")).toThrow(/is not an instant/);
  });
});

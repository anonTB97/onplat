// What the change request is allowed to say to P6: the first six columns are
// P6's activity-import layout, a hold carries no date, and every row carries
// its own evidence — reason, engine verdict, ledger entry.

import { describe, expect, it } from "vitest";
import type { ScheduleProposal } from "./api";
import { changeRequestCsv } from "./Proposals";

const base: ScheduleProposal = {
  seq: 41,
  entry_hash: "abc123",
  proposed_at_ms: Date.UTC(2026, 8, 2, 14, 30),
  activity: "A00420",
  name: "Prime coat, deck coating 3B — CPO berthing",
  compartment: "3-148-0-L",
  trade: "SM-PRES",
  from: { start: Date.UTC(2026, 8, 7, 6), end: Date.UTC(2026, 8, 12, 18) },
  to: { start: Date.UTC(2026, 8, 14, 6), end: Date.UTC(2026, 8, 19, 18) },
  kind: "engine_window",
  reason: 'slide past the cure, "per the chemist"',
  verdict: { verdict: "executable" },
  pushes: ["A00430", "A00440"],
  knock_on_basis: "finish-to-start, lags not applied",
  status: "open",
  planned_now: null,
};

describe("changeRequestCsv", () => {
  it("writes P6's import columns first, then the evidence, and escapes the prose", () => {
    const lines = changeRequestCsv([base], "CVN-73 PIA-26", "wk34.xer", Date.UTC(2026, 8, 2, 16));
    expect(lines[0]).toContain("CVN-73 PIA-26");
    expect(lines[0]).toContain("wk34.xer");
    expect(lines[3]).toBe(
      "Activity ID,Activity Name,Start,Finish,Primary Constraint,Primary Constraint Date,Delay Days,Kind,Reason,Engine Verdict,Knock-on,Proposed At,Ledger Seq,Ledger Hash",
    );
    expect(lines[4]).toBe(
      'A00420,"Prime coat, deck coating 3B — CPO berthing",2026-09-14 06:00,2026-09-19 18:00,Start On or After,2026-09-14 06:00,7,engine_window,"slide past the cure, ""per the chemist""","executable","A00430 A00440",2026-09-02 14:30,41,abc123',
    );
  });

  it("a hold pending verification promises no date", () => {
    const hold: ScheduleProposal = { ...base, seq: 42, to: null, kind: "hold_pending_verification", verdict: null, pushes: [] };
    const row = changeRequestCsv([hold], "CVN-73", null, null)[4] ?? "";
    expect(row.startsWith("A00420,")).toBe(true);
    expect(row).toContain(",,,Hold pending verification,,,hold_pending_verification,");
    expect(row).toContain('"no date promised"');
  });
});

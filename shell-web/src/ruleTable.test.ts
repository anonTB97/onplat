import { describe, expect, it } from "vitest";
import type { RowReport, WorkTypeAudit } from "./api";
import {
  inForceLine,
  movedLine,
  rowLine,
  signStatement,
  signoffLine,
  statusOf,
  tableRows,
  workTypeLine,
} from "./ruleTable";

const r04: RowReport = {
  rule: "R04",
  ordinal: 0,
  line: 7,
  name: "Hot work overhead of occupied space",
  kind: "Hazard cascade",
  compiled: true,
  why_not: null,
  entry: {
    hazard: "hot_work_live",
    applies: { coupled: { code: "deck_penetration", max_hops: 1 } },
    state: "SUSPEND",
    hold: 30,
    hold_from: "end",
    clearing_authority: "fire_marshal",
    work_types: [],
    categories: [],
    effective_from: "",
    effective_to: "",
  },
  version: "00000000-0000-0000-0000-000000000402",
  fires_on: { hazards: 8, spaces: ["6-216-1-J"], space_count: 7, activities_bound: 23 },
};

const r03: RowReport = {
  ...r04,
  rule: "R03",
  ordinal: 1,
  name: "Coating cure",
  entry: {
    ...r04.entry!,
    hazard: "coating_open",
    state: "BLOCK",
    hold: 480,
    hold_from: "raise",
    clearing_authority: "marine_chemist",
    work_types: ["hot_work"],
  },
  version: "00000000-0000-0000-0000-000000000301",
  fires_on: { hazards: 8, spaces: [], space_count: 0, activities_bound: 0 },
};

const r08: RowReport = {
  rule: "R08",
  ordinal: 0,
  line: 11,
  name: "Confined space entry",
  kind: "Permit gate",
  compiled: false,
  why_not: "Permit gate needs a permit object (out of the pilot)",
  entry: null,
  version: null,
  fires_on: null,
};

describe("rowLine", () => {
  it("reads a compiled and a not-compiled row in yard words", () => {
    expect(rowLine(r04)).toBe(
      "R04 · Hot work overhead of occupied space · SUSPEND · deck_penetration 1 hop · any work · hold 30 min from the permit's close · fires on 7 spaces (23 activities)",
    );
    expect(rowLine(r03)).toBe(
      "R03-1 · Coating cure · BLOCK · deck_penetration 1 hop · hot_work · hold 480 min · fires on nothing today",
    );
    expect(rowLine(r08)).toBe(
      "R08 · Confined space entry · not compiled — Permit gate needs a permit object (out of the pilot)",
    );
  });

  it("lays the report out as table rows, file order kept", () => {
    const rows = tableRows([r04, r03, r08]);
    expect(rows.map((r) => r.ref)).toEqual(["R04-0", "R03-1", "R08-0"]);
    expect(rows[0]).toMatchObject({ state: "SUSPEND", reach: "deck_penetration 1 hop", work: "any work", version: "00000000" });
    expect(rows[2]).toMatchObject({ compiled: false, state: "—", whyNot: r08.why_not });
  });
});

describe("movedLine", () => {
  it("counts and names the first spaces", () => {
    expect(movedLine({ spaces: 0, examples: [] })).toBe("0 spaces change state right now");
    expect(
      movedLine({
        spaces: 14,
        examples: [
          { compartment: "3-156-2-Q", before: "WARN", after: "ALLOW", rule: "R06" },
          { compartment: "3-160-2-Q", before: "BLOCK", after: "SUSPEND", rule: "R03" },
          { compartment: "4-74-0-Q", before: "SUSPEND", after: "ALLOW", rule: "" },
          { compartment: "5-1-0-A", before: "ALLOW", after: "WARN", rule: "R09" },
        ],
      }),
    ).toBe(
      "14 spaces change state · 3-156-2-Q WARN → ALLOW (R06) · 3-160-2-Q BLOCK → SUSPEND (R03) · 4-74-0-Q SUSPEND → ALLOW · +11 more",
    );
  });
});

describe("signoffLine", () => {
  const fmt = (ms: number) => `t${ms}`;
  it("says unsigned in amber words and names the signer when signed", () => {
    expect(signoffLine({ source: "seed", signoff: null }, fmt)).toEqual({
      text: "unsigned — the seed is in force; the safety authority signs a committed table",
      tone: "warn",
    });
    expect(signoffLine({ source: "document", signoff: null }, fmt)).toEqual({
      text: "unsigned — committed, awaiting the safety authority's signature",
      tone: "warn",
    });
    expect(
      signoffLine(
        {
          source: "document",
          signoff: {
            signed_at_ms: 42,
            signer_id: "1234567890",
            signer_name: "R. Alvarez",
            statement: "Reviewed.",
            table_hash: "abc",
            rows: [],
            ledger_seq: 212,
          },
        },
        fmt,
      ),
    ).toEqual({ text: "signed by R. Alvarez · t42 · ledger #212", tone: "ok" });
  });

  it("reads the status as SEED, INGESTED or SIGNED", () => {
    expect(statusOf({ source: "seed", signoff: null }).label).toBe("SEED");
    expect(statusOf({ source: "document", signoff: null }).label).toBe("INGESTED");
    expect(statusOf({ source: "document", signoff: { signed_at_ms: 0, signer_id: "x", signer_name: "X", statement: "", table_hash: "", rows: [], ledger_seq: 1 } }).label).toBe("SIGNED");
  });
});

describe("workTypeLine", () => {
  it("lists what the schedule carries and what nothing binds", () => {
    const wt: WorkTypeAudit = {
      on_schedule: [
        { work_type: "hot_work", activities: 1204 },
        { work_type: "coating", activities: 980 },
        { work_type: "rigging", activities: 12 },
      ],
      bound: ["hot_work", "coating"],
      unbound_on_schedule: ["rigging"],
      unseen_in_table: [],
    };
    expect(workTypeLine(wt)).toEqual({
      text: "on the schedule: hot_work 1,204 · coating 980 · rigging 12 · unbound: rigging — judged by the any-work rows only",
      unbound: true,
    });
    expect(workTypeLine({ ...wt, unbound_on_schedule: [], unseen_in_table: ["plasma"] })).toEqual({
      text: "on the schedule: hot_work 1,204 · coating 980 · rigging 12 · every work type on the schedule is named by a row · named by no activity: plasma",
      unbound: false,
    });
  });
});

describe("inForceLine and the statement", () => {
  it("counts entries, rule ids and rows not compiled", () => {
    expect(inForceLine({ rows: [r04, r03], rows_total: 2, rows_in_force: 2 })).toBe("2 entries in force from 2 rows");
    expect(inForceLine({ rows: [r04, r03, r08], rows_total: 20, rows_in_force: 2 })).toBe(
      "2 entries in force from 2 of 20 rows · 1 not compiled, kept on file with their reason",
    );
  });

  it("writes the statement with the signer, the label, the count and the short hash", () => {
    expect(
      signStatement({ label: "CVN73-rule-table.csv", rows_in_force: 10, table_hash: "deadbeefcafe0000" }, "R. Alvarez"),
    ).toBe(
      "I, R. Alvarez, have read the 10 entries in force of CVN73-rule-table.csv (deadbeef) against the golden traces and sign this as the table the hull runs.",
    );
  });
});

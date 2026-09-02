// Reports: dated cuts of what the screens already know, as tables a person
// can print, export, and take to a meeting.
//
// A report here is a pure function from served facts to a table model. The
// screen renders the model, the printer renders the same model in monochrome,
// and the CSV is the same model again — one derivation, three surfaces, so
// the sheet on the clipboard wall cannot disagree with the screen it came
// from. Every report carries its cut: hull, instant, schedule source, and who
// produced it, because a sheet found on a desk next month has to say what it
// spoke for. Every figure names its layer in the footer: man-hours from the
// schedule of record, verdicts from the engine, estimates from the shell.
//
// Nothing here fetches. Builders take exactly the rows the app already holds.

import type { Activity, DeckStateRow, Decision, Issue, LiveHazard } from "./api";
import { fmtDay, fmtDayTime } from "./clock";
import { STATE_STYLE } from "./theme";
import { activityWindowHours, refusalOverlaps } from "./windowLoad";

export type ReportId = "shift" | "zone" | "compartment" | "conflicts" | "conditions";

/** The catalogue: what each report is, for whom, and what it answers. */
export const CATALOGUE: { id: ReportId; name: string; audience: string; question: string }[] = [
  { id: "shift", name: "Shift sheet", audience: "trade foremen · production super", question: "Who goes where this shift, and what stands in front of them" },
  { id: "zone", name: "Zone day sheet", audience: "zone managers", question: "What runs in my zone, what is held, and who clears it" },
  { id: "compartment", name: "Compartment card", audience: "foremen · safety · ship's force", question: "Everything about one space: work in it, what holds it, who can release it" },
  { id: "conflicts", name: "Conflict log", audience: "superintendents · safety · project management", question: "Every open conflict, ranked, with what was answered for" },
  { id: "conditions", name: "Field-condition register", audience: "safety · ship's force · planners", question: "Every open field condition on the hull: where, since when, who clears it" },
];

export interface ReportCut {
  hull: string;
  /** The instant the cut was taken at, epoch ms. */
  asOfMs: number;
  /** The schedule label the register came from; null = the generated demo register. */
  scheduleSource: string | null;
  /** The role that produced it — the person once identity lands. */
  producedBy: string;
}

export interface ReportSection {
  heading: string;
  note?: string;
  columns: string[];
  /** Right-aligned column indexes (figures). */
  numeric?: number[];
  rows: string[][];
}

export interface Report {
  id: ReportId;
  name: string;
  question: string;
  /** The scope the report was cut to — "Zone Z6", "Days 0700–1530 (Z)". */
  scope: string;
  cut: ReportCut;
  sections: ReportSection[];
  /** Layer notes: where each kind of figure comes from. */
  notes: string[];
}

/* ------------------------------------------------------------- vocabulary */

const LAYER_NOTES = [
  "MH: man-hours from the schedule of record, pro-rated by window where a shift is named.",
  "Held, refused, not executable: the engine's verdicts at the cut instant.",
  "Field conditions: recorded facts on the hull as of the cut; a clearance keeps its own time.",
];

const mh = (n: number): string => `${Math.round(n).toLocaleString()} MH`;

/** A space's zone, deck and name from the served register, or dashes. */
function spaceIndex(spaces: DeckStateRow[]): Map<string, DeckStateRow> {
  return new Map(spaces.map((r) => [r.compartment.compartment_no, r]));
}

const zoneOf = (idx: Map<string, DeckStateRow>, no: string | null): string =>
  (no && idx.get(no)?.compartment.zone) || "—";

/** The engine's state in yard words, with the code kept as a tail. */
const stateWord = (s: DeckStateRow["state"]): string => `${STATE_STYLE[s].label} (${s})`;

/** Which space an issue is about, when it is about one. */
export function issueSpace(i: Issue): string | null {
  switch (i.kind) {
    case "not_executable_as_planned":
    case "held_with_crews_booked":
    case "compound_hold":
    case "stranding_concentration":
      return i.compartment;
    case "negative_lag":
      return null;
  }
}

/** The issue in one line — the same sentence the Conflicts board uses. */
function issueClaim(i: Issue): string {
  switch (i.kind) {
    case "not_executable_as_planned":
      return `${i.activity} — ${i.name}`;
    case "held_with_crews_booked":
      return `${i.compartment} refuses work with crews booked into it`;
    case "compound_hold":
      return `${i.compartment} needs ${i.plan_actions > 0 ? `a ${i.plan_actions}-action plan` : "a plan nothing yet satisfies"}`;
    case "stranding_concentration":
      return `${i.compartment} is stranding ${i.downstream_segments} downstream segment${i.downstream_segments === 1 ? "" : "s"}`;
    case "negative_lag":
      return `${i.pred} → ${i.succ} overlap ${-i.lag_hours} h`;
  }
}

const ISSUE_WORD: Record<Issue["kind"], string> = {
  not_executable_as_planned: "NOT EXECUTABLE",
  held_with_crews_booked: "HELD · CREWS BOOKED",
  compound_hold: "COMPOUND HOLD",
  stranding_concentration: "STRANDING",
  negative_lag: "SCHEDULE QUALITY",
};

/* ---------------------------------------------------------------- shifts */

export type Shift = "instant" | "days" | "swing" | "night";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/**
 * The shift's window on the as-of day. Anchored to UTC midnight and labelled
 * (Z) until the yard's clock and shift calendar land as a document — the
 * label is the honest part until then.
 */
export function shiftWindow(asOfMs: number, shift: Shift): { start: number; end: number; label: string } | null {
  if (shift === "instant") return null;
  const midnight = Math.floor(asOfMs / DAY) * DAY;
  switch (shift) {
    case "days":
      return { start: midnight + 7 * HOUR, end: midnight + 15.5 * HOUR, label: "Days 0700–1530 (Z)" };
    case "swing":
      return { start: midnight + 15.5 * HOUR, end: midnight + 24 * HOUR, label: "Swing 1530–2400 (Z)" };
    case "night":
      return { start: midnight, end: midnight + 7 * HOUR, label: "Night 0000–0700 (Z)" };
  }
}

/* --------------------------------------------------------------- builders */

export interface ShiftInput {
  cut: ReportCut;
  activities: Activity[];
  spaces: DeckStateRow[];
  shift: Shift;
  /** Restrict to one zone, or null for the hull. */
  zone: string | null;
}

/** R1 — the shift sheet: per trade, heaviest first, with what stands in its way. */
export function shiftSheet(input: ShiftInput): Report {
  const { cut, activities, spaces, shift, zone } = input;
  const idx = spaceIndex(spaces);
  const win = shiftWindow(cut.asOfMs, shift);
  const refused = new Set(spaces.filter((s) => !s.permits_work).map((s) => s.compartment.compartment_no));
  const inSlice = (a: Activity): boolean => {
    if (win === null) return a.in_window;
    if (a.planned === null) return true;
    return a.planned.start < win.end && a.planned.end > win.start;
  };
  const hours = (a: Activity): number =>
    win === null ? a.remaining_hours : activityWindowHours(a, win.start, win.end);
  const onShift = activities.filter(
    (a) =>
      inSlice(a) &&
      !a.is_milestone &&
      a.status !== "complete" &&
      (zone === null || zoneOf(idx, a.compartment_no) === zone),
  );
  const groups = new Map<string, Activity[]>();
  for (const a of onShift) groups.set(a.trade, [...(groups.get(a.trade) ?? []), a]);
  const sections: ReportSection[] = [...groups.entries()]
    .map(([trade, list]) => ({ trade, list: list.sort((x, y) => hours(y) - hours(x)), total: list.reduce((s, a) => s + hours(a), 0) }))
    .sort((x, y) => y.total - x.total)
    .map(({ trade, list, total }) => ({
      heading: trade,
      note: `${list.length} activit${list.length === 1 ? "y" : "ies"} · ${mh(total)}${win ? " this shift" : " remaining"}`,
      columns: ["Activity", "Name", "Space", "Zone", win ? "MH this shift" : "MH left", "Stands in the way"],
      numeric: [4],
      rows: list.map((a) => [
        a.code,
        a.name,
        a.compartment_no ?? "not located",
        zoneOf(idx, a.compartment_no),
        Math.round(hours(a)).toLocaleString(),
        [
          a.compartment_no && refused.has(a.compartment_no) ? `HELD — ${a.compartment_no} refuses work now` : "",
          win && refusalOverlaps(a, win.start, win.end) ? "REFUSED THIS SHIFT" : "",
          a.executability.verdict === "not_executable" ? "NOT EXECUTABLE AS PLANNED" : "",
          a.compartment_no === null ? "UNLOCATED — cannot be assessed" : "",
        ]
          .filter(Boolean)
          .join(" · "),
      ]),
    }));
  return {
    id: "shift",
    name: "Shift sheet",
    question: "Who goes where this shift, and what stands in front of them",
    scope: `${win ? win.label : `at ${fmtDayTime(cut.asOfMs)}`}${zone ? ` · Zone ${zone}` : " · all zones"}`,
    cut,
    sections: sections.length > 0 ? sections : [{ heading: "Nothing planned", columns: ["—"], rows: [["No activities fall in this slice."]] }],
    notes: LAYER_NOTES,
  };
}

export interface ZoneInput {
  cut: ReportCut;
  zone: string;
  activities: Activity[];
  spaces: DeckStateRow[];
  hazards: LiveHazard[];
  /** The reading window from the cut instant, ms — a day for a day sheet. */
  windowMs: number;
}

/** R2 — the zone day sheet: the zone's spaces, its field conditions, and its broken plans. */
export function zoneSheet(input: ZoneInput): Report {
  const { cut, zone, activities, spaces, hazards, windowMs } = input;
  const inZone = spaces
    .filter((s) => s.compartment.zone === zone)
    .sort((a, b) => b.remaining_hours - a.remaining_hours);
  const t0 = cut.asOfMs;
  const t1 = cut.asOfMs + windowMs;
  const bookedIn = (no: string): Activity[] =>
    activities.filter(
      (a) => a.compartment_no === no && !a.is_milestone && a.status !== "complete" && a.planned !== null && a.planned.start < t1 && a.planned.end > t0,
    );
  const spacesSection: ReportSection = {
    heading: `Spaces in Zone ${zone}`,
    note: "Worst first by man-hours held. State is the engine's verdict at the cut instant.",
    columns: ["Space", "Deck", "Name", "State", "MH held", "Work in window", "Clears"],
    numeric: [4],
    rows: inZone.map((s) => {
      const booked = bookedIn(s.compartment.compartment_no);
      const clears =
        s.readiness === "held"
          ? s.earliest_clear !== null
            ? `on its own by ${fmtDayTime(s.earliest_clear)}`
            : `on verification by ${s.clearing_authority.replace(/_/g, " ")}`
          : "";
      return [
        s.compartment.compartment_no,
        s.compartment.deck_code,
        s.compartment.name,
        stateWord(s.state),
        s.readiness === "held" ? Math.round(s.remaining_hours).toLocaleString() : "0",
        booked.length > 0 ? `${booked.length} act · ${mh(booked.reduce((n, a) => n + activityWindowHours(a, t0, t1), 0))}` : "—",
        clears,
      ];
    }),
  };
  const zoneSpaces = new Set(inZone.map((s) => s.compartment.compartment_no));
  const conditions: ReportSection = {
    heading: "Field conditions in this zone",
    columns: ["Space", "Kind", "Condition", "Raised"],
    rows: hazards
      .filter((h) => zoneSpaces.has(h.origin))
      .map((h) => [h.origin, h.kind.replace(/_/g, " "), h.label, fmtDayTime(h.since)]),
  };
  const broken: ReportSection = {
    heading: "Work in this zone not executable as planned",
    columns: ["Activity", "Name", "Trade", "Space", "Refused from", "Clears"],
    rows: activities
      .filter((a) => a.compartment_no !== null && zoneSpaces.has(a.compartment_no) && a.executability.verdict === "not_executable")
      .map((a) => {
        const e = a.executability;
        const refusedAt = e.verdict === "not_executable" ? fmtDayTime(e.at) : "";
        const clears =
          e.verdict === "not_executable"
            ? e.earliest_clear !== null
              ? fmtDayTime(e.earliest_clear)
              : `verification by ${e.clearing_authority.replace(/_/g, " ")}`
            : "";
        return [a.code, a.name, a.trade, a.compartment_no ?? "", refusedAt, clears];
      }),
  };
  return {
    id: "zone",
    name: "Zone day sheet",
    question: "What runs in my zone, what is held, and who clears it",
    scope: `Zone ${zone} · ${fmtDay(t0)} → ${fmtDay(t1)}`,
    cut,
    sections: [spacesSection, emptyOr(conditions, "No open field conditions in this zone."), emptyOr(broken, "Every activity in this zone can execute as planned.")],
    notes: [...LAYER_NOTES, `Zone membership from the register (${spaces.length} spaces served); a space with no register row is not on this sheet.`],
  };
}

export interface CompartmentInput {
  cut: ReportCut;
  space: string;
  row: DeckStateRow | null;
  decision: Decision | null;
  activities: Activity[];
  hazards: LiveHazard[];
}

/** R3 — the compartment card: one space, everything the platform knows. */
export function compartmentCard(input: CompartmentInput): Report {
  const { cut, space, row, decision, activities, hazards } = input;
  const facts: ReportSection = {
    heading: "The space",
    columns: ["Field", "Value"],
    rows: row
      ? [
          ["Placard", row.compartment.compartment_no],
          ["Name", row.compartment.name],
          ["Deck · zone", `${row.compartment.deck_code} · Zone ${row.compartment.zone}`],
          ["Frame · side", `${row.compartment.frame === null ? "—" : `Fr ${row.compartment.frame}`} · ${row.compartment.side} · geometry ${row.compartment.geometry_source}`],
          ["State at cut", stateWord(row.state)],
          ["Readiness", row.readiness.toUpperCase()],
          ["MH booked", mh(row.remaining_hours)],
          ["Trades", row.trades.join(", ") || "—"],
          ["Work orders", row.work_order_codes.join(", ") || "—"],
        ]
      : [["Placard", space], ["Register", "not on this hull's register at the cut instant"]],
  };
  const why: ReportSection = {
    heading: "Why it is held",
    note: "Every rule that fired, the path the hazard took, and who may clear it.",
    columns: ["Rule", "State", "Condition", "From", "Via", "Clears"],
    rows: (decision?.trace ?? []).map((t) => [
      t.rule_code,
      stateWord(t.state),
      t.hazard,
      `${t.source}${t.depth > 0 ? ` · ${t.depth} hop${t.depth === 1 ? "" : "s"}` : ""}`,
      t.via.map((v) => v.replace(/_/g, " ")).join(" → ") || "in this space",
      t.earliest_clear !== null ? `by ${fmtDayTime(t.earliest_clear)}` : `verification by ${t.clearing_authority.replace(/_/g, " ")}`,
    ]),
  };
  const conditions: ReportSection = {
    heading: "Field conditions here",
    columns: ["Kind", "Condition", "Raised"],
    rows: hazards.filter((h) => h.origin === space).map((h) => [h.kind.replace(/_/g, " "), h.label, fmtDayTime(h.since)]),
  };
  const work: ReportSection = {
    heading: "Work booked here",
    columns: ["Activity", "Name", "Trade", "Planned", "MH left", "As planned"],
    numeric: [4],
    rows: activities
      .filter((a) => a.compartment_no === space && !a.is_milestone)
      .sort((x, y) => (x.planned?.start ?? 0) - (y.planned?.start ?? 0))
      .map((a) => [
        a.code,
        a.name,
        a.trade,
        a.planned ? `${fmtDay(a.planned.start)} → ${fmtDay(a.planned.end)}` : "undated",
        Math.round(a.remaining_hours).toLocaleString(),
        a.status === "complete" ? "complete" : a.executability.verdict === "executable" ? "executable" : a.executability.verdict === "not_executable" ? "NOT EXECUTABLE" : "unassessable",
      ]),
  };
  return {
    id: "compartment",
    name: "Compartment card",
    question: "Everything about one space: work in it, what holds it, who can release it",
    scope: space,
    cut,
    sections: [facts, emptyOr(why, "Nothing holds this space at the cut instant."), emptyOr(conditions, "No open field conditions originate here."), emptyOr(work, "No scheduled work is located to this space.")],
    notes: LAYER_NOTES,
  };
}

export interface ConflictInput {
  cut: ReportCut;
  issues: Issue[];
  spaces: DeckStateRow[];
  zone: string | null;
}

/** R7 — the conflict log: every open issue at the cut, ranked as served, with its answer. */
export function conflictLog(input: ConflictInput): Report {
  const { cut, issues, spaces, zone } = input;
  const idx = spaceIndex(spaces);
  const rows = issues
    .map((i, n) => ({ i, n: n + 1, space: issueSpace(i) }))
    .filter(({ space }) => zone === null || zoneOf(idx, space) === zone);
  const open = rows.filter(({ i }) => i.acknowledged === null && i.decision === null).length;
  const section: ReportSection = {
    heading: `${rows.length} issue${rows.length === 1 ? "" : "s"} · ${open} not yet answered for`,
    note: "Ranked by man-hours at risk, as the Conflicts board serves them. The same hours can sit under more than one kind.",
    columns: ["#", "Kind", "Issue", "Space", "Zone", "MH at risk", "Answered"],
    numeric: [0, 5],
    rows: rows.map(({ i, n, space }) => [
      String(n),
      ISSUE_WORD[i.kind],
      issueClaim(i),
      space ?? "—",
      zoneOf(idx, space),
      Math.round(i.hours_at_risk).toLocaleString(),
      i.acknowledged
        ? `acknowledged ${fmtDay(i.acknowledged.at)}${i.acknowledged.note ? ` — ${i.acknowledged.note}` : ""}`
        : i.decision
          ? `${i.decision.disposition} ${fmtDay(i.decision.at)}${i.decision.reason ? ` — ${i.decision.reason}` : ""}`
          : "open",
    ]),
  };
  return {
    id: "conflicts",
    name: "Conflict log",
    question: "Every open conflict, ranked, with what was answered for",
    scope: zone ? `Zone ${zone}` : "all zones",
    cut,
    sections: [emptyOr(section, "No issues on the board at the cut instant.")],
    notes: [...LAYER_NOTES, "Answers are ledger entries: acknowledgements and mitigation decisions recorded against the issue or its space."],
  };
}

export interface ConditionsInput {
  cut: ReportCut;
  hazards: LiveHazard[];
  spaces: DeckStateRow[];
}

/** R10 — the field-condition register: every open hazard on the hull at the cut. */
export function fieldConditions(input: ConditionsInput): Report {
  const { cut, hazards, spaces } = input;
  const idx = spaceIndex(spaces);
  const holds = (origin: string): string => {
    const held = spaces.filter((s) => s.readiness === "held" && (s.compartment.compartment_no === origin || s.rules_fired.length > 0) && s.compartment.compartment_no === origin);
    return held.length > 0 ? `${mh(held.reduce((n, s) => n + s.remaining_hours, 0))} in its own space` : "nothing booked in its own space";
  };
  const section: ReportSection = {
    heading: `${hazards.length} open field condition${hazards.length === 1 ? "" : "s"}`,
    columns: ["Space", "Deck", "Zone", "Kind", "Condition", "Raised", "Open for", "Holds"],
    rows: [...hazards]
      .sort((a, b) => a.since - b.since)
      .map((h) => {
        const r = idx.get(h.origin);
        const days = Math.max(0, Math.floor((cut.asOfMs - h.since) / DAY));
        return [
          h.origin,
          r?.compartment.deck_code ?? "—",
          r?.compartment.zone ?? "—",
          h.kind.replace(/_/g, " "),
          h.label,
          fmtDayTime(h.since),
          days === 0 ? "today" : `${days} day${days === 1 ? "" : "s"}`,
          holds(h.origin),
        ];
      }),
  };
  return {
    id: "conditions",
    name: "Field-condition register",
    question: "Every open field condition on the hull: where, since when, who clears it",
    scope: "whole hull",
    cut,
    sections: [emptyOr(section, "No open field conditions at the cut instant.")],
    notes: [...LAYER_NOTES, "What each condition holds beyond its own space is on the compartment card and the deck plan's trace."],
  };
}

function emptyOr(section: ReportSection, empty: string): ReportSection {
  return section.rows.length > 0 ? section : { ...section, columns: ["—"], numeric: [], rows: [[empty]] };
}

/* ------------------------------------------------------------ CSV + print */

/** RFC-4180-shaped: quote when needed, double the quotes inside. */
export function csvCell(s: string): string {
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

/** The whole report as CSV lines: a cut header, then each section with its heading as a row. */
export function toCsv(r: Report): string[] {
  const lines: string[] = [
    ["report", r.name].map(csvCell).join(","),
    ["scope", r.scope].map(csvCell).join(","),
    ["hull", r.cut.hull].map(csvCell).join(","),
    ["cut_at", new Date(r.cut.asOfMs).toISOString()].map(csvCell).join(","),
    ["schedule", r.cut.scheduleSource ?? "generated demo register"].map(csvCell).join(","),
    ["produced_by", r.cut.producedBy].map(csvCell).join(","),
  ];
  for (const s of r.sections) {
    lines.push("");
    lines.push(["section", s.heading].map(csvCell).join(","));
    lines.push(s.columns.map(csvCell).join(","));
    for (const row of s.rows) lines.push(row.map(csvCell).join(","));
  }
  return lines;
}

/** The report's filename: what it is, for what, as of when. */
export function reportFilename(r: Report, ext: "csv" | "html"): string {
  const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `${slug(r.name)}-${slug(r.cut.hull)}-${slug(r.scope)}-asof-${new Date(r.cut.asOfMs).toISOString().slice(0, 16).replace(/[-:T]/g, "")}.${ext}`;
}

const esc = (s: string): string =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");

/**
 * The monochrome one-pager. Generated as its own document rather than
 * printing the app: dark panels and accent colours are ink and noise on a
 * clipboard wall, and every warning here is a word so it survives a
 * photocopier.
 */
export function toPrintHtml(r: Report): string {
  const sections = r.sections
    .map(
      (s) => `
    <h2>${esc(s.heading)}${s.note ? ` <small>${esc(s.note)}</small>` : ""}</h2>
    <table>
      <thead><tr>${s.columns.map((c, i) => `<th${s.numeric?.includes(i) ? ' class="n"' : ""}>${esc(c)}</th>`).join("")}</tr></thead>
      <tbody>${s.rows.map((row) => `<tr>${row.map((c, i) => `<td${s.numeric?.includes(i) ? ' class="n"' : ""}>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>`,
    )
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${esc(r.name)} — ${esc(r.cut.hull)}</title>
<style>
  body { font: 11pt/1.35 Georgia, "Times New Roman", serif; color: #000; margin: 14mm 12mm; }
  header { border: 1.5pt solid #000; padding: 6pt 9pt; display: grid; grid-template-columns: 1fr auto; gap: 10pt; margin-bottom: 9pt; }
  h1 { font: 700 18pt/1.1 "Arial Narrow", Arial, sans-serif; margin: 0 0 2pt; }
  .q { font-style: italic; margin: 0; }
  .cut { font: 9pt/1.4 "Courier New", monospace; white-space: nowrap; }
  h2 { font: 700 12pt/1.2 "Arial Narrow", Arial, sans-serif; margin: 12pt 0 4pt; border-bottom: 1pt solid #000; padding-bottom: 2pt; }
  h2 small { font: 9pt/1.2 Arial, sans-serif; margin-left: 6pt; }
  table { border-collapse: collapse; width: 100%; font-size: 9.5pt; page-break-inside: auto; }
  th { text-align: left; font: 700 8pt/1.2 Arial, sans-serif; letter-spacing: .04em; text-transform: uppercase; border-bottom: 1pt solid #000; padding: 3pt 5pt; }
  td { border-bottom: .5pt solid #888; padding: 3pt 5pt; vertical-align: top; }
  .n { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  tr { page-break-inside: avoid; }
  footer { margin-top: 12pt; font: 8.5pt/1.4 Arial, sans-serif; border-top: 1pt solid #000; padding-top: 4pt; }
  @page { margin: 10mm; }
</style></head><body>
<header>
  <div><h1>${esc(r.name)} — ${esc(r.scope)}</h1><p class="q">${esc(r.question)}</p></div>
  <div class="cut">${esc(r.cut.hull)}<br>cut ${esc(fmtDayTime(r.cut.asOfMs))}<br>schedule: ${esc(r.cut.scheduleSource ?? "generated demo register")}<br>by ${esc(r.cut.producedBy)}</div>
</header>
${sections}
<footer>${r.notes.map(esc).join("<br>")}<br>Decision support — flags risk; the planner decides. Nothing on this sheet is an authorization.</footer>
</body></html>`;
}

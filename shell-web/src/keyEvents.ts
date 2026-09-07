// Week Ahead — what stands between us and the next key event.
//
// The morning meeting's second question. The schedule of record carries its
// own logic (edges) and its own key events (milestones); walking the logic
// backwards from a milestone gives the set of work that gates it, and the
// register's served verdicts, the engine's alternatives and the proposals in
// the ledger say what state each of those activities is in. Nothing here is
// decided by the shell: the refusals, the windows and the proposal statuses
// are all served; this module walks, ranks and words them. Lags are not
// applied to the walk — the gating set is "everything the logic says must
// finish first", and the margin column is the plan's own dates against the
// event's.
//
// Pure: no fetch, no wall clock.

import type { Activity, AlternativeRow, ProposalStatus, ScheduleEdge, ScheduleProposal } from "./api";
import { fmtDay, fmtDayTime } from "./clock";
import { clockNote, type Report, type ReportCut, type ReportSection } from "./reports";
import { refusalOverlaps } from "./windowLoad";
import { dayStart, local, nextDayStart, weekday, type YardClock } from "./yardClock";

const DAY = 86_400_000;

/** A milestone still ahead: the register row, its date, and how much logic points at it. */
export interface KeyEvent {
  code: string;
  name: string;
  /** The event's planned instant (a milestone's start), epoch ms. */
  at: number;
  /** Edges whose successor is this event — the schedule's own logic. */
  predCount: number;
  activity: Activity;
}

/** Milestones with a planned start at or after `fromMs` and not complete, ascending. */
export function keyEvents(activities: Activity[], edges: ScheduleEdge[], fromMs: number): KeyEvent[] {
  const preds = new Map<string, number>();
  for (const e of edges) preds.set(e.succ_code, (preds.get(e.succ_code) ?? 0) + 1);
  return activities
    .filter((a) => a.is_milestone && a.status !== "complete" && a.planned !== null && a.planned.start >= fromMs)
    .map((a) => ({ code: a.code, name: a.name, at: a.planned?.start ?? fromMs, predCount: preds.get(a.code) ?? 0, activity: a }))
    .sort((x, y) => x.at - y.at || x.code.localeCompare(y.code));
}

/**
 * The transitive predecessors of `code` over the schedule's logic — every
 * kind of edge, lags ignored (a negative lag is still a dependency) — less
 * milestones and complete rows. A visited set survives a cycle in the export.
 */
export function gatingSet(code: string, activities: Activity[], edges: ScheduleEdge[]): Set<string> {
  const byCode = new Map(activities.map((a) => [a.code, a]));
  const preds = new Map<string, string[]>();
  for (const e of edges) preds.set(e.succ_code, [...(preds.get(e.succ_code) ?? []), e.pred_code]);
  const seen = new Set<string>();
  const stack = [code];
  while (stack.length > 0) {
    const c = stack.pop();
    if (c === undefined) break;
    for (const p of preds.get(c) ?? []) {
      if (seen.has(p)) continue;
      seen.add(p);
      stack.push(p);
    }
  }
  const out = new Set<string>();
  for (const c of seen) {
    const a = byCode.get(c);
    if (a && !a.is_milestone && a.status !== "complete") out.add(c);
  }
  return out;
}

/* ------------------------------------------------------------------ rows */

/** Worst first: 0 misses the event … 4 on plan. */
export type Tier = 0 | 1 | 2 | 3 | 4;

export interface ProposalWord {
  seq: number;
  status: ProposalStatus;
  /** `#7 OPEN → 12/02–12/09 · makes it`, `#7 REFLECTED`. */
  text: string;
  /** Whether the proposed window ends before the event; null when no date was promised. */
  makesIt: boolean | null;
}

export interface WeekRow {
  a: Activity;
  tier: Tier;
  /** The word on the row: `MISSES THE EVENT`, `SLIDES · still makes it (+3 d)`, … */
  word: string;
  /** Why, for tier 0 — which of the engine's answers puts it there. */
  why: string;
  /** The hold in one line, or `—`. */
  hold: string;
  /** Event date minus planned finish, in days; null when undated. */
  marginDays: number | null;
  proposal: ProposalWord | null;
  alt: AlternativeRow | undefined;
}

export interface DayCell {
  dayStart: number;
  dayEnd: number;
  /** `Mon 09/07`. */
  label: string;
  /** Gating activities whose planned start falls in the day. */
  starting: number;
  /** Gating activities whose refusal interval overlaps the day. */
  refused: number;
}

export interface WeekBoard {
  event: KeyEvent;
  rows: WeekRow[];
  days: DayCell[];
  /** Upcoming events the schedule ties no work to. */
  eventsWithoutLogic: KeyEvent[];
  totals: {
    gating: number;
    mhLeft: number;
    misses: number;
    slides: number;
    unassessed: number;
    plannedPast: number;
    onPlan: number;
    proposalsOpen: number;
  };
}

export interface WeekInput {
  event: KeyEvent;
  /** Every upcoming event, for the without-logic list. */
  events: KeyEvent[];
  activities: Activity[];
  edges: ScheduleEdge[];
  /** The engine's alternatives, or null when that read failed. */
  alternatives: AlternativeRow[] | null;
  /** The ledger's proposals, or null when that read failed. */
  proposals: ScheduleProposal[] | null;
  fromMs: number;
  clock: YardClock;
  zone: string | null;
  /** Space → zone, from the register. */
  zoneOf: Map<string, string>;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const days = (ms: number): string => `${Math.round(ms / DAY)} d`;

/** `isolation_authority` → `isolation authority`. */
const word = (s: string): string => s.replace(/_/g, " ");

/** The refusal in one line: rule · hazard at origin · authority · when it clears. */
export function holdSentence(a: Activity): string {
  const e = a.executability;
  if (e.verdict !== "not_executable") return "—";
  const clears = e.earliest_clear !== null ? `clears by ${fmtDayTime(e.earliest_clear)}` : "clears on verification";
  return `${e.rule_code} · ${e.hazard} at ${e.origin} · ${word(e.clearing_authority)} · ${clears}`;
}

function tierOf(a: Activity, alt: AlternativeRow | undefined, altsKnown: boolean, eventAt: number): { tier: Tier; word: string; why: string } {
  const e = a.executability;
  if (a.planned === null || e.verdict === "unassessable") {
    return { tier: 2, word: "CANNOT BE ASSESSED", why: a.planned === null ? "undated in the schedule of record" : "not located — the engine was not given a space" };
  }
  if (e.verdict === "not_executable") {
    if (!altsKnown) return { tier: 0, word: "MISSES THE EVENT", why: "refused as planned; the engine's window is unavailable" };
    if (!alt) return { tier: 0, word: "MISSES THE EVENT", why: "refused as planned; the engine served no window for it" };
    switch (alt.alternative.kind) {
      case "viable": {
        const w = alt.alternative.window;
        if (w.end <= eventAt) return { tier: 1, word: `SLIDES · still makes it (+${days(alt.alternative.delay_hours * 3_600_000)})`, why: `the engine's window ${fmtDay(w.start)}–${fmtDay(w.end)} ends before the event` };
        return { tier: 0, word: "MISSES THE EVENT", why: `the engine's window ends ${fmtDay(w.end)}, after the event` };
      }
      case "verification_gated":
        return { tier: 0, word: "MISSES THE EVENT", why: "no date can honestly be promised until the authority verifies" };
      case "no_window":
        return { tier: 0, word: "MISSES THE EVENT", why: `no window before the horizon (${fmtDay(alt.alternative.horizon)})` };
    }
  }
  if (a.planned.end > eventAt) return { tier: 3, word: "PLANNED PAST THE EVENT", why: "the schedule of record finishes it after the event" };
  return { tier: 4, word: `on plan · margin ${days(eventAt - a.planned.end)}`, why: "" };
}

/** The newest open or reflected proposal on the activity, worded against the event. */
export function proposalWord(code: string, proposals: ScheduleProposal[] | null, eventAt: number): ProposalWord | null {
  if (!proposals) return null;
  const mine = proposals
    .filter((p) => p.activity === code && (p.status === "open" || p.status === "reflected"))
    .sort((x, y) => y.seq - x.seq);
  const p = mine[0];
  if (!p) return null;
  if (p.status === "reflected") return { seq: p.seq, status: p.status, text: `#${p.seq} REFLECTED`, makesIt: p.to ? p.to.end <= eventAt : null };
  if (p.to === null) return { seq: p.seq, status: p.status, text: `#${p.seq} OPEN · hold pending verification`, makesIt: null };
  const makesIt = p.to.end <= eventAt;
  return { seq: p.seq, status: p.status, text: `#${p.seq} OPEN → ${fmtDay(p.to.start)}–${fmtDay(p.to.end)} · ${makesIt ? "makes it" : "misses it"}`, makesIt };
}

function inZone(a: Activity, zone: string | null, zoneOf: Map<string, string>): boolean {
  if (zone === null) return true;
  return a.compartment_no !== null ? zoneOf.get(a.compartment_no) === zone : a.wbs_area === zone;
}

/** Seven yard days from the as-of day, counting starts and refusals over the rows. */
export function daysStrip(rows: WeekRow[], fromMs: number, clock: YardClock): DayCell[] {
  const out: DayCell[] = [];
  let d0 = dayStart(clock, fromMs);
  for (let i = 0; i < 7; i += 1) {
    const d1 = nextDayStart(clock, d0);
    const t = local(clock, d0);
    out.push({
      dayStart: d0,
      dayEnd: d1,
      label: `${WEEKDAYS[weekday(t.days)] ?? ""} ${fmtDay(d0)}`,
      starting: rows.filter((r) => r.a.planned !== null && r.a.planned.start >= d0 && r.a.planned.start < d1).length,
      refused: rows.filter((r) => refusalOverlaps(r.a, d0, d1)).length,
    });
    d0 = d1;
  }
  return out;
}

/** The board: the gating work worst first, the seven days, the events with no logic. */
export function weekBoard(input: WeekInput): WeekBoard {
  const { event, events, activities, edges, alternatives, proposals, fromMs, clock, zone, zoneOf } = input;
  const gating = gatingSet(event.code, activities, edges);
  const altByCode = new Map((alternatives ?? []).map((r) => [r.activity, r]));
  const rows: WeekRow[] = activities
    .filter((a) => gating.has(a.code) && inZone(a, zone, zoneOf))
    .map((a) => {
      const alt = altByCode.get(a.code);
      const t = tierOf(a, alt, alternatives !== null, event.at);
      return {
        a,
        ...t,
        hold: holdSentence(a),
        marginDays: a.planned ? Math.round((event.at - a.planned.end) / DAY) : null,
        proposal: proposalWord(a.code, proposals, event.at),
        alt,
      };
    })
    .sort((x, y) => x.tier - y.tier || y.a.remaining_hours - x.a.remaining_hours || x.a.code.localeCompare(y.a.code));
  const count = (tier: Tier): number => rows.filter((r) => r.tier === tier).length;
  return {
    event,
    rows,
    days: daysStrip(rows, fromMs, clock),
    eventsWithoutLogic: events.filter((e) => gatingSet(e.code, activities, edges).size === 0),
    totals: {
      gating: rows.length,
      mhLeft: rows.reduce((s, r) => s + r.a.remaining_hours, 0),
      misses: count(0),
      slides: count(1),
      unassessed: count(2),
      plannedPast: count(3),
      onPlan: count(4),
      proposalsOpen: rows.filter((r) => r.proposal?.status === "open").length,
    },
  };
}

/* ----------------------------------------------------------------- sheet */

function emptyOr(section: ReportSection, empty: string): ReportSection {
  return section.rows.length > 0 ? section : { ...section, columns: ["—"], numeric: [], rows: [[empty]] };
}

/** R8 — key-event readiness: the gating work worst first, with what P6 has been asked. */
export function keyEventSheet(board: WeekBoard, cut: ReportCut, zone: string | null): Report {
  const gating: ReportSection = {
    heading: `Work gating ${board.event.code} ${board.event.name} — ${fmtDay(board.event.at)}`,
    note: `${board.totals.gating} activities · ${Math.round(board.totals.mhLeft).toLocaleString()} MH left · ${board.totals.misses} miss the event · ${board.totals.slides} slide and still make it · ${board.totals.unassessed} cannot be assessed · ${board.totals.proposalsOpen} proposals open`,
    columns: ["Reads", "Activity", "Name", "Space", "Trade", "Planned", "MH left", "The hold · why", "Margin (d)", "Proposal"],
    numeric: [6, 8],
    rows: board.rows.map((r) => [
      r.word,
      r.a.code,
      r.a.name,
      r.a.compartment_no ?? "not located",
      r.a.trade,
      r.a.planned ? `${fmtDay(r.a.planned.start)} → ${fmtDay(r.a.planned.end)}` : "undated",
      Math.round(r.a.remaining_hours).toLocaleString(),
      [r.hold === "—" ? "" : r.hold, r.why].filter(Boolean).join(" · ") || "—",
      r.marginDays === null ? "—" : String(r.marginDays),
      r.proposal?.text ?? "—",
    ]),
  };
  const week: ReportSection = {
    heading: "The seven days ahead",
    note: "Over the gating set: activities starting each yard day, and activities the engine refuses during it.",
    columns: ["Day", "Starting", "Refused"],
    numeric: [1, 2],
    rows: board.days.map((d) => [d.label, String(d.starting), String(d.refused)]),
  };
  const noLogic: ReportSection = {
    heading: "Key events the schedule ties no work to",
    columns: ["Event", "Name", "Date"],
    rows: board.eventsWithoutLogic.map((e) => [e.code, e.name, fmtDay(e.at)]),
  };
  const daysAway = Math.round((board.event.at - cut.asOfMs) / DAY);
  return {
    id: "keyEvent",
    name: "Key-event readiness",
    question: "Work gating the next key event, worst first, with what P6 has been asked",
    scope: `${board.event.name} · ${fmtDay(board.event.at)} (${daysAway} d)${zone ? ` · Zone ${zone}` : " · all zones"}`,
    cut,
    sections: [
      emptyOr(gating, "No work gates this event in the schedule of record's logic."),
      week,
      emptyOr(noLogic, "Every upcoming key event has logic pointing at it."),
    ],
    notes: [
      "MH left: the schedule of record.",
      "Refused, the hold, the engine's window: the engine, at the cut instant; a proposal's verdict is the engine's at the instant it was proposed.",
      "Gating set: the schedule of record's own logic, walked backwards from the event by the shell; every edge kind, lags not applied; milestones and complete rows excluded.",
      "Margin: planned finish against the event date, from the schedule of record. Proposals: the ledger, status derived on every read.",
      clockNote(cut.asOfMs),
    ],
  };
}

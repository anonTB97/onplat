// Tomorrow — what the next shift walks into, and who can clear it tonight.
//
// The morning meeting's first question is not "what is held now" but "what
// will be held when the crew arrives, and which of those holds is a phone
// call tonight versus a clock running out on its own". Everything here is a
// cut of reads the engine already serves: the register at the as-of instant,
// the per-space verdicts NOW and AT THE SHIFT'S START, and the hull-wide
// leverage read at that start (the single actions that would open spaces,
// each with who has to do it). The shell only sorts and words them. Nothing
// here decides whether a space permits work; the engine did, at the start
// of the shift, under the field conditions recorded now — and every surface
// that renders this board says so.
//
// Pure: no fetch, no clock read except the yard clock it is handed.

import type { Activity, Confidence, DeckStateRow, Mitigation, MitigationAction } from "./api";
import { fmtDay, fmtDayTime, fmtTime } from "./clock";
import { clockNote, shiftChoices, shiftWindow, type Report, type ReportCut, type ReportSection } from "./reports";
import { activityWindowHours } from "./windowLoad";
import { civilFromDays, local, nextDayStart, type YardClock } from "./yardClock";

/** One of the yard's shifts, placed on the calendar: its name, the chip's
 *  label (`Days 0700–1530`) and its window in epoch ms. */
export interface ShiftWindow {
  name: string;
  label: string;
  start: number;
  end: number;
}

/** `09/05` in the given clock — the day the shift belongs to. */
function dayLabelIn(clock: YardClock, ms: number): string {
  const [, m, d] = civilFromDays(local(clock, ms).days);
  return `${String(m).padStart(2, "0")}/${String(d).padStart(2, "0")}`;
}

/**
 * The first of the yard's shifts that starts after `fromMs`, scanning the
 * as-of yard day and the next — so Swing's afternoon looks at Mids, and Mids
 * looks at the coming Days. The windows come from `reports.ts::shiftWindow`,
 * the one place the shell places a shift on the calendar. Null only for a
 * clock that names no shifts.
 */
export function nextShift(clock: YardClock, fromMs: number): (ShiftWindow & { dayLabel: string }) | null {
  const names = shiftChoices(clock).filter((c) => c.id !== "instant").map((c) => c.id);
  const days = [fromMs, nextDayStart(clock, fromMs)];
  const windows: ShiftWindow[] = [];
  for (const day of days) {
    for (const name of names) {
      const w = shiftWindow(day, name, clock);
      if (w) windows.push({ name, label: w.label, start: w.start, end: w.end });
    }
  }
  windows.sort((x, y) => x.start - y.start);
  const next = windows.find((w) => w.start > fromMs);
  return next ? { ...next, dayLabel: dayLabelIn(clock, next.start) } : null;
}

/** The chip's word: "Tomorrow" when the next shift is on the next yard day,
 *  "Next shift" when it is still today (a Mids reader looking at Days). */
export function nextShiftWord(clock: YardClock, fromMs: number, shift: ShiftWindow): string {
  return local(clock, shift.start).days === local(clock, fromMs).days ? "Next shift" : "Tomorrow";
}

/* ------------------------------------------------------------------ model */

export interface TomorrowInput {
  clock: YardClock;
  shift: ShiftWindow;
  /** The instant the register and `spacesNow` were read at. */
  asOfMs: number;
  activities: Activity[];
  /** Per-space verdicts at the as-of instant. */
  spacesNow: DeckStateRow[];
  /** Per-space verdicts the engine gave for the shift's start. */
  spacesAtStart: DeckStateRow[];
  /** The hull-wide single actions at the shift's start. */
  leverageAtStart: Mitigation[];
  /** Restrict to one zone, or null for the hull. */
  zone: string | null;
}

/** One activity on the shift with the shift's share of its hours. */
export interface ShiftRow {
  a: Activity;
  space: string;
  /** Man-hours the shift holds of it — schedule of record, pro-rated by the shell. */
  mhShift: number;
}

/** A single action at the shift's start and the work it would release. */
export interface ClearanceGroup {
  action: MitigationAction;
  /** Who has to do it, in yard words. */
  actor: string;
  /** What is cleared — the hazard, or the coupling an interrupt cuts. */
  hazard: string;
  /** Where — the origin, or `from → to` for an interrupt. */
  origin: string;
  confidence: Confidence;
  /** Every space the engine says the action frees (the coupling reach). */
  frees: string[];
  /** Of those, how many carry work on this shift. */
  freesWithWork: number;
  /** Spaces the action would SHUT. Never hidden. */
  closes: string[];
  rows: ShiftRow[];
  mhShift: number;
  trades: string[];
  /** The spaces whose rows are grouped here. */
  spaces: string[];
}

export type SelfClearWhen = "before_shift" | "during_shift" | "after_shift";

/** A hold that clears on a clock — or has already cleared by the start. */
export interface SelfClearRow {
  space: string;
  name: string;
  heldNow: boolean;
  heldAtStart: boolean;
  /** The engine's earliest clear, or null when it is open at start with no clock read. */
  clearsAt: number | null;
  when: SelfClearWhen;
  authority: string;
  rules: string[];
  rows: ShiftRow[];
  mhShift: number;
}

/** Held at start, and no single action opens it. */
export interface SpaceRow {
  space: string;
  name: string;
  rules: string[];
  authority: string;
  rows: ShiftRow[];
  mhShift: number;
}

export interface TradeColumn {
  trade: string;
  rows: ShiftRow[];
  mhShift: number;
  remaining: number;
}

export interface TomorrowBoard {
  shift: ShiftWindow;
  /** The instant the engine evaluated the holds at — the shift's start. */
  evaluatedAt: number;
  asOfMs: number;
  clearable: ClearanceGroup[];
  selfClearing: SelfClearRow[];
  needsPlan: SpaceRow[];
  sendable: TradeColumn[];
  undated: Activity[];
  unlocated: Activity[];
  totals: {
    activities: number;
    mhShift: number;
    mhClearable: number;
    /** Hours behind holds that clear on a clock during or after the shift
     *  (rows cured before the start are sendable and counted there). */
    mhSelf: number;
    mhPlan: number;
    mhSendable: number;
  };
}

/** `isolation_authority` → `isolation authority`. */
export const authorityWord = (s: string): string => s.replace(/_/g, " ");

const CAVEAT: Record<Confidence, string> = {
  computed: "",
  assumes_actor: "ASSUMES ATTENDANCE",
  assumes_own_authorization: "ASSUMES ITS OWN PERMIT",
};

/** The caveat word a group carries, or nothing for a computed effect. */
export const confidenceWord = (c: Confidence): string => CAVEAT[c];

const byMhDesc = <T extends { mhShift: number }>(x: T, y: T): number => y.mhShift - x.mhShift;

const sum = (rows: ShiftRow[]): number => rows.reduce((s, r) => s + r.mhShift, 0);

const tradesOf = (rows: ShiftRow[]): string[] => [...new Set(rows.map((r) => r.a.trade))].sort();

/** The action's three words: who, what, where. */
function describe(action: MitigationAction): { actor: string; hazard: string; origin: string } {
  switch (action.kind) {
    case "discharge":
      return { actor: authorityWord(action.actor), hazard: action.hazard, origin: action.origin };
    case "interrupt":
      return { actor: "own work + permit", hazard: `Isolate ${authorityWord(action.coupling)}`, origin: `${action.from} → ${action.to}` };
    case "wait":
      return { actor: "nobody", hazard: "wait for the hold to expire", origin: fmtDayTime(action.until) };
  }
}

interface Ctx {
  shift: ShiftWindow;
  atStart: Map<string, DeckStateRow>;
  now: Map<string, DeckStateRow>;
  bySpace: Map<string, ShiftRow[]>;
}

const heldIn = (idx: Map<string, DeckStateRow>, no: string): boolean => idx.get(no)?.permits_work === false;

/** Holds that clear on a clock before the shift ends: self-clearing, never a phone call. */
function duringShift(ctx: Ctx, taken: Set<string>): SelfClearRow[] {
  const out: SelfClearRow[] = [];
  for (const [no, rows] of ctx.bySpace) {
    const s = ctx.atStart.get(no);
    if (!s || s.permits_work || s.earliest_clear === null || s.earliest_clear >= ctx.shift.end) continue;
    taken.add(no);
    out.push({
      space: no, name: s.compartment.name, heldNow: heldIn(ctx.now, no), heldAtStart: true,
      clearsAt: s.earliest_clear, when: "during_shift", authority: authorityWord(s.clearing_authority),
      rules: s.rules_fired, rows, mhShift: sum(rows),
    });
  }
  return out.sort(byMhDesc);
}

/** Single actions at the start, largest first, each space grouped once under
 *  the action that frees the most of the shift. */
function clearableGroups(ctx: Ctx, leverage: Mitigation[], taken: Set<string>): ClearanceGroup[] {
  const withWork = (frees: string[]): string[] =>
    frees.filter((no) => ctx.bySpace.has(no) && heldIn(ctx.atStart, no));
  const candidates = leverage
    .filter((m) => m.action.kind !== "wait")
    .map((m) => ({ m, spaces: withWork(m.effect.frees) }))
    .filter((c) => c.spaces.length > 0)
    .map((c) => ({ ...c, mh: c.spaces.reduce((s, no) => s + sum(ctx.bySpace.get(no) ?? []), 0) }))
    .sort((x, y) => y.mh - x.mh);
  const out: ClearanceGroup[] = [];
  for (const { m, spaces } of candidates) {
    const mine = spaces.filter((no) => !taken.has(no));
    if (mine.length === 0) continue;
    for (const no of mine) taken.add(no);
    const rows = mine.flatMap((no) => ctx.bySpace.get(no) ?? []).sort(byMhDesc);
    out.push({
      action: m.action, ...describe(m.action), confidence: m.confidence,
      frees: m.effect.frees, freesWithWork: spaces.length, closes: m.effect.closes,
      rows, mhShift: sum(rows), trades: tradesOf(rows), spaces: mine,
    });
  }
  return out.sort(byMhDesc);
}

/** What is left held at the start: a clock past the shift's end, or no clock and no action. */
function leftHeld(ctx: Ctx, taken: Set<string>): { after: SelfClearRow[]; plan: SpaceRow[] } {
  const after: SelfClearRow[] = [];
  const plan: SpaceRow[] = [];
  for (const [no, rows] of ctx.bySpace) {
    const s = ctx.atStart.get(no);
    if (!s || s.permits_work || taken.has(no)) continue;
    taken.add(no);
    const base = { space: no, name: s.compartment.name, rules: s.rules_fired, rows, mhShift: sum(rows), authority: authorityWord(s.clearing_authority) };
    if (s.earliest_clear !== null) {
      after.push({ ...base, heldNow: heldIn(ctx.now, no), heldAtStart: true, clearsAt: s.earliest_clear, when: "after_shift" });
    } else {
      plan.push(base);
    }
  }
  return { after: after.sort(byMhDesc), plan: plan.sort(byMhDesc) };
}

/** Held now, open at the start: the hold cures before the crew arrives. */
function curedBefore(ctx: Ctx): SelfClearRow[] {
  const out: SelfClearRow[] = [];
  for (const [no, rows] of ctx.bySpace) {
    const n = ctx.now.get(no);
    if (!n || n.permits_work || heldIn(ctx.atStart, no)) continue;
    out.push({
      space: no, name: n.compartment.name, heldNow: true, heldAtStart: false,
      clearsAt: n.earliest_clear, when: "before_shift", authority: authorityWord(n.clearing_authority),
      rules: n.rules_fired, rows, mhShift: sum(rows),
    });
  }
  return out.sort(byMhDesc);
}

/** Per trade, heaviest first — the columns the shift board already reads. */
function tradeColumns(rows: ShiftRow[]): TradeColumn[] {
  const groups = new Map<string, ShiftRow[]>();
  for (const r of rows) groups.set(r.a.trade, [...(groups.get(r.a.trade) ?? []), r]);
  return [...groups.entries()]
    .map(([trade, list]) => ({
      trade,
      rows: list.sort(byMhDesc),
      mhShift: sum(list),
      remaining: list.reduce((s, r) => s + r.a.remaining_hours, 0),
    }))
    .sort(byMhDesc);
}

/**
 * The board. Every located activity on the shift lands in exactly one
 * section, decided by the engine's verdict for its space at the shift's
 * start: a clock that runs out inside the shift → *clears on its own*; a
 * single action that frees it → *clearable tonight*, grouped under the
 * action that frees the most; a clock past the shift → *clears on its own
 * (after)*; held with neither → *needs a plan*; open at start → *sendable*.
 * Spaces held now but open at start are listed as cured, and their work is
 * sendable. Unlocated and undated rows are counted, never dropped.
 */
export function tomorrowBoard(input: TomorrowInput): TomorrowBoard {
  const { shift, asOfMs, activities, spacesNow, spacesAtStart, leverageAtStart, zone } = input;
  const atStart = new Map(spacesAtStart.map((r) => [r.compartment.compartment_no, r]));
  const now = new Map(spacesNow.map((r) => [r.compartment.compartment_no, r]));
  const zoneOf = (no: string): string | null =>
    atStart.get(no)?.compartment.zone ?? now.get(no)?.compartment.zone ?? null;
  const inZone = (a: Activity): boolean =>
    zone === null || (a.compartment_no !== null ? zoneOf(a.compartment_no) === zone : a.wbs_area === zone);
  const onShift = activities.filter(
    (a) =>
      !a.is_milestone &&
      a.status !== "complete" &&
      (a.planned === null || (a.planned.start < shift.end && a.planned.end > shift.start)) &&
      inZone(a),
  );
  const hours = (a: Activity): number => activityWindowHours(a, shift.start, shift.end);
  const unlocated = onShift.filter((a) => a.compartment_no === null);
  const undated = onShift.filter((a) => a.planned === null);
  const bySpace = new Map<string, ShiftRow[]>();
  for (const a of onShift) {
    if (a.compartment_no === null) continue;
    const row: ShiftRow = { a, space: a.compartment_no, mhShift: hours(a) };
    bySpace.set(a.compartment_no, [...(bySpace.get(a.compartment_no) ?? []), row]);
  }
  const ctx: Ctx = { shift, atStart, now, bySpace };
  const taken = new Set<string>();
  const during = duringShift(ctx, taken);
  const clearable = clearableGroups(ctx, leverageAtStart, taken);
  const { after, plan } = leftHeld(ctx, taken);
  const before = curedBefore(ctx);
  const sendableRows = [...bySpace.entries()].filter(([no]) => !taken.has(no)).flatMap(([, rows]) => rows);
  const sendable = tradeColumns(sendableRows);
  const selfClearing = [...during, ...after, ...before];
  return {
    shift,
    evaluatedAt: shift.start,
    asOfMs,
    clearable,
    selfClearing,
    needsPlan: plan,
    sendable,
    undated,
    unlocated,
    totals: {
      activities: onShift.length,
      mhShift: onShift.reduce((s, a) => s + hours(a), 0),
      mhClearable: clearable.reduce((s, g) => s + g.mhShift, 0),
      mhSelf: [...during, ...after].reduce((s, r) => s + r.mhShift, 0),
      mhPlan: plan.reduce((s, r) => s + r.mhShift, 0),
      mhSendable: sum(sendableRows),
    },
  };
}

/* ------------------------------------------------------------------ words */

const nActs = (n: number): string => `${n} ${n === 1 ? "activity" : "activities"}`;
const nSpaces = (n: number): string => `${n} space${n === 1 ? "" : "s"}`;
const mhWord = (n: number): string => `${Math.round(n).toLocaleString()} MH`;

/** The group's header, as the board and the sheet both read it. */
export function groupHeadline(g: ClearanceGroup): string {
  const parts = [
    `${g.actor} · ${g.hazard} · ${g.origin}`,
    `frees ${nSpaces(g.frees.length)}${g.freesWithWork !== g.frees.length ? ` (${g.freesWithWork} with work on this shift)` : ""}`,
    `${nActs(g.rows.length)} · ${mhWord(g.mhShift)} on the shift`,
    g.trades.join(", "),
  ];
  const caveat = confidenceWord(g.confidence);
  if (caveat) parts.push(caveat);
  if (g.closes.length > 0) parts.push(`would shut ${nSpaces(g.closes.length)}`);
  return parts.join(" · ");
}

/** The self-clearing row's sentence: held now or not, and when it clears. */
export function selfClearSentence(r: SelfClearRow, shift: ShiftWindow): string {
  const rules = r.rules.length > 0 ? ` (${r.rules.join(" + ")})` : "";
  switch (r.when) {
    case "before_shift":
      return `held now${rules} · ${r.clearsAt !== null ? `cures on its own by ${fmtTime(r.clearsAt)} ${fmtDay(r.clearsAt)}` : "open by the shift start"} · open at shift start · ${nActs(r.rows.length)} · ${mhWord(r.mhShift)}`;
    case "during_shift":
      return `held at shift start${rules} · clears at ${fmtTime(r.clearsAt ?? shift.start)} — send the crew after · ${nActs(r.rows.length)} · ${mhWord(r.mhShift)}`;
    case "after_shift":
      return `held at shift start${rules} · will not clear before ${fmtTime(shift.end)} (clears ${fmtDayTime(r.clearsAt ?? shift.end)}) — see Week Ahead for the engine's window · ${nActs(r.rows.length)} · ${mhWord(r.mhShift)}`;
  }
}

/** The needs-a-plan row's sentence. */
export function planSentence(r: SpaceRow): string {
  const rules = r.rules.length > 0 ? ` (${r.rules.join(" + ")})` : "";
  return `held at shift start; no single action opens it${rules} · ${r.authority} · ${nActs(r.rows.length)} · ${mhWord(r.mhShift)} — open the options panel`;
}

/** The projection strip every surface of this board carries. */
export function projectionNote(board: TomorrowBoard): string {
  return `PROJECTED · evaluated by the engine at ${fmtDayTime(board.evaluatedAt)} under the field conditions recorded as of ${fmtDayTime(board.asOfMs)} · overnight tag-outs are not on this board · NOT AN AUTHORIZATION`;
}

/** The activity's slot as a foreman reads it. */
export const slotWord = (w: { start: number; end: number } | null): string => {
  if (!w) return "undated";
  return w.end - w.start <= 86_400_000
    ? `${fmtDay(w.start)} ${fmtTime(w.start)}–${fmtTime(w.end)}`
    : `${fmtDay(w.start)} → ${fmtDay(w.end)}`;
};

/* ------------------------------------------------------------------ sheet */

const ROW_COLUMNS = ["Activity", "Name", "Space", "Trade", "Slot", "MH on the shift"];

const rowCells = (r: ShiftRow): string[] => [
  r.a.code,
  r.a.name,
  r.space,
  r.a.trade,
  slotWord(r.a.planned),
  Math.round(r.mhShift).toLocaleString(),
];

function emptyOr(section: ReportSection, empty: string): ReportSection {
  return section.rows.length > 0 ? section : { ...section, columns: ["—"], numeric: [], rows: [[empty]] };
}

/** The printed board: the cut, the projection note, every section, the layers. */
export function tomorrowSheet(board: TomorrowBoard, cut: ReportCut, zone: string | null): Report {
  const clearable: ReportSection[] = board.clearable.map((g, i) => ({
    heading: `Clearable tonight ${i + 1} of ${board.clearable.length} — ${g.actor}`,
    note: groupHeadline(g),
    columns: ROW_COLUMNS,
    numeric: [5],
    rows: g.rows.map(rowCells),
  }));
  const codes = (rows: ShiftRow[]): string => rows.map((r) => r.a.code).join(" ");
  const selfClearing: ReportSection = {
    heading: "Clears on its own",
    note: "Holds on a clock: cured before the start (the work is sendable and counted below), or clearing during or after the shift.",
    columns: ["Space", "Name", "Reads", "Work", "MH on the shift"],
    numeric: [4],
    rows: board.selfClearing.map((r) => [r.space, r.name, selfClearSentence(r, board.shift), codes(r.rows), Math.round(r.mhShift).toLocaleString()]),
  };
  const plan: ReportSection = {
    heading: "Needs a plan",
    note: "Held at the shift start with no clock and no single action that opens it.",
    columns: ["Space", "Name", "Reads", "Work", "MH on the shift"],
    numeric: [4],
    rows: board.needsPlan.map((r) => [r.space, r.name, planSentence(r), codes(r.rows), Math.round(r.mhShift).toLocaleString()]),
  };
  const sendable: ReportSection[] = board.sendable.map((col) => ({
    heading: `Sendable — ${col.trade}`,
    note: `${nActs(col.rows.length)} · ${mhWord(col.mhShift)} on the shift · ${mhWord(col.remaining)} open in total`,
    columns: [...ROW_COLUMNS, "As planned"],
    numeric: [5],
    rows: col.rows.map((r) => [...rowCells(r), r.a.executability.verdict === "not_executable" ? "NOT EXECUTABLE AS PLANNED" : ""]),
  }));
  const counted: ReportSection = {
    heading: "Counted, not placed",
    columns: ["Why", "Activity", "Name", "Trade"],
    rows: [
      ...board.unlocated.map((a) => ["not located — cannot be assessed", a.code, a.name, a.trade]),
      ...board.undated.filter((a) => a.compartment_no !== null).map((a) => ["undated — rides every shift, no shift hours", a.code, a.name, a.trade]),
    ],
  };
  return {
    id: "tomorrow",
    name: "Tomorrow's board",
    question: "What the next shift walks into, and who can clear it tonight",
    scope: `${board.shift.label} · ${fmtDay(board.shift.start)}${zone ? ` · Zone ${zone}` : " · all zones"}`,
    cut,
    sections: [
      ...(clearable.length > 0 ? clearable : [{ heading: "Clearable tonight", columns: ["—"], rows: [["No single action at the shift start frees a space with work on it."]] }]),
      emptyOr(selfClearing, "No hold on a clock stands in front of this shift."),
      emptyOr(plan, "Every held space has a clock or a single clearing action."),
      ...(sendable.length > 0 ? sendable : [{ heading: "Sendable", columns: ["—"], rows: [["Nothing on this shift is open at its start."]] }]),
      ...(counted.rows.length > 0 ? [counted] : []),
    ],
    notes: [
      projectionNote(board),
      "MH: schedule of record, pro-rated into the shift by the shell.",
      "Holds and clearances: the engine at the shift start, under the field conditions recorded at the cut; the clearing actions are the engine's leverage read at the same instant.",
      "Held now: the engine at the cut instant.",
      clockNote(cut.asOfMs),
    ],
  };
}

// The client side of the import doors, shared by every screen that has one.
//
// Each door's home screen (Sequence Board, Deck Explorer, Work Orders) and
// the Sources panel all accept the same documents; parsing the same CSV two
// ways on two screens is how two screens learn to disagree, so the parsing
// lives here once. The parsers are deliberately strict about shape and
// permissive about noise: blank lines and #-comments are skipped, and every
// header row is left for the server to refuse — the all-or-nothing verdict,
// with every rejection reason, is the server's to give.

import {
  HAZARD_KINDS,
  type BudgetItem,
  type CouplingRow,
  type DeckBand,
  type FieldMap,
  type FieldSlot,
  type FieldSource,
  type FieldsSeen,
  type HazardLogRow,
  type ImportedBy,
  type ManningCrew,
  type QuarantinedRow,
  type RegisterDeck,
  type RegisterSpace,
  type ScheduleRunSummary,
  type SpaceGeometry,
  type XerEncoding,
  type ZoneBound,
} from "./api";
import { fmtDayTime } from "./clock";
import { DEMO_PEOPLE } from "./demo";

/**
 * CSV: `zone,lo_frame,hi_frame[,top_deck,bottom_deck]` — the yard's zone
 * chart, one block per row. A zone may own several blocks; a block with a
 * deck band owns that frame band on those decks only (docs/zone-scheme.md).
 */
export function parseZoneCsv(text: string): ZoneBound[] {
  const bounds: ZoneBound[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [zone, lo, hi, top, bottom] = t.split(",").map((p) => p.trim());
    bounds.push({
      zone: zone ?? "",
      lo_frame: Number(lo),
      hi_frame: Number(hi),
      ...(top ? { top_deck: top } : {}),
      ...(bottom ? { bottom_deck: bottom } : {}),
    });
  }
  return bounds;
}

/** CSV: `code,title,trade,budget_mh,earned_mh` — the yard's budget book. */
export function parseBudgetCsv(text: string): BudgetItem[] {
  const items: BudgetItem[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [code, title, trade, budget, earned] = t.split(",").map((x) => x.trim());
    items.push({
      code: code ?? "",
      title: title ?? "",
      trade: trade ?? "",
      budget_hours: Number(budget),
      earned_hours: Number(earned),
    });
  }
  return items;
}

/** CSV: `trade,headcount` — the yard's manning book, per half-shift. */
export function parseManningCsv(text: string): ManningCrew[] {
  const crews: ManningCrew[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [trade, headcount] = t.split(",").map((x) => x.trim());
    crews.push({ trade: trade ?? "", headcount: Number(headcount) });
  }
  return crews;
}

/**
 * CSV for the geometry register — record-typed lines, one file:
 * `space,<compartment_no>,<fwd_frame>,<aft_frame>` and
 * `deck,<deck_code>,<lo_frame>,<hi_frame>`.
 */
export function parseGeometryCsv(text: string): { spaces: SpaceGeometry[]; decks: DeckBand[] } {
  const spaces: SpaceGeometry[] = [];
  const decks: DeckBand[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [kind, a, b, c] = t.split(",").map((x) => x.trim());
    if (kind === "space") {
      spaces.push({ compartment_no: a ?? "", fwd_frame: Number(b), aft_frame: Number(c) });
    } else if (kind === "deck") {
      decks.push({ deck_code: a ?? "", lo_frame: Number(b), hi_frame: Number(c) });
    } else {
      // A row that is neither kind cannot be carried to the server, and
      // dropping it silently would import "whole" minus the losses — the
      // exact thing the all-or-nothing door exists to prevent. Refuse the
      // FILE, loudly, before anything is staged.
      throw new Error(
        `geometry CSV: unrecognised record kind ${JSON.stringify(kind)} — every line must start with "space," or "deck," (line: ${JSON.stringify(t.slice(0, 60))})`,
      );
    }
  }
  return { spaces, decks };
}

/**
 * CSV for the compartment register — record-typed lines, one file:
 * `deck,<code>,<label>,<ordinal>` and
 * `space,<compartment_no>,<name>,<deck_code>,<zone>,<category>[,<frame>,<side>]`.
 * Trailing optional columns may be blank; a line of any other kind refuses
 * the file, loudly, before anything is staged.
 */
export function parseRegisterCsv(text: string): { decks: RegisterDeck[]; spaces: RegisterSpace[] } {
  const decks: RegisterDeck[] = [];
  const spaces: RegisterSpace[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const cols = t.split(",").map((x) => x.trim());
    const kind = cols[0];
    if (kind === "deck") {
      // A blank label falls back to the code: a deck named nothing is still a deck.
      decks.push({ code: cols[1] ?? "", label: cols[2] || cols[1] || "", ordinal: Number(cols[3]) });
    } else if (kind === "space") {
      const frame = cols[6];
      const side = cols[7];
      spaces.push({
        compartment_no: cols[1] ?? "",
        name: cols[2] ?? "",
        deck_code: cols[3] ?? "",
        zone: cols[4] ?? "",
        category: cols[5] ?? "",
        ...(frame ? { frame: Number(frame) } : {}),
        ...(side ? { side: side.toLowerCase() } : {}),
      });
    } else {
      throw new Error(
        `register CSV: unrecognised record kind ${JSON.stringify(kind)} — every line must start with "deck," or "space," (line: ${JSON.stringify(t.slice(0, 60))})`,
      );
    }
  }
  return { decks, spaces };
}

/**
 * CSV: `from,to,code[,symmetric]` — the hull's coupling register. The
 * fourth column reads `yes`, `true`, `1` or `symmetric` to store the reverse
 * path too. Every row a person lists is `authored`; the door derives the rest.
 */
export function parseCouplingCsv(text: string): CouplingRow[] {
  const rows: CouplingRow[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [from, to, code, sym] = t.split(",").map((x) => x.trim());
    rows.push({
      from: from ?? "",
      to: to ?? "",
      code: code ?? "",
      symmetric: /^(yes|true|1|symmetric)$/i.test(sym ?? ""),
      provenance: "authored",
    });
  }
  return rows;
}

/** The engine's kind name for a log's column, accepting the yard word too
 *  (`Hot work live`, `hot-work-live`, `stop_work`); null when neither. */
export function hazardKindFromLog(raw: string): string | null {
  const norm = raw.trim().toLowerCase().replace(/[\s-]+/g, "_");
  const hit = HAZARD_KINDS.find(
    (k) => k.kind === norm || k.label.toLowerCase().replace(/[\s-]+/g, "_") === norm,
  );
  return hit?.kind ?? null;
}

/** An instant from a log's `since` column: ISO-8601 or epoch milliseconds. */
function sinceFromLog(raw: string): number | null {
  const s = raw.trim();
  if (!s) return null;
  if (/^\d{13,}$/.test(s)) return Number(s);
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * CSV: `compartment,kind,label[,since]` — the day's tag-out or permit log.
 * The label runs to the last comma when the final column parses as an
 * instant, and to the end of the line otherwise, so a label may carry commas.
 * A kind the engine does not evaluate, or a `since` that is not an instant,
 * refuses the file before anything is staged: a row that silently lost its
 * kind or its clock would be the exact thing the door exists to prevent.
 */
export function parseHazardLogCsv(text: string): HazardLogRow[] {
  const rows: HazardLogRow[] = [];
  let n = 0;
  for (const line of text.split("\n")) {
    n += 1;
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const cols = t.split(",").map((x) => x.trim());
    const compartment = cols[0] ?? "";
    const kindRaw = cols[1] ?? "";
    const kind = hazardKindFromLog(kindRaw);
    if (!kind) {
      throw new Error(
        `hazard log CSV line ${n}: ${JSON.stringify(kindRaw)} is not a field condition the engine evaluates (${HAZARD_KINDS.map((k) => k.kind).join(", ")})`,
      );
    }
    let labelCols = cols.slice(2);
    let since: number | null = null;
    if (labelCols.length >= 2) {
      const last = labelCols[labelCols.length - 1] ?? "";
      const asInstant = sinceFromLog(last);
      if (asInstant !== null) {
        since = asInstant;
        labelCols = labelCols.slice(0, -1);
      } else if (/^\d{4}-\d{2}-\d{2}/.test(last) || /^\d+$/.test(last)) {
        throw new Error(`hazard log CSV line ${n}: ${JSON.stringify(last)} is not an instant`);
      }
    }
    const label = labelCols.join(", ");
    rows.push({ compartment, kind, label, ...(since !== null ? { since_ms: since } : {}) });
  }
  return rows;
}

/* ------------------------------------------------------- the XER's bytes */

/**
 * An export's bytes as text, and which decoder branch was taken. Valid
 * UTF-8 passes through (a leading byte-order mark stripped); anything else
 * is Windows-1252 — P6's default on Windows, and an encoding every byte
 * sequence is valid in. The server has the same two branches
 * (`wadl_ingest::encoding::decode_xer`) for the boot loader and the CLI;
 * the door's body carries `encoding` so the run says which decoder read the
 * file, and one shared literal (bytes `93 94 E9 96 80` → `“ ” é – €`) pins
 * both. `TextDecoder("windows-1252")` is built into every browser and Node.
 */
export function decodeXerBytes(bytes: ArrayBuffer | Uint8Array): { xer: string; encoding: XerEncoding } {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    const xer = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(view);
    return { xer, encoding: "utf-8" };
  } catch {
    return { xer: new TextDecoder("windows-1252").decode(view), encoding: "windows-1252" };
  }
}

/** The picked file, decoded in the browser, with the branch reported. */
export async function decodeXerFile(file: File): Promise<{ xer: string; encoding: XerEncoding }> {
  return decodeXerBytes(await file.arrayBuffer());
}

/* ---------------------------------------------------------- the field map */

/** One source in yard words: `UDF "COMPT"`, `activity code "LOC"`, `resource`, `not carried`. */
export function fieldSourceWords(s: FieldSource): string {
  switch (s.source) {
    case "udf": return `UDF "${s.name}"`;
    case "activity_code": return `activity code "${s.name}"`;
    case "resource": return "resource";
    case "none": return "not carried";
  }
}

/** The map in one line — the same words the server's `FieldMap::summary` uses. */
export function fieldMapSummary(m: FieldMap): string {
  return (
    `compartment ← ${fieldSourceWords(m.compartment)} · work item ← ${fieldSourceWords(m.work_item)}` +
    ` · work type ← ${fieldSourceWords(m.work_type)} · trade ← ${fieldSourceWords(m.trade)}` +
    ` · projects: ${m.projects.length === 0 ? "all" : m.projects.join(", ")}` +
    ` · placards ${m.placards_from_names ? "read" : "not read"} from task names`
  );
}

/** One option of a field-map select. `key` round-trips through `sourceFromChoice`. */
export interface FieldChoice {
  key: string;
  label: string;
  source: FieldSource;
}

/** The select's key for a source, so a stored map lands on its own option. */
export function choiceKey(s: FieldSource): string {
  switch (s.source) {
    case "udf": return `udf:${s.name}`;
    case "activity_code": return `code:${s.name}`;
    case "resource": return "resource";
    case "none": return "none";
  }
}

/**
 * What a slot's select offers, built from the file's own survey: `(none)`,
 * every UDF with its row count, every activity code type with its count,
 * and — for the trade only — the resource. A map naming a field the file
 * does not carry keeps its option, marked, so the stored choice is never
 * silently dropped.
 */
export function fieldChoices(seen: FieldsSeen | null, slot: FieldSlot, current?: FieldSource): FieldChoice[] {
  const out: FieldChoice[] = [{ key: "none", label: "(none)", source: { source: "none" } }];
  if (slot === "trade") out.push({ key: "resource", label: "Resource (RSRC, first labor assignment)", source: { source: "resource" } });
  for (const u of seen?.udfs ?? []) {
    out.push({
      key: `udf:${u.name}`,
      label: `UDF: ${u.name}${u.label && u.label !== u.name ? ` — ${u.label}` : ""} (${u.values.toLocaleString()} row${u.values === 1 ? "" : "s"})`,
      source: { source: "udf", name: u.name },
    });
  }
  for (const t of seen?.activity_code_types ?? []) {
    out.push({
      key: `code:${t.name}`,
      label: `Activity code: ${t.name} (${t.values.toLocaleString()})`,
      source: { source: "activity_code", name: t.name },
    });
  }
  if (current && !out.some((c) => c.key === choiceKey(current))) {
    out.push({
      key: choiceKey(current),
      label: `${fieldSourceWords(current)} — not in this file`,
      source: current,
    });
  }
  return out;
}

/* ------------------------------------------------------- the quarantine */

/** The class names in yard words. */
const CLASS_WORDS: Record<string, string> = {
  unparseable_date: "unparseable date",
  backwards_window: "backwards window",
  unknown_status: "unknown status",
  no_code: "no code",
  no_name: "no name",
  width: "width",
  cross_project_logic: "cross-project logic",
  unknown_task_in_logic: "unknown task in logic",
  structure: "structure",
};

export const classWords = (c: string): string => CLASS_WORDS[c] ?? c.replace(/_/g, " ");

/** `5 quarantined — 3 cross-project logic, 2 unparseable dates`; `nothing quarantined`. */
export function quarantineSummary(rows: QuarantinedRow[]): string {
  if (rows.length === 0) return "nothing quarantined";
  const byClass = new Map<string, number>();
  for (const r of rows) byClass.set(r.class, (byClass.get(r.class) ?? 0) + 1);
  const parts = [...byClass.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([c, n]) => `${n} ${classWords(c)}${n > 1 && c === "unparseable_date" ? "s" : ""}`);
  return `${rows.length} quarantined — ${parts.join(", ")}`;
}

/** The rows grouped by class, largest group first, file order inside. */
export function quarantineGroups(rows: QuarantinedRow[]): { class: string; rows: QuarantinedRow[] }[] {
  const groups = new Map<string, QuarantinedRow[]>();
  for (const r of rows) {
    const g = groups.get(r.class);
    if (g) g.push(r);
    else groups.set(r.class, [r]);
  }
  return [...groups.entries()]
    .map(([c, rs]) => ({ class: c, rows: rs }))
    .sort((a, b) => b.rows.length - a.rows.length || a.class.localeCompare(b.class));
}

/** The fold: the first `limit` rows unless the reader asked for all, and how
 *  many stay behind the foot — so the count is always said. */
export function foldRows<T>(rows: T[], showAll: boolean, limit = 25): { shown: T[]; hidden: number } {
  if (showAll || rows.length <= limit) return { shown: rows, hidden: 0 };
  return { shown: rows.slice(0, limit), hidden: rows.length - limit };
}

/** `excluded: 3 level-of-effort (A9001, A9002, A9003) · 1 WBS summary (Z6-SUM) · 2 in project CVN73-DSRA27`; `nothing excluded`. */
export function exclusionSummary(x: { loe: string[]; wbs: string[]; project: [string, string][] }): string {
  const list = (codes: string[]) => codes.slice(0, 6).join(", ") + (codes.length > 6 ? ", …" : "");
  const byProject = new Map<string, number>();
  for (const [, p] of x.project) byProject.set(p, (byProject.get(p) ?? 0) + 1);
  const parts = [
    x.loe.length > 0 ? `${x.loe.length} level-of-effort (${list(x.loe)})` : null,
    x.wbs.length > 0 ? `${x.wbs.length} WBS summar${x.wbs.length === 1 ? "y" : "ies"} (${list(x.wbs)})` : null,
    ...[...byProject.entries()].map(([p, n]) => `${n} in project ${p}`),
  ].filter(Boolean);
  return parts.length === 0 ? "nothing excluded" : `excluded: ${parts.join(" · ")}`;
}

/* ------------------------------------------------------------- the runs */

/** A person as the shell can name them: a demo id becomes its demo name;
 *  anything else is the asserted id itself. */
export function personWords(id: string): string {
  const demo = Object.values(DEMO_PEOPLE).find((p) => p.id === id);
  return demo ? demo.name : id;
}

/** `Demo Planner (Y-1001)` · `org …0001 (no person on record)` — plus the
 *  door when it was not the door: `· at boot`, `· by CLI`. */
export function importedByWords(by: ImportedBy): string {
  const who = by.person ? personWords(by.person) : `org …${by.org.slice(-4)} (no person on record)`;
  const via = by.via === "boot" ? " · at boot" : by.via === "cli" ? " · by CLI" : "";
  return `${who}${via}`;
}

/** The breadcrumb's words for the served run: what is being read, when it
 *  came in, and whose export it is. Never blank — the caller passes null for
 *  the generated register and "unavailable" for a failed read. */
export function scheduleCrumb(run: ScheduleRunSummary | null | "unavailable"): { text: string; tone: "ok" | "dim" | "warn" } {
  if (run === "unavailable") return { text: "schedule source unavailable", tone: "warn" };
  if (run === null) return { text: "reading the generated register", tone: "dim" };
  return {
    text: `reading ${run.label} · imported ${fmtDayTime(run.imported_at_ms)} by ${importedByWords(run.imported_by)}`,
    tone: run.imported_by.person ? "ok" : "warn",
  };
}

/** One run's line in the history: `#3 · CVN73-PIA26-full.xer · 09/04 06:12 · by … · 5,706 rows served · 0 quarantined · utf-8`. */
export function runLine(r: ScheduleRunSummary): string {
  return (
    `#${r.seq} · ${r.label} · ${fmtDayTime(r.imported_at_ms)} · by ${importedByWords(r.imported_by)}` +
    ` · ${r.counts.served.toLocaleString()} rows served · ${r.counts.quarantined.toLocaleString()} quarantined · ${r.encoding}`
  );
}

/** A file size a human reads: a real P6 export is megabytes, and the reader
 *  deserves to see that the door knows it. */
export const fmtBytes = (n: number): string =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`;

/** The re-import delta, as one sentence a planner reads before Confirm. */
export function deltaSummary(d: {
  baseline: string;
  added: number;
  removed: number;
  retimed: number;
  rehoused: number;
  newly_refused: { count: number; examples: { code: string; space: string; rule: string }[] };
  newly_clear: { count: number };
  proposals?: { open: number; reflected: string[]; still_open: string[] };
}): string {
  const moves = [
    d.added > 0 ? `+${d.added} new` : null,
    d.removed > 0 ? `−${d.removed} gone` : null,
    d.retimed > 0 ? `${d.retimed} retimed` : null,
    d.rehoused > 0 ? `${d.rehoused} moved space` : null,
  ].filter(Boolean).join(" · ");
  const ex = d.newly_refused.examples
    .slice(0, 3)
    .map((e) => `${e.code}${e.space ? ` in ${e.space}` : ""} by ${e.rule}`)
    .join(", ");
  const shift =
    d.newly_refused.count > 0
      ? `⚠ ${d.newly_refused.count} newly NOT executable (${ex}${d.newly_refused.count > 3 ? ", …" : ""})`
      : "no work moved into a refusal";
  const clears = d.newly_clear.count > 0 ? ` · ${d.newly_clear.count} refusal${d.newly_clear.count === 1 ? "" : "s"} cleared` : "";
  // The loop closing: which of this board's open proposals the export took.
  const p = d.proposals;
  const proposals =
    p && p.open > 0
      ? ` · proposals: ${p.reflected.length} of ${p.open} reflected${p.reflected.length > 0 ? ` (${p.reflected.slice(0, 4).join(", ")}${p.reflected.length > 4 ? ", …" : ""})` : ""}${p.still_open.length > 0 ? `, ${p.still_open.length} still open` : ""}`
      : "";
  return `vs ${d.baseline}: ${moves || "no rows changed"} — ${shift}${clears}${proposals}`;
}

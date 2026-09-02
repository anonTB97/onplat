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
  type HazardLogRow,
  type ManningCrew,
  type RegisterDeck,
  type RegisterSpace,
  type SpaceGeometry,
  type ZoneBound,
} from "./api";

/** CSV: `zone,lo_frame,hi_frame` — the yard's zone chart. */
export function parseZoneCsv(text: string): ZoneBound[] {
  const bounds: ZoneBound[] = [];
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const [zone, lo, hi] = t.split(",").map((p) => p.trim());
    bounds.push({ zone: zone ?? "", lo_frame: Number(lo), hi_frame: Number(hi) });
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
  return `vs ${d.baseline}: ${moves || "no rows changed"} — ${shift}${clears}`;
}

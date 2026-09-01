// The client side of the import doors, shared by every screen that has one.
//
// Each door's home screen (Sequence Board, Deck Explorer, Work Orders) and
// the Sources panel all accept the same documents; parsing the same CSV two
// ways on two screens is how two screens learn to disagree, so the parsing
// lives here once. The parsers are deliberately strict about shape and
// permissive about noise: blank lines and #-comments are skipped, and every
// header row is left for the server to refuse — the all-or-nothing verdict,
// with every rejection reason, is the server's to give.

import type { BudgetItem, DeckBand, ManningCrew, SpaceGeometry, ZoneBound } from "./api";

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

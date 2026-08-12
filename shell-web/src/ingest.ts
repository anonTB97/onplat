// The client side of the import doors, shared by every screen that has one.
//
// Each door's home screen (Sequence Board, Deck Explorer, Work Orders) and
// the Sources panel all accept the same documents; parsing the same CSV two
// ways on two screens is how two screens learn to disagree, so the parsing
// lives here once. The parsers are deliberately strict about shape and
// permissive about noise: blank lines and #-comments are skipped, and every
// header row is left for the server to refuse — the all-or-nothing verdict,
// with every rejection reason, is the server's to give.

import type { BudgetItem, ZoneBound } from "./api";

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

/** A file size a human reads: a real P6 export is megabytes, and the reader
 *  deserves to see that the door knows it. */
export const fmtBytes = (n: number): string =>
  n >= 1_048_576 ? `${(n / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.ceil(n / 1024))} KB`;

// The one clock-rendering convention, stated once and imported everywhere.
//
// Every instant in this product is UTC: the API serves epoch milliseconds,
// and every surface renders them in UTC. The rule these helpers enforce is
// that **any render carrying a clock time carries the Z marker** — an
// unmarked "04:15" reads as local time, and for a yard running around the
// clock a UTC instant mistaken for local is an hours-sized misread on
// exactly the numbers (cure clears, refusal starts, shift bounds) this tool
// exists to get right. Date-only renders carry no Z; a calendar date is not
// a clock reading.
//
// Before this module, four boards each carried a private formatter and they
// disagreed about the marker — some stamped Z, some rendered bare UTC times.
// The scrubber's label (`TimeControl.fmtInstant`) stays separate on purpose:
// it is a control's caption, horizon-aware, and already marks Z on the one
// horizon that shows a time.

/** A calendar day, compact: `08/14`. Boards, gutters, window columns. */
export const fmtDay = (ms: number): string =>
  new Date(ms).toISOString().slice(5, 10).replace("-", "/");

/** A full calendar date: `2026-08-14`. Tooltips and anywhere ambiguity about
 *  the year would cost a re-read. */
export const fmtDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

/** A clock time: `04:15Z`. Shift boards. */
export const fmtTime = (ms: number): string => `${new Date(ms).toISOString().slice(11, 16)}Z`;

/** Day and time: `08/14 04:15Z`. Refusal instants, clears, as-of stamps. */
export const fmtDayTime = (ms: number): string =>
  `${new Date(ms).toISOString().slice(5, 16).replace("-", "/").replace("T", " ")}Z`;

/** A record-grade stamp with the year: `2026-08-14 04:15Z`. The ledger, print
 *  footers, receipts — anything somebody may read years later. */
export const fmtStamp = (ms: number): string =>
  `${new Date(ms).toISOString().replace("T", " ").slice(0, 16)}Z`;

/** A short month name in UTC: `Aug`. Axis labels. */
export const fmtMonth = (ms: number): string =>
  new Date(ms).toLocaleString("en-US", { month: "short", timeZone: "UTC" });

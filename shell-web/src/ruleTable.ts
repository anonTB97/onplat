// The rule table in yard words — pure readings of what the rule door serves,
// shared by the Data Sources card and its tests. Nothing here decides
// anything: the server compiles, previews, signs and refuses; this module
// turns its report into the lines a safety authority reads before Confirm
// and the statement they put their name to.

import type {
  RowReport,
  RuleEntryReport,
  RuleTableInfo,
  RuleTableMoved,
  SignOff,
  WorkTypeAudit,
} from "./api";

/** A lower_snake token as the shell says it: `marine_chemist` → `marine chemist`. */
export const tokenWord = (token: string): string => token.replace(/_/g, " ");

/** `same space` · `deck_penetration 1 hop` · `exhaust_trunk 2 hops`. */
export function appliesWord(applies: RuleEntryReport["applies"]): string {
  if (applies === "same_space") return "same space";
  if (typeof applies === "object" && applies !== null && "coupled" in applies) {
    const c = (applies as { coupled: { code: string; max_hops: number } }).coupled;
    return `${c.code} ${c.max_hops} hop${c.max_hops === 1 ? "" : "s"}`;
  }
  return "reach unreadable";
}

/** `any work` · `hot_work` · `hot_work; coating`. */
export const workWord = (workTypes: string[]): string =>
  workTypes.length === 0 ? "any work" : workTypes.join("; ");

/** `hold 30 min from the permit's close` · `hold 480 min` · `clears on verification`. */
export function holdWord(entry: RuleEntryReport): string {
  if (entry.hold === null) return "clears on verification";
  return entry.hold_from === "end"
    ? `hold ${entry.hold} min from the permit's close`
    : `hold ${entry.hold} min`;
}

/** `fires on 7 spaces (23 activities)` · `fires on nothing today`. */
export function firesWord(fires: RowReport["fires_on"]): string {
  if (!fires || fires.space_count === 0) return "fires on nothing today";
  const n = fires.space_count;
  const a = fires.activities_bound;
  return `fires on ${n} space${n === 1 ? "" : "s"} (${a} activit${a === 1 ? "y" : "ies"})`;
}

/** The row's rule and ordinal as the report and the ledger name it: `R03-1`. */
export const rowRef = (row: RowReport): string => `${row.rule}-${row.ordinal}`;

/**
 * One row in one line. Compiled:
 * `R04 · Hot work overhead of occupied space · SUSPEND · deck_penetration 1 hop · any work · hold 30 min from the permit's close · fires on 7 spaces (23 activities)`.
 * Not compiled: `R08 · Confined space entry · not compiled — Permit gate needs a permit object (out of the pilot)`.
 */
export function rowLine(row: RowReport): string {
  const head = `${row.rule}${row.ordinal > 0 ? `-${row.ordinal}` : ""} · ${row.name || "(unnamed)"}`;
  if (!row.compiled || !row.entry) return `${head} · not compiled — ${row.why_not ?? "no reason given"}`;
  const e = row.entry;
  return [
    head,
    e.state,
    appliesWord(e.applies),
    workWord(e.work_types),
    holdWord(e),
    firesWord(row.fires_on),
  ].join(" · ");
}

/**
 * Which spaces change state if this is committed: `0 spaces change state right now`
 * or `14 spaces change state · 3-156-2-Q WARN → ALLOW (R06) · … · +11 more`.
 */
export function movedLine(moved: RuleTableMoved, examples = 3): string {
  if (moved.spaces === 0) return "0 spaces change state right now";
  const shown = moved.examples
    .slice(0, examples)
    .map((m) => `${m.compartment} ${m.before} → ${m.after}${m.rule ? ` (${m.rule})` : ""}`);
  const more = moved.spaces - shown.length;
  return [
    `${moved.spaces} space${moved.spaces === 1 ? "" : "s"} change state`,
    ...shown,
    ...(more > 0 ? [`+${more} more`] : []),
  ].join(" · ");
}

/**
 * The signature line, with its tone: `signed by R. Alvarez · 09/11 14:02 · ledger #212`
 * (green), or the honest amber `unsigned — the seed is in force` /
 * `unsigned — committed, awaiting the safety authority`.
 */
export function signoffLine(
  info: Pick<RuleTableInfo, "source" | "signoff">,
  fmt: (ms: number) => string,
): { text: string; tone: "ok" | "warn" } {
  if (info.signoff) {
    const s = info.signoff;
    return {
      text: `signed by ${s.signer_name} · ${fmt(s.signed_at_ms)} · ledger #${s.ledger_seq}`,
      tone: "ok",
    };
  }
  return {
    text:
      info.source === "seed"
        ? "unsigned — the seed is in force; the safety authority signs a committed table"
        : "unsigned — committed, awaiting the safety authority's signature",
    tone: "warn",
  };
}

/**
 * `on the schedule: hot_work 1,204 · coating 980 · … · unbound: rigging, insulation`
 * — what the schedule carries per work type, and what no row names.
 */
export function workTypeLine(wt: WorkTypeAudit): { text: string; unbound: boolean } {
  const carried = wt.on_schedule.map((w) => `${w.work_type} ${w.activities.toLocaleString()}`);
  const head = carried.length > 0 ? `on the schedule: ${carried.join(" · ")}` : "the schedule carries no work type";
  const unbound = wt.unbound_on_schedule.length > 0;
  const tail = unbound
    ? ` · unbound: ${wt.unbound_on_schedule.join(", ")} — judged by the any-work rows only`
    : carried.length > 0
      ? " · every work type on the schedule is named by a row"
      : "";
  const unseen = wt.unseen_in_table.length > 0 ? ` · named by no activity: ${wt.unseen_in_table.join(", ")}` : "";
  return { text: head + tail + unseen, unbound };
}

/** `10 entries in force from 10 rows` · `10 entries in force from 8 of 20 rows`. */
export function inForceLine(info: Pick<RuleTableInfo, "rows" | "rows_total" | "rows_in_force">): string {
  const compiled = info.rows.filter((r) => r.compiled).length;
  const ruleIds = new Set(info.rows.filter((r) => r.compiled).map((r) => r.rule)).size;
  const rowsWord = ruleIds === info.rows_total ? `${info.rows_total} rows` : `${ruleIds} of ${info.rows_total} rows`;
  const notCompiled = info.rows.filter((r) => !r.compiled).length;
  return (
    `${info.rows_in_force} entr${info.rows_in_force === 1 ? "y" : "ies"} in force from ${rowsWord}` +
    (compiled !== info.rows_in_force ? ` (${compiled} compiled, the rest outside their effective range)` : "") +
    (notCompiled > 0 ? ` · ${notCompiled} not compiled, kept on file with their reason` : "")
  );
}

/** The card's status: SEED (grey) · INGESTED (blue) · SIGNED (green). */
export function statusOf(info: Pick<RuleTableInfo, "source" | "signoff">): { label: string; tone: string } {
  if (info.signoff) return { label: "SIGNED", tone: "#22c55e" };
  if (info.source === "document") return { label: "INGESTED", tone: "#3D6BFF" };
  return { label: "SEED", tone: "#94a3b8" };
}

/** The first eight of a hash — enough to read, not enough to mistake for the whole. */
export const shortHash = (hash: string): string => hash.slice(0, 8);

/**
 * The statement the authority signs, written for them to edit: who, what
 * table, how many rows, which hash — the sentence the ledger will carry.
 */
export function signStatement(
  info: Pick<RuleTableInfo, "label" | "rows_in_force" | "table_hash">,
  signerName: string,
): string {
  return (
    `I, ${signerName}, have read the ${info.rows_in_force} entr${info.rows_in_force === 1 ? "y" : "ies"} in force of ` +
    `${info.label} (${shortHash(info.table_hash)}) against the golden traces and sign this as the table the hull runs.`
  );
}

/** One row of the fold's table, from a row report. */
export interface RuleRowCells {
  ref: string;
  name: string;
  state: string;
  reach: string;
  work: string;
  hold: string;
  fires: string;
  version: string;
  compiled: boolean;
  whyNot: string | null;
}

/** The report as table rows, file order kept. */
export function tableRows(rows: RowReport[]): RuleRowCells[] {
  return rows.map((r) => ({
    ref: rowRef(r),
    name: r.name,
    state: r.entry?.state ?? "—",
    reach: r.entry ? appliesWord(r.entry.applies) : "—",
    work: r.entry ? workWord(r.entry.work_types) : "—",
    hold: r.entry ? holdWord(r.entry) : "—",
    fires: r.compiled ? firesWord(r.fires_on) : "—",
    version: r.version ? shortHash(r.version) : "—",
    compiled: r.compiled,
    whyNot: r.why_not,
  }));
}

/** The seconds-free reading of a signature for a tooltip. */
export const signoffTitle = (s: SignOff): string =>
  `${s.signer_name} (${s.signer_id}) signed ${s.rows.length} version${s.rows.length === 1 ? "" : "s"} of ${shortHash(s.table_hash)} — ledger #${s.ledger_seq}: “${s.statement}”`;

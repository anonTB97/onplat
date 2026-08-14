import { useEffect, useMemo, useState } from "react";
import {
  importBudgetBook,
  listActivities,
  listWorkOrders,
  revertBudgetBook,
  type Activity,
  type AsOf,
  type BudgetItem,
  type DeckStateRow,
  type Identity,
  type ReconciliationMismatch,
  type WorkOrder,
} from "./api";
import { parseBudgetCsv } from "./ingest";
import { Loading } from "./Loading";
import { ModuleHeader } from "./ModuleHeader";
import { commitBtnStyle, C, errText, mh, msgColor, overlayBucket, OVERLAY_STYLE, STATE_STYLE } from "./theme";
import { DiscardButton } from "./DiscardButton";
import { fmtDay } from "./clock";

// The columns the reader may sort by — the Sequence Board register's
// paradigm, applied here so the two tables the same planner reads all day
// sort the same way: click a header, click again to flip, third click
// restores the default order (largest remaining man-hours first).
type SortKey = "code" | "trade" | "compartment" | "budget" | "earned" | "remaining" | "start";

/** A planned window, at day resolution — the resolution a schedule carries. */
const fmtWindow = (w: { start: number; end: number } | null): string => {
  if (!w) return "no dates";
  return `${fmtDay(w.start)} → ${fmtDay(w.end)}`;
};

export default function WorkOrders({
  identity,
  vesselId,
  hullLabel,
  spaces,
  onOpenSpace,
  onOpenJob,
  asOf,
}: {
  identity: Identity;
  vesselId: string;
  hullLabel: string;
  /**
   * The hull's compartments with their authorization, from the shell.
   *
   * Passed in rather than fetched again so there is exactly one answer per space
   * in the running app. This table is where a planner picks what to do next, and
   * a list of work that does not say whether the space is open is a list that
   * sends a crew to a locked door.
   */
  spaces: DeckStateRow[];
  onOpenSpace: (compartment: string) => void;
  /** Opens the job card — the order's whole story in one drawer. */
  onOpenJob: (code: string) => void;
  /** The instant the list is read at; `null` is live. */
  asOf: AsOf;
}) {
  const [orders, setOrders] = useState<WorkOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<{ key: SortKey; dir: 1 | -1 } | null>(null);
  const [unverifiedOnly, setUnverifiedOnly] = useState(false);
  // What the hours answer to — the reconciliation block from the register's
  // own endpoint, so this screen and the Sequence Board read one truth.
  const [recon, setRecon] = useState<{
    source: string | null;
    items: number;
    mismatches: ReconciliationMismatch[];
    unmapped_budget_hours: number;
  } | null>(null);
  const [bookMsg, setBookMsg] = useState<string | null>(null);
  const [pendingBook, setPendingBook] = useState<{
    label: string;
    items: BudgetItem[];
    summary: string;
  } | null>(null);
  const [bookNonce, setBookNonce] = useState(0);
  // The register rows, kept so a reconciliation mismatch can open into the
  // schedule lines behind the register's side of the number.
  const [acts, setActs] = useState<Activity[]>([]);
  const [showRecon, setShowRecon] = useState(false);
  const [expandedCode, setExpandedCode] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    listWorkOrders(identity, vesselId, asOf)
      .then(setOrders)
      .catch((e: unknown) => {
        setOrders(null);
        setError(String(e));
      });
    listActivities(identity, vesselId, asOf)
      .then((r) => {
        setRecon(r.reconciliation);
        setActs(r.activities);
      })
      .catch(() => {
        setRecon(null);
        setActs([]);
      });
  }, [identity, vesselId, asOf, bookNonce]);

  const remaining = (w: WorkOrder) => Math.max(0, w.budget_hours - w.earned_hours);

  const rows = useMemo(() => {
    const filtered = unverifiedOnly ? (orders ?? []).filter((w) => !w.source_verified) : (orders ?? []);
    const sorted = [...filtered];
    // No sort chosen = the board's reason for existing: largest open
    // man-hours first — where the money is stuck.
    if (!sort) {
      sorted.sort((a, b) => remaining(b) - remaining(a));
      return sorted;
    }
    const key = (w: WorkOrder): number | string => {
      switch (sort.key) {
        case "remaining": return remaining(w);
        case "budget": return w.budget_hours;
        case "earned": return w.earned_hours;
        case "compartment": return w.compartment_no;
        case "trade": return w.trade;
        // Undated orders sort last rather than first. A null start is not an
        // early start, and putting them at the top of a schedule view would
        // read as "these are next".
        case "start": return w.planned?.start ?? Infinity;
        default: return w.code;
      }
    };
    sorted.sort((a, b) => {
      const ka = key(a);
      const kb = key(b);
      const cmp = typeof ka === "number" && typeof kb === "number"
        ? ka - kb
        : String(ka).localeCompare(String(kb));
      return cmp * sort.dir;
    });
    return sorted;
  }, [orders, sort, unverifiedOnly]);

  const totalRemaining = rows.reduce((a, w) => a + remaining(w), 0);
  const unverified = (orders ?? []).filter((w) => !w.source_verified).length;

  if (error) {
    return <p style={{ color: C.danger }}>This hull is out of scope for you ({error}).</p>;
  }
  if (!orders) return <Loading label="Reading the work orders…" />;

  const th: React.CSSProperties = {
    textAlign: "left",
    padding: "6px 10px",
    fontSize: 10,
    letterSpacing: 0.6,
    textTransform: "uppercase",
    color: C.dim,
    borderBottom: `1px solid ${C.line}`,
    whiteSpace: "nowrap",
  };
  const td: React.CSSProperties = {
    padding: "7px 10px",
    fontSize: 12.5,
    borderBottom: `1px solid ${C.hairline}`,
  };

  return (
    <div>
      <ModuleHeader
        kicker={`Work Orders · ${hullLabel}`}
        title="Work on this availability"
        stats={[
          { value: rows.length, label: "orders" },
          { value: mh(totalRemaining), label: "remaining" },
          { value: rows.filter((w) => w.in_window).length, label: "in window now" },
          unverified > 0 && {
            value: unverified, label: "unconfirmed provenance", tone: C.warn,
            title: "Ingested, not yet confirmed by a planner. Every row carries the document it came from.",
          },
          (recon?.mismatches.length ?? 0) > 0 && {
            value: recon?.mismatches.length ?? 0, label: "not reconciled", tone: C.warn,
            title: "The book and the register disagree on these items — the evidence panel below opens each one down to its schedule rows.",
          },
        ]}
        note={
          recon && (
            <>
              Hours answer to <b style={{ color: C.bright }}>{recon.source ?? "the seeded work items"}</b>{" "}
              ({recon.items} items). Every row carries the document it came from.
            </>
          )
        }
      />

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        {recon && (recon.mismatches.length > 0 || recon.unmapped_budget_hours > 0) && (
          <button
            onClick={() => setShowRecon((v) => !v)}
            aria-expanded={showRecon}
            title="Open the receipts: where the book and the register disagree, line by line, down to the schedule rows behind each number"
            style={{
              padding: "4px 10px", borderRadius: 6, cursor: "pointer", font: "inherit", fontSize: 11.5,
              background: showRecon ? C.raised : "transparent",
              color: recon.mismatches.length > 0 ? C.warn : C.dim,
              border: `1px solid ${showRecon ? C.accent : C.line}`,
            }}
          >
            {showRecon ? "▾" : "▸"} {recon.mismatches.length > 0
              ? `${recon.mismatches.length} not reconciled — show the evidence`
              : "reconciliation evidence"}
          </button>
        )}
        <label
          title="Only rows whose source document no planner has confirmed — the trust gap to close" style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: C.dim, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={unverifiedOnly}
            onChange={(e) => setUnverifiedOnly(e.target.checked)}
          />
          Unconfirmed provenance only
        </label>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {bookMsg && (
            <span style={{ fontSize: 11, color: msgColor(bookMsg) }}>
              {bookMsg}
            </span>
          )}
          <label
            style={{
              display: "inline-flex", alignItems: "center", gap: 5, padding: "4px 10px",
              borderRadius: 6, cursor: "pointer", font: "inherit", fontSize: 11.5,
              color: C.dim, border: `1px solid ${C.line}`,
            }}
            title="Ingest the yard's budget book (CSV: code,title,trade,budget_mh,earned_mh). From then on the register's hours answer to the book, not the seeded items. All-or-nothing; previews before storing."
          >
            ⭱ Budget CSV
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              style={{ display: "none" }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                setBookMsg(`⏳ reading ${file.name}…`);
                void file.text().then((text) => {
                  const items = parseBudgetCsv(text);
                  importBudgetBook(identity, vesselId, file.name, items, true)
                    .then((r) => {
                      const codes = r.reconciliation.mismatches.map((m) => m.code).join(", ");
                      setPendingBook({
                        label: file.name,
                        items,
                        summary:
                          `${r.items} items` +
                          (codes ? ` · register disagrees on: ${codes}` : " · register agrees with the book") +
                          (r.reconciliation.unmapped_budget_hours > 0
                            ? ` · ${r.reconciliation.unmapped_budget_hours} MH in the register map to no item`
                            : ""),
                      });
                      setBookMsg(null);
                    })
                    .catch((err: unknown) => setBookMsg(errText(err)));
                });
              }}
            />
          </label>
          {recon?.source && (
            <DiscardButton
              what="the budget book"
              title="Throw the ingested book away — hours answer to the seeded work items again."
              onDiscard={() => {
                setBookMsg("⏳ discarding the budget book…");
                void revertBudgetBook(identity, vesselId)
                  .then(() => {
                    setBookMsg("✓ back to the seeded budgets");
                    setBookNonce((n) => n + 1);
                  })
                  .catch((err: unknown) => setBookMsg(errText(err)));
              }}
            />
          )}
        </span>
      </div>

      {/* The book's dry run: what the register would answer to, and where the
          two disagree — before anything is stored. */}
      {pendingBook && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10, padding: "8px 12px", border: `1px solid #f59e0b66`, borderRadius: 8, background: "rgba(245,158,11,0.06)", fontSize: 12 }}>
          <b>{pendingBook.label}</b>
          <span style={{ color: C.dim }}>{pendingBook.summary}</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button
              style={commitBtnStyle}
              title="Store the book: from then on the register's hours answer to it. Reversible with Discard."
              onClick={() => {
                const staged = pendingBook;
                setPendingBook(null);
                if (!staged) return;
                setBookMsg(`⏳ ingesting ${staged.label}…`);
                void importBudgetBook(identity, vesselId, staged.label, staged.items, false)
                  .then((r) => {
                    setBookMsg(`✓ ${r.label}: hours now answer to ${r.items} book items`);
                    setBookNonce((n) => n + 1);
                  })
                  .catch((err: unknown) => setBookMsg(errText(err)));
              }}
            >
              Confirm book
            </button>
            <button
              title="Walk away — the preview cost nothing and nothing was stored."
              style={{
                padding: "4px 10px", borderRadius: 6, cursor: "pointer", font: "inherit",
                fontSize: 11.5, color: C.dim, background: "transparent", border: `1px solid ${C.line}`,
              }}
              onClick={() => setPendingBook(null)}
            >
              Cancel
            </button>
          </span>
        </div>
      )}

      {/* The receipts behind "not reconciled": each disagreement between the
          hours authority (the book) and the register, opening into the very
          schedule rows the register's number sums from — so the argument is
          settled by reading the evidence, not by trusting a tooltip. */}
      {showRecon && recon && (
        <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: "10px 12px", marginBottom: 10, fontSize: 12 }}>
          <div style={{ color: C.dim, marginBottom: 8 }}>
            Hours authority: <b style={{ color: C.bright }}>{recon.source ?? "the seeded work items"}</b> ·
            register: <b style={{ color: C.bright }}>{acts.filter((a) => !a.is_milestone).length} scheduled rows</b>.
            A mismatch means the two documents disagree about a work item's hours — a data finding to
            take back to whoever owns the wrong one, not something this tool will silently average.
          </div>
          {recon.mismatches.length === 0 && (
            <div style={{ color: C.ok }}>✓ every work item's register hours match the book</div>
          )}
          {recon.mismatches.map((m) => {
            const open = expandedCode === m.code;
            const lines = acts.filter((a) => a.work_order_code === m.code && !a.is_milestone);
            const dB = m.register_budget - m.item_budget;
            const dE = m.register_earned - m.item_earned;
            return (
              <div key={m.code} style={{ borderTop: `1px solid ${C.hairline}` }}>
                <button
                  onClick={() => setExpandedCode(open ? null : m.code)}
                  aria-expanded={open}
                  title="Open the register rows this number sums from"
                  style={{
                    display: "flex", gap: 10, alignItems: "baseline", width: "100%", textAlign: "left",
                    padding: "7px 2px", background: "transparent", border: "none", cursor: "pointer",
                    font: "inherit", fontSize: 12, color: C.text,
                  }}
                >
                  <span style={{ color: C.dim }}>{open ? "▾" : "▸"}</span>
                  <b style={{ fontFamily: "monospace", color: C.accent }}>{m.code}</b>
                  <span>book {m.item_budget.toLocaleString()} / {m.item_earned.toLocaleString()} MH</span>
                  <span style={{ color: C.dim }}>vs</span>
                  <span>register {m.register_budget.toLocaleString()} / {m.register_earned.toLocaleString()} MH</span>
                  <span style={{ marginLeft: "auto", color: C.warn, fontVariantNumeric: "tabular-nums" }}>
                    Δ {dB >= 0 ? "+" : ""}{dB.toLocaleString()} budget · {dE >= 0 ? "+" : ""}{dE.toLocaleString()} earned
                  </span>
                </button>
                {open && (
                  <div style={{ margin: "0 0 8px 22px" }}>
                    {lines.length === 0 ? (
                      <div style={{ color: C.warn }}>
                        The register carries no scheduled rows for {m.code} — its whole booked figure
                        comes from somewhere the register cannot show. That absence IS the evidence.
                      </div>
                    ) : (
                      <table style={{ borderCollapse: "collapse", fontSize: 11.5 }}>
                        <tbody>
                          {lines.map((a) => (
                            <tr key={a.activity_id}>
                              <td style={{ padding: "2px 10px 2px 0", fontFamily: "monospace", color: C.dim }}>{a.code}</td>
                              <td style={{ padding: "2px 10px 2px 0" }}>{a.name}</td>
                              <td style={{ padding: "2px 10px 2px 0", fontFamily: "monospace", color: C.subtle }}>{fmtWindow(a.planned)}</td>
                              <td style={{ padding: "2px 0", textAlign: "right", fontVariantNumeric: "tabular-nums" }}>
                                {a.earned_hours.toLocaleString()} / {a.budget_hours.toLocaleString()} MH
                              </td>
                            </tr>
                          ))}
                          <tr>
                            <td colSpan={3} style={{ padding: "4px 10px 2px 0", color: C.dim, borderTop: `1px solid ${C.hairline}` }}>
                              register total — the number in the mismatch above
                            </td>
                            <td style={{ padding: "4px 0 2px", textAlign: "right", fontWeight: 600, borderTop: `1px solid ${C.hairline}`, fontVariantNumeric: "tabular-nums" }}>
                              {lines.reduce((t, a) => t + a.earned_hours, 0).toLocaleString()} /{" "}
                              {lines.reduce((t, a) => t + a.budget_hours, 0).toLocaleString()} MH
                            </td>
                          </tr>
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            );
          })}
          {recon.unmapped_budget_hours > 0 && (
            <div style={{ borderTop: `1px solid ${C.hairline}`, paddingTop: 7, color: C.warn }}>
              {recon.unmapped_budget_hours.toLocaleString()} MH in the register map to no work item at
              all — scheduled work the hours authority does not know about.
            </div>
          )}
        </div>
      )}

      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 8 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 900 }}>
          <thead>
            <tr>
              {(
                [
                  ["WI", "code", false, "By work-item number"],
                  [null, null, false, null],
                  ["Trade", "trade", false, "By trade, so a shop's orders sit together"],
                  ["Compartment", "compartment", false, "By compartment, so a space's orders sit together"],
                  ["Budget", "budget", true, "Budgeted man-hours (MH)"],
                  ["Earned", "earned", true, "Man-hours of work completed so far (earned value)"],
                  ["Remaining", "remaining", true, "Budget minus earned — the default order, largest first"],
                  ["Planned", "start", false, "The planned window, and whether it covers the instant this list was read at"],
                  [null, null, false, null],
                  [null, null, false, null],
                ] as [string | null, SortKey | null, boolean, string | null][]
              ).map(([label, key, right, gloss], i) => {
                // Unsortable columns keep plain headers.
                if (key === null) {
                  const plain = ["", "Title", "", "", "", "", "", "", "Space", "Provenance"][i];
                  const t = i === 9
                    ? "Which source document this row came from, and whether a planner confirmed it"
                    : undefined;
                  return <th key={i} style={th} title={t}>{plain}</th>;
                }
                const active = sort?.key === key;
                const cycle = () =>
                  setSort(!active ? { key, dir: 1 } : sort?.dir === 1 ? { key, dir: -1 } : null);
                return (
                  <th
                    key={key}
                    tabIndex={0}
                    onClick={cycle}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        cycle();
                      }
                    }}
                    title={`${gloss ?? ""} — click to sort · third click restores largest-remaining-first`}
                    style={{
                      ...th,
                      textAlign: right ? "right" : "left",
                      cursor: "pointer",
                      color: active ? C.text : C.dim,
                      userSelect: "none",
                    }}
                  >
                    {label}
                    {active && (sort?.dir === 1 ? " ↑" : " ↓")}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.work_order_id} style={{ opacity: w.in_window ? 1 : 0.62 }}>
                <td style={{ ...td, fontFamily: "monospace" }}>
                  <button
                    onClick={() => onOpenJob(w.code)}
                    title="Open the job card — this order's plan, spaces, problems and fixes in one place"
                    style={{ font: "inherit", cursor: "pointer", color: C.accent, background: "transparent", border: "none", padding: 0, textDecoration: "underline", textUnderlineOffset: 2 }}
                  >
                    {w.code}
                  </button>
                </td>
                <td style={td}>
                  {w.title}
                  <div style={{ fontSize: 11, color: C.dim }}>{w.system}</div>
                </td>
                <td style={{ ...td, color: C.dim }}>{w.trade}</td>
                <td style={{ ...td, fontFamily: "monospace", fontSize: 11.5 }}>{w.compartment_no}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{w.budget_hours.toLocaleString()}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{w.earned_hours.toLocaleString()}</td>
                <td style={{ ...td, textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600 }}>
                  {remaining(w).toLocaleString()}
                </td>
                {/* The schedule, and whether this order is live at the instant on
                    the time control. Served as a flag rather than a filter: a
                    planner looking at next week still needs to see the order that
                    closed last week, so it is dimmed, not dropped. */}
                <td style={{ ...td, fontSize: 11, whiteSpace: "nowrap" }}>
                  <span style={{ fontFamily: "monospace", color: w.planned ? C.dim : C.warn }}>
                    {fmtWindow(w.planned)}
                  </span>
                  {w.planned && (
                    <span
                      title={
                        w.in_window
                          ? "Planned for the instant on the time control"
                          : "Not planned for this instant — before it, after it, or between phases"
                      }
                      style={{
                        marginLeft: 7,
                        padding: "1px 6px",
                        borderRadius: 4,
                        fontSize: 9.5,
                        fontWeight: 700,
                        color: w.in_window ? C.ok : C.dim,
                        background: w.in_window ? "rgba(34,197,94,0.12)" : "rgba(110,116,128,0.12)",
                        border: `1px solid ${w.in_window ? "rgba(34,197,94,0.4)" : "rgba(110,116,128,0.35)"}`,
                      }}
                    >
                      {w.in_window ? "IN WINDOW" : "OUT"}
                    </span>
                  )}
                </td>
                {/* Whether the space this work sits in is actually open, and who
                    can release it if not. The authorization comes from the engine
                    via the shell — nothing is decided here. */}
                <td style={{ ...td, fontSize: 11 }}>
                  {(() => {
                    const space = spaces.find((r) => r.compartment.compartment_no === w.compartment_no);
                    if (!space) {
                      return (
                        <span style={{ color: C.dim }} title="This order names a compartment the register does not contain">
                          not in register
                        </span>
                      );
                    }
                    const bucket = OVERLAY_STYLE[overlayBucket(space)];
                    return (
                      <button
                        onClick={() => onOpenSpace(w.compartment_no)}
                        title={`${bucket.gloss} — open it on the deck plan`}
                        style={{
                          display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer",
                          font: "inherit", fontSize: 10.5, padding: "2px 7px", borderRadius: 4,
                          background: bucket.bg, color: bucket.fg, border: `1px solid ${bucket.border}`,
                        }}
                      >
                        <b>{bucket.label}</b>
                        <span style={{ color: STATE_STYLE[space.state].fg }}>{space.state}</span>
                        {space.readiness === "held" && space.clearing_authority && (
                          <span style={{ color: C.dim }}>· {space.clearing_authority}</span>
                        )}
                      </button>
                    );
                  })()}
                </td>
                <td style={{ ...td, fontSize: 11 }}>
                  {/* The reference never wraps mid-id; the badge takes its own
                      line beneath. Provenance is stated, never assumed. */}
                  <div style={{ fontFamily: "monospace", whiteSpace: "nowrap" }}>{w.source_ref}</div>
                  <span
                    title={w.source_verified ? "Planner-confirmed" : "Ingested, not yet confirmed by a planner"}
                    style={{
                      display: "inline-block", marginTop: 3, padding: "1px 6px", borderRadius: 4,
                      fontSize: 9.5, fontWeight: 700,
                      color: w.source_verified ? C.ok : C.warn,
                      background: w.source_verified ? "rgba(34,197,94,0.12)" : "rgba(245,158,11,0.12)",
                      border: `1px solid ${w.source_verified ? "rgba(34,197,94,0.4)" : "rgba(245,158,11,0.45)"}`,
                    }}
                  >
                    {w.source_verified ? "CONFIRMED" : "UNCONFIRMED"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length === 0 && (
        <p style={{ color: C.dim, fontSize: 12.5 }}>
          No work orders match{unverifiedOnly ? " — every order's provenance is confirmed; clear the provenance filter to see them all" : ""}.
        </p>
      )}
    </div>
  );
}

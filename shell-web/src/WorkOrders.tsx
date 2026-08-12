import { useEffect, useMemo, useState } from "react";
import {
  importBudgetBook,
  listActivities,
  listWorkOrders,
  revertBudgetBook,
  type AsOf,
  type BudgetItem,
  type DeckStateRow,
  type Identity,
  type ReconciliationMismatch,
  type WorkOrder,
} from "./api";
import { Loading } from "./Loading";
import { ModuleHeader } from "./ModuleHeader";
import { C, mh, overlayBucket, OVERLAY_STYLE, STATE_STYLE } from "./theme";

type SortKey = "code" | "remaining" | "compartment" | "start";

/** A planned window, at day resolution — the resolution a schedule carries. */
const fmtWindow = (w: { start: number; end: number } | null): string => {
  if (!w) return "no dates";
  const d = (ms: number) => new Date(ms).toISOString().slice(5, 10).replace("-", "/");
  return `${d(w.start)} → ${d(w.end)}`;
};

export default function WorkOrders({
  identity,
  vesselId,
  hullLabel,
  spaces,
  onOpenSpace,
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
  /** The instant the list is read at; `null` is live. */
  asOf: AsOf;
}) {
  const [orders, setOrders] = useState<WorkOrder[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("remaining");
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

  useEffect(() => {
    setError(null);
    listWorkOrders(identity, vesselId, asOf)
      .then(setOrders)
      .catch((e: unknown) => {
        setOrders(null);
        setError(String(e));
      });
    listActivities(identity, vesselId, asOf)
      .then((r) => setRecon(r.reconciliation))
      .catch(() => setRecon(null));
  }, [identity, vesselId, asOf, bookNonce]);

  const remaining = (w: WorkOrder) => Math.max(0, w.budget_hours - w.earned_hours);

  const rows = useMemo(() => {
    const filtered = unverifiedOnly ? (orders ?? []).filter((w) => !w.source_verified) : (orders ?? []);
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sort === "remaining") return remaining(b) - remaining(a);
      if (sort === "compartment") return a.compartment_no.localeCompare(b.compartment_no);
      // Undated orders sort last rather than first. A null start is not an early
      // start, and putting them at the top of a schedule view would read as
      // "these are next".
      if (sort === "start") {
        return (a.planned?.start ?? Infinity) - (b.planned?.start ?? Infinity);
      }
      return a.code.localeCompare(b.code);
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
            title: (recon?.mismatches ?? [])
              .map((m) => `${m.code}: book ${m.item_budget}/${m.item_earned} MH vs register ${m.register_budget}/${m.register_earned} MH`)
              .join(" · "),
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
        <span style={{ fontSize: 11, color: C.dim }}>Sort</span>
        {(["remaining", "code", "compartment", "start"] as SortKey[]).map((k) => (
          <button
            key={k}
            onClick={() => setSort(k)}
            style={{
              padding: "4px 10px", borderRadius: 6, cursor: "pointer", font: "inherit", fontSize: 11.5,
              background: sort === k ? C.raised : "transparent",
              color: sort === k ? C.text : C.dim,
              border: `1px solid ${sort === k ? C.accent : C.line}`,
            }}
          >
            {k === "remaining"
              ? "MH remaining"
              : k === "code"
                ? "WI number"
                : k === "compartment"
                  ? "Compartment"
                  : "Planned start"}
          </button>
        ))}
        <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: C.dim, marginLeft: 6, cursor: "pointer" }}>
          <input
            type="checkbox"
            checked={unverifiedOnly}
            onChange={(e) => setUnverifiedOnly(e.target.checked)}
          />
          Unconfirmed provenance only
        </label>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8, alignItems: "center" }}>
          {bookMsg && (
            <span style={{ fontSize: 11, color: bookMsg.startsWith("✓") ? C.ok : C.danger }}>
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
                void file.text().then((text) => {
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
                    .catch((err: unknown) => setBookMsg(String(err)));
                });
              }}
            />
          </label>
          {recon?.source && (
            <button
              style={{
                padding: "4px 10px", borderRadius: 6, cursor: "pointer", font: "inherit",
                fontSize: 11.5, color: C.dim, background: "transparent", border: `1px solid ${C.line}`,
              }}
              title="Discard the book — hours answer to the seeded work items again."
              onClick={() => {
                void revertBudgetBook(identity, vesselId)
                  .then(() => {
                    setBookMsg("✓ back to the seeded budgets");
                    setBookNonce((n) => n + 1);
                  })
                  .catch((err: unknown) => setBookMsg(String(err)));
              }}
            >
              ⟲ Seeded budgets
            </button>
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
              style={{
                padding: "4px 10px", borderRadius: 6, cursor: "pointer", font: "inherit",
                fontSize: 11.5, color: C.text, background: C.raised, border: `1px solid ${C.accent}`,
              }}
              onClick={() => {
                const staged = pendingBook;
                setPendingBook(null);
                if (!staged) return;
                void importBudgetBook(identity, vesselId, staged.label, staged.items, false)
                  .then((r) => {
                    setBookMsg(`✓ ${r.label}: hours now answer to ${r.items} book items`);
                    setBookNonce((n) => n + 1);
                  })
                  .catch((err: unknown) => setBookMsg(String(err)));
              }}
            >
              Confirm book
            </button>
            <button
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

      <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 8 }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 900 }}>
          <thead>
            <tr>
              <th style={th}>WI</th>
              <th style={th}>Title</th>
              <th style={th}>Trade</th>
              <th style={th}>Compartment</th>
              <th style={{ ...th, textAlign: "right" }}>Budget</th>
              <th style={{ ...th, textAlign: "right" }}>Earned</th>
              <th style={{ ...th, textAlign: "right" }}>Remaining</th>
              <th style={th} title="The planned window, and whether it covers the instant this list was read at">
                Planned
              </th>
              <th style={th}>Space</th>
              <th style={th}>Provenance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.work_order_id} style={{ opacity: w.in_window ? 1 : 0.62 }}>
                <td style={{ ...td, fontFamily: "monospace", color: C.accent }}>{w.code}</td>
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
        <p style={{ color: C.dim, fontSize: 12.5 }}>No work orders match.</p>
      )}
    </div>
  );
}

import { useEffect, useMemo, useState } from "react";
import { listWorkOrders, type DeckStateRow, type Identity, type WorkOrder } from "./api";
import { C, mh, overlayBucket, OVERLAY_STYLE, STATE_STYLE } from "./theme";

type SortKey = "code" | "remaining" | "compartment";

export default function WorkOrders({
  identity,
  vesselId,
  hullLabel,
  spaces,
  onOpenSpace,
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
}) {
  const [orders, setOrders] = useState<WorkOrder[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<SortKey>("remaining");
  const [unverifiedOnly, setUnverifiedOnly] = useState(false);

  useEffect(() => {
    setError(null);
    listWorkOrders(identity, vesselId)
      .then(setOrders)
      .catch((e: unknown) => {
        setOrders([]);
        setError(String(e));
      });
  }, [identity, vesselId]);

  const remaining = (w: WorkOrder) => Math.max(0, w.budget_hours - w.earned_hours);

  const rows = useMemo(() => {
    const filtered = unverifiedOnly ? orders.filter((w) => !w.source_verified) : orders;
    const sorted = [...filtered];
    sorted.sort((a, b) => {
      if (sort === "remaining") return remaining(b) - remaining(a);
      if (sort === "compartment") return a.compartment_no.localeCompare(b.compartment_no);
      return a.code.localeCompare(b.code);
    });
    return sorted;
  }, [orders, sort, unverifiedOnly]);

  const totalRemaining = rows.reduce((a, w) => a + remaining(w), 0);
  const unverified = orders.filter((w) => !w.source_verified).length;

  if (error) {
    return <p style={{ color: C.danger }}>This hull is out of scope for you ({error}).</p>;
  }

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
    borderBottom: "1px solid #191a1f",
  };

  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: C.accent }}>
        Work Orders · {hullLabel}
      </div>
      <h1 style={{ fontSize: 22, margin: "4px 0 2px" }}>Work on this availability</h1>
      <p style={{ color: C.dim, fontSize: 12.5, margin: "0 0 12px", maxWidth: 720 }}>
        {rows.length} orders · {mh(totalRemaining)} remaining. Every row carries the document it
        came from; {unverified === 0 ? "all provenance is planner-confirmed" : `${unverified} still await planner confirmation`}.
      </p>

      <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10, flexWrap: "wrap" }}>
        <span style={{ fontSize: 11, color: C.dim }}>Sort</span>
        {(["remaining", "code", "compartment"] as SortKey[]).map((k) => (
          <button
            key={k}
            onClick={() => setSort(k)}
            style={{
              padding: "4px 10px", borderRadius: 6, cursor: "pointer", font: "inherit", fontSize: 11.5,
              background: sort === k ? "#20222b" : "transparent",
              color: sort === k ? C.text : C.dim,
              border: `1px solid ${sort === k ? C.accent : C.line}`,
            }}
          >
            {k === "remaining" ? "MH remaining" : k === "code" ? "WI number" : "Compartment"}
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
      </div>

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
              <th style={th}>Space</th>
              <th style={th}>Provenance</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((w) => (
              <tr key={w.work_order_id}>
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
                  <span style={{ fontFamily: "monospace" }}>{w.source_ref}</span>
                  {/* Provenance is stated, never assumed: an unconfirmed row says so. */}
                  <span
                    title={w.source_verified ? "Planner-confirmed" : "Ingested, not yet confirmed by a planner"}
                    style={{
                      marginLeft: 7, padding: "1px 6px", borderRadius: 4, fontSize: 9.5, fontWeight: 700,
                      color: w.source_verified ? "#22c55e" : "#f59e0b",
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

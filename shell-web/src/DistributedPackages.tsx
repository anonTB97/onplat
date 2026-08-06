import { useEffect, useState } from "react";
import {
  getPackage,
  listPackages,
  type Identity,
  type PackageDetail,
  type PackageSummary,
} from "./api";
import { C, fmtClear, mh, STATE_STYLE } from "./theme";

export default function DistributedPackages({
  identity,
  vesselId,
  hullLabel,
}: {
  identity: Identity;
  vesselId: string;
  hullLabel: string;
}) {
  const [packages, setPackages] = useState<PackageSummary[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PackageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setDetail(null);
    listPackages(identity, vesselId)
      .then((p) => {
        setPackages(p);
        setSelected(p[0]?.code ?? null);
      })
      .catch((e: unknown) => {
        setPackages([]);
        setSelected(null);
        setError(String(e));
      });
  }, [identity, vesselId]);

  useEffect(() => {
    if (!selected) return;
    getPackage(identity, vesselId, selected)
      .then(setDetail)
      .catch(() => setDetail(null));
  }, [identity, vesselId, selected]);

  if (error) {
    return <p style={{ color: C.danger }}>This hull is out of scope for you ({error}).</p>;
  }
  if (packages.length === 0) {
    return (
      <>
        <div style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: C.accent }}>
          Distributed Packages · {hullLabel}
        </div>
        <h1 style={{ fontSize: 22, margin: "4px 0 8px" }}>No distributed packages</h1>
        <p style={{ color: C.dim, fontSize: 12.5 }}>
          This hull has no work order spanning multiple compartments in the register.
        </p>
      </>
    );
  }

  const g = detail?.governing ?? null;
  const govStyle =
    g && g.constraint.kind === "authorization" ? STATE_STYLE[g.constraint.state] : null;

  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: C.accent }}>
        Distributed Packages · {hullLabel}
      </div>
      <h1 style={{ fontSize: 22, margin: "4px 0 2px" }}>One work order, many compartments</h1>
      <p style={{ color: C.dim, fontSize: 12.5, margin: "0 0 12px", maxWidth: 760 }}>
        Authorization state is a <b>distribution over the footprint</b>, not a value. A segment
        cannot be {detail?.package.test_verb ?? "tested"} until it <i>and everything upstream of
        it</i> is complete — so one held compartment strands man-hours it does not contain.
      </p>

      {/* package tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {packages.map((p) => (
          <button
            key={p.code}
            onClick={() => setSelected(p.code)}
            style={{
              padding: "6px 11px", borderRadius: 6, cursor: "pointer", font: "inherit", fontSize: 12,
              textAlign: "left",
              background: p.code === selected ? "#20222b" : "transparent",
              color: p.code === selected ? C.text : C.dim,
              border: `1px solid ${p.code === selected ? C.accent : C.line}`,
            }}
          >
            <span style={{ fontFamily: "monospace", marginRight: 7 }}>{p.code}</span>
            {p.name}
            <span style={{ color: C.dim, marginLeft: 7 }}>
              {p.compartment_count} comps · {p.segment_count} segs
            </span>
          </button>
        ))}
      </div>

      {detail && (
        <>
          {/* the headline: stranded man-hours */}
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
            {[
              ["Stranded", mh(detail.package.total_stranded_hours), C.danger],
              ["Remaining", mh(detail.package.budget_hours - detail.package.earned_hours), C.text],
              [
                "Compartments open",
                `${detail.package.open_compartment_count} of ${detail.package.compartment_count}`,
                C.text,
              ],
              [
                `Segments ready to be ${detail.package.test_verb}`,
                `${detail.package.testable_segment_count} of ${detail.package.segment_count}`,
                detail.package.testable_segment_count === 0 ? C.danger : C.text,
              ],
            ].map(([label, value, colour]) => (
              <div key={label} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: "9px 13px", background: C.panel, minWidth: 150 }}>
                <div style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: "uppercase", color: C.dim }}>{label}</div>
                <div style={{ fontSize: 19, fontWeight: 700, color: colour, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>{value}</div>
              </div>
            ))}
          </div>

          {/* governing constraint — the one thing to act on */}
          {g && (
            <div
              style={{
                border: `1px solid ${govStyle?.border ?? C.line}`,
                background: govStyle?.bg ?? C.panel,
                borderRadius: 8, padding: 13, marginBottom: 16,
              }}
            >
              <div style={{ display: "flex", gap: 9, alignItems: "center", flexWrap: "wrap" }}>
                <span style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: "uppercase", color: C.dim }}>
                  Governing constraint
                </span>
                <span style={{ fontFamily: "monospace", fontWeight: 600 }}>{g.compartment}</span>
                {/* The two kinds are labelled differently on purpose: one needs a
                    named person, the other needs crew. */}
                {g.constraint.kind === "authorization" ? (
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: govStyle?.fg, letterSpacing: 0.4 }}>
                    {g.constraint.state} · {g.constraint.rules.join(", ")} · AUTHORIZATION HOLD
                  </span>
                ) : (
                  <span style={{ fontSize: 10.5, fontWeight: 700, color: "#94a3b8", letterSpacing: 0.4 }}>
                    COMPLETION CONSTRAINT — nothing refuses this work
                  </span>
                )}
              </div>
              <p style={{ fontSize: 13, margin: "7px 0 0" }}>{g.consequence}</p>
              <div style={{ fontSize: 11.5, color: C.dim, marginTop: 5 }}>
                {g.constraint.kind === "authorization" ? (
                  <>
                    Cleared by <b style={{ color: "#ccd1da" }}>{g.constraint.clearing_authority}</b> ·
                    earliest {fmtClear(g.constraint.earliest_clear)}. Adding crew will not move this.
                  </>
                ) : (
                  <>
                    No earliest-clear: there is nothing to clear. {mh(g.own_remaining)} of work left
                    here — this one responds to crew.
                  </>
                )}
              </div>
            </div>
          )}

          <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
            {/* segment topology */}
            <div style={{ flex: "1 1 420px", minWidth: 340 }}>
              <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: C.dim, marginBottom: 7 }}>
                Segments
              </div>
              {detail.segments.map((s) => (
                <div key={s.code} style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: 10, marginBottom: 7, background: C.panel }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <span style={{ fontFamily: "monospace", fontWeight: 700 }}>{s.code}</span>
                    <span style={{ fontSize: 11, color: C.dim }}>{s.kind}</span>
                    <span
                      style={{
                        marginLeft: "auto", fontSize: 9.5, fontWeight: 700, letterSpacing: 0.4,
                        padding: "1px 6px", borderRadius: 4,
                        color: s.testable ? "#22c55e" : "#f59e0b",
                        background: s.testable ? "rgba(34,197,94,0.12)" : "rgba(245,158,11,0.12)",
                        border: `1px solid ${s.testable ? "rgba(34,197,94,0.4)" : "rgba(245,158,11,0.45)"}`,
                      }}
                    >
                      {s.testable
                        ? `READY TO BE ${detail.package.test_verb.toUpperCase()}`
                        : s.complete
                          ? "COMPLETE — HELD UPSTREAM"
                          : "INSTALL INCOMPLETE"}
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, marginTop: 3 }}>{s.name}</div>
                  <div style={{ fontSize: 11, color: C.dim, marginTop: 3, fontVariantNumeric: "tabular-nums" }}>
                    {s.earned.toLocaleString()} / {s.budget.toLocaleString()} MH
                    {s.held_by.length > 0 && (
                      /* The distinction that matters: finished work that still
                         cannot be tested, and exactly what is holding it. */
                      <>
                        {" · "}
                        <span style={{ color: "#f59e0b" }}>
                          cannot be {detail.package.test_verb} — {s.held_by.join(" and ")} upstream
                          {s.held_by.length === 1 ? " is" : " are"} not complete
                        </span>
                      </>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* footprint: authorization as a distribution */}
            <div style={{ flex: "1 1 360px", minWidth: 320 }}>
              <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: C.dim, marginBottom: 7 }}>
                Footprint · authorization distribution
              </div>
              {detail.footprint.map((f) => {
                const st = STATE_STYLE[f.state];
                return (
                  <div
                    key={f.compartment_no}
                    style={{
                      display: "flex", gap: 9, alignItems: "center", padding: "7px 10px",
                      borderRadius: 6, marginBottom: 5,
                      background: f.state === "ALLOW" ? C.panel : st.bg,
                      border: `1px solid ${f.state === "ALLOW" ? C.line : st.border}`,
                    }}
                  >
                    <span style={{ fontFamily: "monospace", fontSize: 11.5, minWidth: 92 }}>{f.compartment_no}</span>
                    <span style={{ color: st.fg, fontSize: 9.5, fontWeight: 700, minWidth: 58 }}>{f.state}</span>
                    <span style={{ fontSize: 11, color: C.dim, minWidth: 42 }}>{f.rules_fired.join(",") || "—"}</span>
                    <span style={{ marginLeft: "auto", fontSize: 11.5, fontVariantNumeric: "tabular-nums", color: f.complete ? "#22c55e" : C.text }}>
                      {f.complete ? "complete" : `${f.remaining_hours.toLocaleString()} MH left`}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {detail.faults.length > 0 && (
            <p style={{ color: C.danger, fontSize: 12.5, marginTop: 12 }}>
              Topology faults in the source data: {JSON.stringify(detail.faults)}
            </p>
          )}
        </>
      )}
    </div>
  );
}

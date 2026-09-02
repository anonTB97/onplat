// Reports — the dated cuts a person takes to a meeting.
//
// Every other screen is a live view that changes when the clock moves and
// needs the tool to be read. This one produces sheets: pick a report, scope
// it (a shift, a zone, a space), and the table on screen is exactly what
// prints and exports. The builders live in `reports.ts` and are pure; this
// file only fetches the register and the hazards at the instant and hands
// them over, so the sheet is a function of served facts and nothing else.

import { useEffect, useMemo, useState } from "react";
import {
  compartmentState,
  listActivities,
  listHazards,
  type Activity,
  type AsOf,
  type DeckStateRow,
  type Decision,
  type Identity,
  type Issue,
  type LiveHazard,
} from "./api";
import { fmtDayTime } from "./clock";
import { Loading } from "./Loading";
import { ModuleHeader } from "./ModuleHeader";
import {
  CATALOGUE,
  compartmentCard,
  conflictLog,
  fieldConditions,
  reportFilename,
  shiftSheet,
  toCsv,
  toPrintHtml,
  zoneSheet,
  type Report,
  type ReportId,
  type Shift,
} from "./reports";
import { chipStyle, C, commitBtnStyle, tdStyle, thStyle } from "./theme";

const DAY = 86_400_000;

const SHIFTS: { id: Shift; label: string }[] = [
  { id: "instant", label: "This instant" },
  { id: "days", label: "Days 0700–1530" },
  { id: "swing", label: "Swing 1530–2400" },
  { id: "night", label: "Night 0000–0700" },
];

function download(lines: string[], filename: string): void {
  const blob = new Blob([lines.join("\n")], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function print(report: Report): void {
  const w = window.open("", "_blank", "width=900,height=1000");
  if (!w) return;
  w.document.write(toPrintHtml(report));
  w.document.close();
  w.focus();
  w.print();
}

export default function Reports({
  identity,
  vesselId,
  hullLabel,
  asOf,
  spaces,
  issues,
  verdictsOk,
  role,
  onOpenSpace,
}: {
  identity: Identity;
  vesselId: string;
  hullLabel: string;
  asOf: AsOf;
  spaces: DeckStateRow[];
  issues: Issue[];
  verdictsOk: boolean | null;
  /** The role producing the sheet — the person, once identity lands. */
  role: string;
  onOpenSpace: (compartment: string) => void;
}) {
  const [which, setWhich] = useState<ReportId>("shift");
  const [shift, setShift] = useState<Shift>("days");
  const [zone, setZone] = useState<string | null>(null);
  const [space, setSpace] = useState<string | null>(null);
  const [register, setRegister] = useState<{ activities: Activity[]; asOf: number; source: string | null } | null>(null);
  const [hazards, setHazards] = useState<LiveHazard[] | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stale = false;
    setError(null);
    Promise.all([listActivities(identity, vesselId, asOf), listHazards(identity, vesselId, asOf)])
      .then(([r, h]) => {
        if (stale) return;
        setRegister({ activities: r.activities, asOf: r.as_of, source: r.schedule_source });
        setHazards(h);
      })
      .catch((e: unknown) => {
        if (stale) return;
        setRegister(null);
        setHazards(null);
        setError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, asOf]);

  // The compartment card needs the space's trace, which no other read carries.
  useEffect(() => {
    if (which !== "compartment" || !space) {
      setDecision(null);
      return undefined;
    }
    let stale = false;
    compartmentState(identity, vesselId, space, asOf)
      .then((s) => {
        if (!stale) setDecision(s.decision);
      })
      .catch(() => {
        if (!stale) setDecision(null);
      });
    return () => {
      stale = true;
    };
  }, [which, space, identity, vesselId, asOf]);

  const zones = useMemo(
    () => [...new Set(spaces.map((s) => s.compartment.zone))].sort(),
    [spaces],
  );
  // Default the zone sheet to the worst zone — the one a zone manager is
  // most likely to be asked about — and the card to the worst space.
  const worstZone = useMemo(() => {
    const held = new Map<string, number>();
    for (const s of spaces) if (s.readiness === "held") held.set(s.compartment.zone, (held.get(s.compartment.zone) ?? 0) + s.remaining_hours);
    return [...held.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? zones[0] ?? null;
  }, [spaces, zones]);
  const worstSpace = useMemo(
    () => [...spaces].sort((a, b) => Number(b.readiness === "held") - Number(a.readiness === "held") || b.remaining_hours - a.remaining_hours)[0]?.compartment.compartment_no ?? null,
    [spaces],
  );

  const report: Report | null = useMemo(() => {
    if (!register || !hazards) return null;
    const cut = { hull: hullLabel, asOfMs: register.asOf, scheduleSource: register.source, producedBy: role };
    switch (which) {
      case "shift":
        return shiftSheet({ cut, activities: register.activities, spaces, shift, zone });
      case "zone": {
        const z = zone ?? worstZone;
        return z ? zoneSheet({ cut, zone: z, activities: register.activities, spaces, hazards, windowMs: DAY }) : null;
      }
      case "compartment": {
        const no = space ?? worstSpace;
        return no
          ? compartmentCard({ cut, space: no, row: spaces.find((s) => s.compartment.compartment_no === no) ?? null, decision, activities: register.activities, hazards })
          : null;
      }
      case "conflicts":
        return conflictLog({ cut, issues, spaces, zone });
      case "conditions":
        return fieldConditions({ cut, hazards, spaces });
    }
  }, [register, hazards, hullLabel, role, which, spaces, shift, zone, worstZone, space, worstSpace, decision, issues]);

  const entry = CATALOGUE.find((c) => c.id === which);

  return (
    <div>
      <ModuleHeader
        kicker={`Reports · ${hullLabel}`}
        title="Dated cuts to print, export, and take to the meeting"
        stats={[
          { value: CATALOGUE.length, label: "reports" },
          register && { value: register.activities.length, label: "activities in the register" },
          hazards && { value: hazards.length, label: "open field conditions" },
          { value: issues.length, label: "open issues" },
        ]}
        note="A report is what the screens know at one instant, cut to a shift, a zone or a space, and stamped with when and from what. The table you see is the table that prints."
      />

      {verdictsOk === false && (
        <div role="alert" style={{ margin: "0 0 12px", padding: "8px 12px", borderRadius: 6, border: "1px solid rgba(245,158,11,0.55)", background: "rgba(245,158,11,0.12)", color: C.warn, fontSize: 12.5 }}>
          <b>Verdicts unavailable.</b> The engine did not answer for this instant; do not print a sheet from this screen until it does.
        </div>
      )}

      {/* The catalogue: pick a report by the question it answers. */}
      <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fit, minmax(210px, 1fr))", marginBottom: 12 }}>
        {CATALOGUE.map((c) => (
          <button
            key={c.id}
            onClick={() => setWhich(c.id)}
            aria-pressed={which === c.id}
            style={{
              textAlign: "left", font: "inherit", cursor: "pointer", padding: "9px 11px", borderRadius: 7,
              background: which === c.id ? C.raised : C.panel, color: C.text,
              border: `1px solid ${which === c.id ? C.accent : C.line}`,
            }}
          >
            <div style={{ fontSize: 12.5, fontWeight: 700 }}>{c.name}</div>
            <div style={{ fontSize: 10.5, color: C.dim, marginTop: 2 }}>{c.audience}</div>
            <div style={{ fontSize: 11, color: C.bright, marginTop: 4 }}>{c.question}</div>
          </button>
        ))}
      </div>

      {/* Scope controls: only the ones this report takes. */}
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        {which === "shift" && (
          <>
            <span style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: C.dim }}>Shift</span>
            {SHIFTS.map((s) => (
              <button key={s.id} style={chipStyle(shift === s.id)} onClick={() => setShift(s.id)}>{s.label}</button>
            ))}
          </>
        )}
        {(which === "shift" || which === "zone" || which === "conflicts") && (
          <>
            <span style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: C.dim, marginLeft: which === "shift" ? 10 : 0 }}>Zone</span>
            {which !== "zone" && (
              <button style={chipStyle(zone === null)} onClick={() => setZone(null)}>All</button>
            )}
            {zones.map((z) => (
              <button key={z} style={chipStyle((zone ?? (which === "zone" ? worstZone : null)) === z)} onClick={() => setZone(z)}>{z}</button>
            ))}
          </>
        )}
        {which === "compartment" && (
          <>
            <span style={{ fontSize: 9.5, letterSpacing: 0.6, textTransform: "uppercase", color: C.dim }}>Space</span>
            <select
              value={space ?? worstSpace ?? ""}
              onChange={(e) => setSpace(e.target.value)}
              style={{ font: "inherit", fontSize: 12, fontFamily: "monospace", background: C.panel, color: C.text, border: `1px solid ${C.line}`, borderRadius: 5, padding: "3px 6px" }}
            >
              {[...spaces]
                .sort((a, b) => a.compartment.compartment_no.localeCompare(b.compartment.compartment_no))
                .map((s) => (
                  <option key={s.compartment.compartment_no} value={s.compartment.compartment_no}>
                    {s.compartment.compartment_no} · {s.compartment.name}
                  </option>
                ))}
            </select>
            {(space ?? worstSpace) && (
              <button style={chipStyle(false)} onClick={() => onOpenSpace((space ?? worstSpace) as string)} title="Open this space on the deck plan">
                On the plate →
              </button>
            )}
          </>
        )}
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            disabled={!report}
            onClick={() => report && download(toCsv(report), reportFilename(report, "csv"))}
            style={{ ...chipStyle(false), opacity: report ? 1 : 0.5 }}
            title="The same table as CSV, with the cut in its first rows"
          >
            ↓ CSV
          </button>
          <button
            disabled={!report}
            onClick={() => report && print(report)}
            style={{ ...commitBtnStyle, opacity: report ? 1 : 0.5 }}
            title="A monochrome one-pager for the clipboard wall — the warnings survive a photocopier"
          >
            ⎙ Print sheet
          </button>
        </span>
      </div>

      {error && <p style={{ color: C.danger }}>Register unavailable ({error}).</p>}
      {!error && !report && <Loading label="Cutting the sheet…" />}

      {report && (
        <article style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: C.panel, overflow: "hidden" }}>
          {/* The cut: the sheet's title block. */}
          <header style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 12, padding: "12px 14px", borderBottom: `1px solid ${C.line}` }}>
            <div>
              <div style={{ fontSize: 17, fontWeight: 700 }}>
                {report.name} <span style={{ color: C.dim, fontWeight: 400 }}>— {report.scope}</span>
              </div>
              <div style={{ fontSize: 12, color: C.bright, marginTop: 2 }}>{entry?.question ?? report.question}</div>
            </div>
            <div style={{ fontFamily: "monospace", fontSize: 10.5, color: C.dim, textAlign: "right", lineHeight: 1.5, whiteSpace: "nowrap" }}>
              {report.cut.hull}<br />
              cut {fmtDayTime(report.cut.asOfMs)}<br />
              schedule: {report.cut.scheduleSource ?? "generated demo register"}<br />
              by {report.cut.producedBy}
            </div>
          </header>

          {report.sections.map((s) => (
            <section key={s.heading} style={{ padding: "10px 14px 4px" }}>
              <h2 style={{ fontSize: 13, margin: "0 0 2px", display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
                {s.heading}
                {s.note && <span style={{ fontSize: 10.5, color: C.dim, fontWeight: 400 }}>{s.note}</span>}
              </h2>
              <div style={{ overflowX: "auto" }}>
                <table style={{ borderCollapse: "collapse", width: "100%" }}>
                  <thead>
                    <tr>
                      {s.columns.map((c, i) => (
                        <th key={c} style={{ ...thStyle, textAlign: s.numeric?.includes(i) ? "right" : "left" }}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {s.rows.map((row, ri) => (
                      <tr key={ri}>
                        {row.map((cell, ci) => (
                          <td
                            key={ci}
                            style={{
                              ...tdStyle,
                              textAlign: s.numeric?.includes(ci) ? "right" : "left",
                              fontVariantNumeric: "tabular-nums",
                              color: /^(HELD|REFUSED|NOT EXECUTABLE|NO ENTRY|SECURED)/.test(cell) ? C.dangerSoft : /UNLOCATED|not located/.test(cell) ? C.warn : undefined,
                              fontFamily: ci === 0 && /^\d-\d+-\d+-[A-Z]{1,2}$|^A\d+$|^\d+$/.test(cell) ? "monospace" : undefined,
                            }}
                          >
                            {cell}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          ))}

          <footer style={{ padding: "8px 14px 12px", fontSize: 10.5, color: C.dim, lineHeight: 1.5, borderTop: `1px solid ${C.hairline}` }}>
            {report.notes.map((n) => (
              <div key={n}>{n}</div>
            ))}
          </footer>
        </article>
      )}
    </div>
  );
}

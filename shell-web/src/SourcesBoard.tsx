// The Sources panel — every document this hull's screens are built from, in
// one place, each saying what it is, how much of it landed, and how much of
// what landed is authored versus guessed.
//
// Provenance already exists per surface: the register names its schedule
// source, the zone shading names its chart, every derived location wears its
// mark. What was missing is the answer to "what is this hull actually running
// on?" as one screen — the question an auditor, a new planner, or anyone
// deciding whether to trust a number asks first. Each card reads the same
// endpoints its home screen reads, so this panel can never disagree with the
// screens it summarises.
//
// Reverts live here as well as on their home screens: taking a document back
// out is a provenance decision, and this is the provenance screen.

import { useEffect, useState } from "react";
import {
  getZoneChart,
  listActivities,
  revertSchedule,
  revertZoneChart,
  type ActivityRegister,
  type AsOf,
  type Identity,
  type ZoneChart,
} from "./api";
import { SHEET_SOURCE, SHEET_SOURCE_URL } from "./deckSheets";
import { Loading } from "./Loading";
import { C, mh } from "./theme";

export default function SourcesBoard({
  identity,
  vesselId,
  hullLabel,
  asOf,
  onOpenModule,
}: {
  identity: Identity;
  vesselId: string;
  hullLabel: string;
  asOf: AsOf;
  /** Routes to the module where a document's import door lives. */
  onOpenModule: (moduleId: string) => void;
}) {
  const [register, setRegister] = useState<ActivityRegister | null>(null);
  const [zones, setZones] = useState<ZoneChart | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  useEffect(() => {
    setError(null);
    Promise.all([listActivities(identity, vesselId, asOf), getZoneChart(identity, vesselId)])
      .then(([r, z]) => {
        setRegister(r);
        setZones(z);
      })
      .catch((e: unknown) => {
        setRegister(null);
        setZones(null);
        setError(String(e));
      });
  }, [identity, vesselId, asOf, nonce]);

  if (error) return <p style={{ color: C.danger }}>Sources unavailable ({error}).</p>;
  if (!register || !zones) return <Loading label="Reading what this hull is built from…" />;

  const m = register.mapping;
  const mismatches = register.reconciliation.mismatches;
  const oob = zones.audit.out_of_bounds;

  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: C.accent }}>
        Data Sources · {hullLabel}
      </div>
      <h1 style={{ fontSize: 22, margin: "4px 0 2px" }}>What this hull is built from</h1>
      <p style={{ color: C.dim, fontSize: 12.5, margin: "0 0 14px", maxWidth: 800 }}>
        Every document behind the screens, with how much of it landed and how much
        of what landed is authored versus guessed. Each card reads the same
        endpoint its home screen reads, so this panel cannot disagree with the
        screens it summarises. Imports happen on the document&apos;s home screen;
        taking one back out happens there or here.
      </p>

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill,minmax(400px,1fr))", alignItems: "start" }}>
        <SourceCard
          kind="Schedule of record"
          status={register.schedule_source ? { label: "INGESTED", tone: "#3D6BFF" } : { label: "GENERATED", tone: "#94a3b8" }}
          name={register.schedule_source ?? "built from the seeded work orders and packages"}
          lines={[
            {
              text: `${register.activities.length} activities · ${register.edges.length} edges · ${m.milestones} key events`,
            },
            {
              text:
                `location: ${m.located_authored} of ${m.work_activities} authored` +
                (m.located_derived.length > 0 ? ` · ${m.located_derived.length} read from task names` : "") +
                (m.unlocated.length > 0
                  ? ` · ${m.unlocated.length} unlocated${
                      m.unlocated.some((u) => u.zone_hint)
                        ? ` (${m.unlocated.filter((u) => u.zone_hint).length} with a WBS zone hint)`
                        : ""
                    }`
                  : ""),
              tone: m.unlocated.length > 0 ? C.danger : m.located_derived.length > 0 ? "#f59e0b" : "#22c55e",
              gloss:
                m.located_derived.length > 0
                  ? `Read from task names: ${m.located_derived.map((d) => `${d.activity} → ${d.compartment}`).join(", ")} — graded guesses, marked ≈ wherever they appear.`
                  : "Every located row is authored by the schedule.",
            },
            ...(m.unknown_spaces.length > 0
              ? [{
                  text: `located to spaces this register does not carry: ${m.unknown_spaces.map((u) => u.compartment).join(", ")}`,
                  tone: C.danger,
                }]
              : []),
            {
              text: mismatches.length > 0
                ? `hours do not reconcile: ${mismatches.map((x) => x.code).join(", ")}`
                : "hours reconcile with the work items",
              tone: mismatches.length > 0 ? "#f59e0b" : "#22c55e",
              gloss: register.schedule_source
                ? "For an ingested schedule this is a report, not a property — the honest account of what the export covers."
                : "True by construction for the generated register; a test pins it.",
            },
            ...(register.reconciliation.unmapped_budget_hours > 0
              ? [{ text: `${mh(register.reconciliation.unmapped_budget_hours)} mapped to no work item`, tone: C.dim }]
              : []),
          ]}
          importHint="Import a P6 XER export on the Sequence Board"
          onOpenHome={() => onOpenModule("sequenceBoard")}
          onRevert={
            register.schedule_source
              ? () =>
                  void revertSchedule(identity, vesselId)
                    .then(() => {
                      setMsg("✓ back to the generated register");
                      setNonce((n) => n + 1);
                    })
                    .catch((e: unknown) => setMsg(String(e)))
              : undefined
          }
        />

        <SourceCard
          kind="Zone chart"
          status={zones.source ? { label: "AUTHORED", tone: "#3D6BFF" } : { label: "INFERRED", tone: "#94a3b8" }}
          name={zones.source ?? "bands inferred from the register's own spaces"}
          lines={[
            {
              text: zones.source
                ? `${zones.bounds.length} zones bounded`
                : "no chart ingested — every band is this tool's inference, and says so",
            },
            ...(zones.source
              ? [
                  {
                    text: oob.length > 0
                      ? `register disagrees: ${oob.map((o) => `${o.compartment} (Fr ${o.frame} vs ${o.zone} ${o.lo_frame}–${o.hi_frame})`).join(" · ")}`
                      : "register agrees with the chart",
                    tone: oob.length > 0 ? C.danger : "#22c55e",
                    gloss: "One of the two documents is wrong; the tool's job is to say so, not to pick.",
                  },
                  ...(zones.audit.unbounded_zones.length > 0
                    ? [{ text: `chart does not bound ${zones.audit.unbounded_zones.join(", ")}`, tone: "#f59e0b" }]
                    : []),
                ]
              : []),
          ]}
          importHint="Import a chart from Deck Explorer → Zones & compartments"
          onOpenHome={() => onOpenModule("deckExplorer")}
          onRevert={
            zones.source
              ? () =>
                  void revertZoneChart(identity, vesselId)
                    .then(() => {
                      setMsg("✓ back to inferred bands");
                      setNonce((n) => n + 1);
                    })
                    .catch((e: unknown) => setMsg(String(e)))
              : undefined
          }
        />

        <SourceCard
          kind="Deck plates"
          status={{ label: "REFERENCE", tone: "#94a3b8" }}
          name={SHEET_SOURCE}
          lines={[
            {
              text: "the drawing layer under every plate view — real sheets, notional pins",
              gloss:
                "The plates are a public document; the compartment register is pinned to them as notional demo data. Customer-uploaded sheets replace these without changing the screens.",
            },
            { text: SHEET_SOURCE_URL, tone: C.dim },
          ]}
        />
      </div>

      {msg && (
        <p style={{ fontSize: 11.5, marginTop: 10, color: msg.startsWith("✓") ? "#22c55e" : C.danger }}>{msg}</p>
      )}
    </div>
  );
}

/** One document's card: what it is, what landed, and the way out. */
function SourceCard({
  kind,
  status,
  name,
  lines,
  importHint,
  onOpenHome,
  onRevert,
}: {
  kind: string;
  status: { label: string; tone: string };
  name: string;
  lines: { text: string; tone?: string; gloss?: string }[];
  importHint?: string;
  onOpenHome?: () => void;
  onRevert?: () => void;
}) {
  return (
    <section style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: C.panel }}>
      <header style={{ display: "flex", gap: 8, alignItems: "center", padding: "9px 12px", borderBottom: `1px solid ${C.line}` }}>
        <b style={{ fontSize: 12.5 }}>{kind}</b>
        <span
          style={{
            fontSize: 9, fontWeight: 700, letterSpacing: 0.6, padding: "2px 7px", borderRadius: 4,
            color: status.tone, border: `1px solid ${status.tone}55`, background: `${status.tone}14`,
          }}
        >
          {status.label}
        </span>
        {onRevert && (
          <button
            onClick={onRevert}
            title="Discard this document — the screens return to what the tool can honestly serve without it."
            style={{
              marginLeft: "auto", font: "inherit", fontSize: 10.5, cursor: "pointer",
              padding: "2px 8px", borderRadius: 5, color: C.dim, background: "transparent",
              border: `1px solid ${C.line}`,
            }}
          >
            ⟲ Revert
          </button>
        )}
      </header>
      <div style={{ padding: "9px 12px", display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ fontSize: 12, color: "#ccd1da", fontFamily: "monospace", wordBreak: "break-all" }}>{name}</div>
        {lines.map((l) => (
          <div key={l.text} style={{ fontSize: 11.5, color: l.tone ?? C.dim }} title={l.gloss}>
            {l.text}
          </div>
        ))}
        {importHint && onOpenHome && (
          <button
            onClick={onOpenHome}
            style={{
              alignSelf: "flex-start", marginTop: 3, font: "inherit", fontSize: 10.5, cursor: "pointer",
              padding: "2px 8px", borderRadius: 5, color: C.accent, background: "transparent",
              border: `1px solid ${C.accent}55`,
            }}
          >
            {importHint} →
          </button>
        )}
      </div>
    </section>
  );
}

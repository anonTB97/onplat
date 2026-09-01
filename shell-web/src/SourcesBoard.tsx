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
  importBudgetBook,
  importSchedule,
  importZoneChart,
  listActivities,
  previewSchedule,
  revertBudgetBook,
  revertSchedule,
  revertZoneChart,
  type ActivityRegister,
  type AsOf,
  type Identity,
  type ZoneChart,
  getGeometry,
  getManningBook,
  importGeometry,
  importManningBook,
  revertGeometry,
  revertManningBook,
  type GeometryInfo,
  type ManningBook,
} from "./api";
import { DiscardButton } from "./DiscardButton";
import { SHEET_SOURCE, SHEET_SOURCE_URL } from "./deckSheets";
import { fmtBytes, parseBudgetCsv, parseGeometryCsv, parseManningCsv, parseZoneCsv, deltaSummary } from "./ingest";
import { Loading } from "./Loading";
import { ModuleHeader } from "./ModuleHeader";
import { commitBtnStyle, C, errText, mh, msgColor } from "./theme";

/** A staged document: previewed by the server, nothing stored, Confirm or walk away. */
interface Staged {
  kind: string;
  label: string;
  sizeBytes: number;
  summary: string;
  commit: () => Promise<string>;
}

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
  const [staged, setStaged] = useState<Staged | null>(null);
  const [manning, setManning] = useState<ManningBook | null>(null);
  const [geometry, setGeometry] = useState<GeometryInfo | null>(null);
  /** What the door is doing right now — a P6 export is megabytes, and reading
   *  or ingesting one deserves a visible verb rather than a frozen screen. */
  const [busy, setBusy] = useState<string | null>(null);

  // The three doors. Each stages a server-side dry run: everything the import
  // would say, nothing it would do. Confirm commits; Cancel costs nothing.
  const stageSchedule = (file: File) => {
    setMsg(null);
    setBusy(`reading ${file.name} (${fmtBytes(file.size)})…`);
    file
      .text()
      .then((xer) =>
        previewSchedule(identity, vesselId, file.name, xer).then((p) => {
        setBusy(null);
        const m = p.mapping;
        setStaged({
          kind: "Schedule of record",
          label: file.name,
          sizeBytes: file.size,
          summary:
            `${p.activities} activities · ${p.edges} edges · ${m.milestones} key events — ` +
            `Confirm replaces the current register (${register?.activities.length ?? "?"} activities) on every screen · ` +
            `location: ${m.located_authored} authored` +
            (m.located_derived.length > 0 ? ` / ${m.located_derived.length} from task names` : "") +
            (m.unlocated.length > 0 ? ` / ${m.unlocated.length} unlocated` : "") +
            (p.reconciliation.mismatches.length > 0
              ? ` · hours disagree on ${p.reconciliation.mismatches.map((x) => x.code).join(", ")}`
              : " · hours reconcile") +
            ` — ${deltaSummary(p.delta)}`,
          commit: () =>
            importSchedule(identity, vesselId, file.name, xer).then(
              (r) => `✓ ${r.label}: ${r.activities} activities, ${r.edges} edges`,
            ),
        });
        }),
      )
      .catch((e: unknown) => {
        setBusy(null);
        setMsg(String(e));
      });
  };

  const stageZones = (file: File) => {
    setMsg(null);
    setBusy(`reading ${file.name}…`);
    file
      .text()
      .then((text) => {
        const bounds = parseZoneCsv(text);
        return importZoneChart(identity, vesselId, file.name, bounds, true).then((r) => {
          setBusy(null);
          const oob = r.audit.out_of_bounds;
          setStaged({
            kind: "Zone chart",
            label: file.name,
            sizeBytes: file.size,
            summary:
              `${r.zones} zones bounded` +
              (oob.length > 0
                ? ` · would put ${oob.length} space${oob.length === 1 ? "" : "s"} out of bounds: ${oob.map((o) => o.compartment).join(", ")}`
                : " · register agrees with the chart") +
              (r.audit.unbounded_zones.length > 0
                ? ` · does not bound ${r.audit.unbounded_zones.join(", ")}`
                : ""),
            commit: () =>
              importZoneChart(identity, vesselId, file.name, bounds, false).then(
                (x) => `✓ ${x.label}: ${x.zones} zones authored`,
              ),
          });
        });
      })
      .catch((e: unknown) => {
        setBusy(null);
        setMsg(String(e));
      });
  };

  const stageBudgets = (file: File) => {
    setMsg(null);
    setBusy(`reading ${file.name}…`);
    file
      .text()
      .then((text) => {
        const items = parseBudgetCsv(text);
        return importBudgetBook(identity, vesselId, file.name, items, true).then((r) => {
          setBusy(null);
          const codes = r.reconciliation.mismatches.map((x) => x.code).join(", ");
          setStaged({
            kind: "Budget book",
            label: file.name,
            sizeBytes: file.size,
            summary:
              `${r.items} items` +
              (codes ? ` · register disagrees on: ${codes}` : " · register agrees with the book") +
              (r.reconciliation.unmapped_budget_hours > 0
                ? ` · ${mh(r.reconciliation.unmapped_budget_hours)} in the register map to no item`
                : ""),
            commit: () =>
              importBudgetBook(identity, vesselId, file.name, items, false).then(
                (x) => `✓ ${x.label}: hours now answer to the book (${x.items} items)`,
              ),
          });
        });
      })
      .catch((e: unknown) => {
        setBusy(null);
        setMsg(String(e));
      });
  };

  const stageManning = (file: File) => {
    setMsg(null);
    setBusy(`reading ${file.name}…`);
    file
      .text()
      .then((text) => {
        const crews = parseManningCsv(text);
        return importManningBook(identity, vesselId, file.name, crews, true).then((r) => {
          setBusy(null);
          const unmatched = r.coverage.book_trades_matching_no_register_trade;
          const uncovered = r.coverage.register_trades_with_no_manning_line;
          setStaged({
            kind: "Manning book",
            label: file.name,
            sizeBytes: file.size,
            summary:
              `${r.crews} trades` +
              (unmatched.length > 0
                ? ` · ⚠ match no register trade: ${unmatched.join(", ")}`
                : "") +
              (uncovered.length > 0
                ? ` · no manning line for: ${uncovered.join(", ")}`
                : " · every register trade covered"),
            commit: () =>
              importManningBook(identity, vesselId, file.name, crews, false).then(
                (x) => `✓ ${x.label}: crew supply loaded (${x.crews} trades)`,
              ),
          });
        });
      })
      .catch((e: unknown) => {
        setBusy(null);
        setMsg(String(e));
      });
  };

  const stageGeometry = (file: File) => {
    setMsg(null);
    setBusy(`reading ${file.name}…`);
    file
      .text()
      .then((text) => {
        const { spaces, decks } = parseGeometryCsv(text);
        return importGeometry(identity, vesselId, file.name, spaces, decks, true).then((r) => {
          setBusy(null);
          const f = r.findings;
          setStaged({
            kind: "Geometry register",
            label: file.name,
            sizeBytes: file.size,
            summary:
              `${r.spaces} spaces surveyed · ${r.deck_bands} deck bands` +
              (f.placard_disagreements.length > 0
                ? ` · ⚠ ${f.placard_disagreements.length} disagree with their placard`
                : "") +
              (f.outside_deck_coverage.length > 0
                ? ` · ⚠ ${f.outside_deck_coverage.length} outside deck coverage`
                : "") +
              (f.unknown_spaces.count > 0
                ? ` · ${f.unknown_spaces.count} name no register space`
                : ""),
            commit: () =>
              importGeometry(identity, vesselId, file.name, spaces, decks, false).then(
                (x) => `✓ ${x.label}: ${x.spaces} spaces now surveyed, ${x.deck_bands} deck bands delineated`,
              ),
          });
        });
      })
      .catch((e: unknown) => {
        setBusy(null);
        setMsg(String(e));
      });
  };

  const confirmStaged = () => {
    const p = staged;
    if (!p) return;
    setStaged(null);
    setBusy(`ingesting ${p.label} (${fmtBytes(p.sizeBytes)})…`);
    p.commit()
      .then((done) => {
        setBusy(null);
        setMsg(done);
        setNonce((n) => n + 1);
      })
      .catch((e: unknown) => {
        setBusy(null);
        setMsg(String(e));
      });
  };

  useEffect(() => {
    setError(null);
    // Guarded against reordering under a playing time control.
    let stale = false;
    Promise.all([
      listActivities(identity, vesselId, asOf),
      getZoneChart(identity, vesselId),
      getManningBook(identity, vesselId).catch(() => null),
      getGeometry(identity, vesselId).catch(() => null),
    ])
      .then(([r, z, m, g]) => {
        if (stale) return;
        setRegister(r);
        setZones(z);
        setManning(m);
        setGeometry(g);
      })
      .catch((e: unknown) => {
        if (stale) return;
        setRegister(null);
        setZones(null);
        setError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, asOf, nonce]);

  // A hull switch invalidates the staging area: a document previewed against
  // hull A must never be one click from committing into hull B — the staged
  // commit closure captures its stage-time vessel.
  useEffect(() => {
    setStaged(null);
    setBusy(null);
    setMsg(null);
  }, [vesselId]);

  // A file dropped just OUTSIDE a card must not navigate the tab to the file
  // (taking every screen's state with it). The window swallows strays; the
  // cards' own handlers still receive their drops first.
  useEffect(() => {
    const swallow = (e: DragEvent) => e.preventDefault();
    window.addEventListener("dragover", swallow);
    window.addEventListener("drop", swallow);
    return () => {
      window.removeEventListener("dragover", swallow);
      window.removeEventListener("drop", swallow);
    };
  }, []);

  if (error) return <p style={{ color: C.danger }}>Sources unavailable ({error}).</p>;
  if (!register || !zones) return <Loading label="Reading what this hull is built from…" />;

  const m = register.mapping;
  const mismatches = register.reconciliation.mismatches;
  const oob = zones.audit.out_of_bounds;

  return (
    <div>
      <ModuleHeader
        kicker={`Data Sources · ${hullLabel}`}
        title="What this hull is built from"
        stats={[
          { value: register.schedule_source ? "ingested" : "generated", label: "schedule of record" },
          { value: zones.source ? "authored" : "inferred", label: "zone chart" },
          { value: register.reconciliation.source ? "ingested" : "seeded", label: "budget book" },
        ]}
        note="Every document behind the screens, with how much of it landed and how much of what landed is authored versus guessed. Each card is also that document's door: pick a file or drop it on the card — the server previews everything the import would claim before anything is stored."
      />

      {busy && (
        <p style={{ fontSize: 11.5, margin: "0 0 10px", color: C.warn }}>⏳ {busy}</p>
      )}
      {staged && (
        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 10, padding: "9px 12px", border: "1px solid #f59e0b66", borderRadius: 8, background: "rgba(245,158,11,0.06)" }}>
          <b style={{ fontSize: 12.5 }}>{staged.label}</b>
          <span style={{ fontSize: 10.5, color: C.dim }}>
            {staged.kind} · {fmtBytes(staged.sizeBytes)}
          </span>
          <span style={{ fontSize: 11.5, color: C.bright }}>{staged.summary}</span>
          <span style={{ fontSize: 10.5, color: C.dim }}>— previewed, nothing stored</span>
          <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button
              onClick={confirmStaged}
              title="Store the document. Reversible: every card has a Discard that brings the previous state back."
              style={commitBtnStyle}
            >
              Confirm import
            </button>
            <button
              onClick={() => setStaged(null)}
              title="Walk away — the preview cost nothing and nothing was stored."
              style={{
                font: "inherit", fontSize: 11.5, cursor: "pointer", padding: "3px 10px",
                borderRadius: 6, color: C.dim, background: "transparent", border: `1px solid ${C.line}`,
              }}
            >
              Cancel
            </button>
          </span>
        </div>
      )}

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
              tone: m.unlocated.length > 0 ? C.danger : m.located_derived.length > 0 ? C.warn : C.ok,
              gloss:
                m.located_derived.length > 0
                  ? `Read from task names: ${m.located_derived.slice(0, 8).map((d) => `${d.activity} → ${d.compartment}`).join(", ")}${m.located_derived.length > 8 ? ` … +${m.located_derived.length - 8} more` : ""} — graded guesses, marked ≈ wherever they appear.`
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
              tone: mismatches.length > 0 ? C.warn : C.ok,
              gloss: register.schedule_source
                ? "For an ingested schedule this is a report, not a property — the honest account of what the export covers."
                : "True by construction for the generated register; a test pins it.",
            },
            ...(register.reconciliation.unmapped_budget_hours > 0
              ? [{ text: `${mh(register.reconciliation.unmapped_budget_hours)} mapped to no work item`, tone: C.dim }]
              : []),
          ]}
          upload={{
            label: "⭱ Upload P6 XER",
            accept: ".xer,text/plain",
            title:
              "Ingest a Primavera P6 XER export as this hull's schedule of record — full multi-year exports included; the door takes files in the hundreds of megabytes. All-or-nothing: one rejected line refuses the file, with every reason listed.",
            onFile: stageSchedule,
          }}
          importHint="Also on the Sequence Board"
          onOpenHome={() => onOpenModule("sequenceBoard")}
          onRevert={
            register.schedule_source
              ? () => {
                  setMsg("⏳ discarding the ingested schedule…");
                  void revertSchedule(identity, vesselId)
                    .then(() => {
                      setMsg("✓ back to the generated register");
                      setNonce((n) => n + 1);
                    })
                    .catch((e: unknown) => setMsg(errText(e)));
                }
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
                    tone: oob.length > 0 ? C.danger : C.ok,
                    gloss: "One of the two documents is wrong; the tool's job is to say so, not to pick.",
                  },
                  ...(zones.audit.unbounded_zones.length > 0
                    ? [{ text: `chart does not bound ${zones.audit.unbounded_zones.join(", ")}`, tone: C.warn }]
                    : []),
                ]
              : []),
          ]}
          upload={{
            label: "⭱ Upload zone CSV",
            accept: ".csv,text/csv,text/plain",
            title:
              "Ingest the yard's zone chart (CSV: zone,lo_frame,hi_frame). All-or-nothing; the audit is previewed before anything is stored.",
            onFile: stageZones,
          }}
          importHint="Also on Deck Explorer"
          onOpenHome={() => onOpenModule("deckExplorer")}
          onRevert={
            zones.source
              ? () => {
                  setMsg("⏳ discarding the zone chart…");
                  void revertZoneChart(identity, vesselId)
                    .then(() => {
                      setMsg("✓ back to inferred bands");
                      setNonce((n) => n + 1);
                    })
                    .catch((e: unknown) => setMsg(errText(e)));
                }
              : undefined
          }
        />

        <SourceCard
          kind="Budget book"
          status={register.reconciliation.source ? { label: "INGESTED", tone: "#3D6BFF" } : { label: "SEEDED", tone: "#94a3b8" }}
          name={register.reconciliation.source ?? "the seeded work items' own budgets"}
          lines={[
            {
              text: `${register.reconciliation.items} work items — what the register's hours answer to`,
              gloss:
                "The book is the hours authority, not a work-order register: the operational work orders stay what they are; the book replaces what the hours are held accountable to.",
            },
            {
              text: mismatches.length > 0
                ? `register disagrees on: ${mismatches.map((x) => x.code).join(", ")}`
                : "register agrees",
              tone: mismatches.length > 0 ? C.warn : C.ok,
            },
          ]}
          upload={{
            label: "⭱ Upload budget CSV",
            accept: ".csv,text/csv,text/plain",
            title:
              "Ingest the yard's budget book (CSV: code,title,trade,budget_mh,earned_mh). From then on the register's hours answer to the book. All-or-nothing; previews before storing.",
            onFile: stageBudgets,
          }}
          importHint="Also on Work Orders"
          onOpenHome={() => onOpenModule("workOrders")}
          onRevert={
            register.reconciliation.source
              ? () => {
                  setMsg("⏳ discarding the budget book…");
                  void revertBudgetBook(identity, vesselId)
                    .then(() => {
                      setMsg("✓ back to the seeded budgets");
                      setNonce((n) => n + 1);
                    })
                    .catch((e: unknown) => setMsg(errText(e)));
                }
              : undefined
          }
        />

        <SourceCard
          kind="Manning book"
          status={manning ? { label: "INGESTED", tone: "#3D6BFF" } : { label: "NOT LOADED", tone: "#94a3b8" }}
          name={manning?.label ?? "no manning book — boards show demand only"}
          lines={[
            {
              text: manning
                ? `${manning.crews.length} trades · ${manning.crews.reduce((n, c) => n + c.headcount, 0)} people per half-shift`
                : "Demand is computed from the register; supply is a yard's claim and only enters here.",
              gloss:
                "The supply side of crew planning: people per trade, per half-shift. The Deck Explorer's Manning lens compares the schedule's demand against this book.",
            },
            ...(manning
              ? [{ text: manning.crews.map((c) => `${c.trade} ${c.headcount}`).join(" · "), tone: C.dim }]
              : []),
          ]}
          upload={{
            label: "⭱ Upload manning CSV",
            accept: ".csv,text/csv,text/plain",
            title:
              "Ingest the yard's manning book (CSV: trade,headcount — people per half-shift). The preview names any trade that matches nothing in the register. All-or-nothing; previews before storing.",
            onFile: stageManning,
          }}
          importHint="Read by the Deck Explorer's Manning lens"
          onOpenHome={() => onOpenModule("deckExplorer")}
          onRevert={
            manning
              ? () => {
                  setMsg("⏳ discarding the manning book…");
                  void revertManningBook(identity, vesselId)
                    .then(() => {
                      setMsg("✓ back to demand only");
                      setNonce((n) => n + 1);
                    })
                    .catch((e: unknown) => setMsg(errText(e)));
                }
              : undefined
          }
        />

        <SourceCard
          kind="Geometry register"
          status={geometry?.register ? { label: "INGESTED", tone: "#3D6BFF" } : { label: "NOT LOADED", tone: "#94a3b8" }}
          name={geometry?.register?.label ?? "no geometry register — positions are placard parses"}
          lines={[
            {
              text: geometry?.register
                ? `${geometry.findings?.surveyed ?? geometry.register.spaces} spaces surveyed of ${geometry.findings?.register_total ?? "?"} · ${geometry.register.decks.length} deck bands delineated`
                : "The plan draws the forward-boundary frame parsed from each placard number, labelled as a parse. True extents and deck delineation are a drawing's claim and enter here.",
              gloss:
                "Surveyed frame extents per space and the frame bands where each deck physically exists — docs/geometry-accuracy.md. Disagreements with the register are served as findings, not hidden.",
            },
            ...(geometry?.findings
              ? [
                  {
                    text:
                      (geometry.findings.placard_disagreements.length > 0
                        ? `⚠ placard disagrees: ${geometry.findings.placard_disagreements.map((x) => x.compartment_no).join(", ")}`
                        : "every surveyed space agrees with its placard") +
                      (geometry.findings.outside_deck_coverage.length > 0
                        ? ` · ⚠ outside deck coverage: ${geometry.findings.outside_deck_coverage.map((x) => x.compartment_no).join(", ")}`
                        : ""),
                    tone:
                      geometry.findings.placard_disagreements.length > 0 ||
                      geometry.findings.outside_deck_coverage.length > 0
                        ? C.warn
                        : C.ok,
                  },
                ]
              : []),
          ]}
          upload={{
            label: "⭱ Upload geometry CSV",
            accept: ".csv,text/csv,text/plain",
            title:
              "Ingest the geometry register (CSV lines: space,<no>,<fwd_frame>,<aft_frame> and deck,<code>,<lo>,<hi>). The preview names every disagreement with the register before Confirm. All-or-nothing.",
            onFile: stageGeometry,
          }}
          importHint="Drawn on the Deck Explorer's plates"
          onOpenHome={() => onOpenModule("deckExplorer")}
          onRevert={
            geometry?.register
              ? () => {
                  setMsg("⏳ discarding the geometry register…");
                  void revertGeometry(identity, vesselId)
                    .then(() => {
                      setMsg("✓ back to placard parses");
                      setNonce((n) => n + 1);
                    })
                    .catch((e: unknown) => setMsg(errText(e)));
                }
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
        <p style={{ fontSize: 11.5, marginTop: 10, color: msgColor(msg) }}>{msg}</p>
      )}
    </div>
  );
}

/** One document's card: what it is, what landed, the door in, and the way out. */
function SourceCard({
  kind,
  status,
  name,
  lines,
  upload,
  importHint,
  onOpenHome,
  onRevert,
}: {
  kind: string;
  status: { label: string; tone: string };
  name: string;
  lines: { text: string; tone?: string; gloss?: string }[];
  /** The document's own door: a picker, and the whole card as a drop target. */
  upload?: { label: string; accept: string; title: string; onFile: (f: File) => void };
  importHint?: string;
  onOpenHome?: () => void;
  onRevert?: () => void;
}) {
  const [dragOver, setDragOver] = useState(false);
  return (
    <section
      onDragOver={
        upload
          ? (e) => {
              e.preventDefault();
              setDragOver(true);
            }
          : undefined
      }
      onDragLeave={upload ? () => setDragOver(false) : undefined}
      onDrop={
        upload
          ? (e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files[0];
              if (f) upload.onFile(f);
            }
          : undefined
      }
      style={{
        border: `1px ${dragOver ? "dashed" : "solid"} ${dragOver ? C.accent : C.line}`,
        borderRadius: 8,
        background: dragOver ? "rgba(61,107,255,0.05)" : C.panel,
      }}
    >
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
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          {upload && (
            <label
              title={upload.title}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5, font: "inherit",
                fontSize: 10.5, cursor: "pointer", padding: "2px 8px", borderRadius: 5,
                color: C.accent, border: `1px solid ${C.accent}55`, background: "transparent",
              }}
            >
              {upload.label}
              <input
                type="file"
                accept={upload.accept}
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) upload.onFile(f);
                }}
              />
            </label>
          )}
          {onRevert && (
            <DiscardButton
              what="this document"
              title="Throw this document away — the screens return to what the tool can honestly serve without it."
              onDiscard={onRevert}
            />
          )}
        </span>
      </header>
      <div style={{ padding: "9px 12px", display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ fontSize: 12, color: C.bright, fontFamily: "monospace", wordBreak: "break-all" }}>{name}</div>
        {lines.map((l) => (
          <div key={l.text} style={{ fontSize: 11.5, color: l.tone ?? C.dim }} title={l.gloss}>
            {l.text}
          </div>
        ))}
        {upload && (
          <div style={{ fontSize: 10, color: C.faint }}>…or drop the file anywhere on this card</div>
        )}
        {importHint && onOpenHome && (
          <button
            onClick={onOpenHome}
            title="Open this document's home screen — the same door lives there beside the data it feeds."
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

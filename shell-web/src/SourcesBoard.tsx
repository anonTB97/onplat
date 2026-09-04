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

import { useEffect, useState, type ReactNode } from "react";
import {
  getCouplings,
  getRegister,
  importCouplings,
  importHazardLog,
  importRegister,
  listHazards,
  revertCouplings,
  revertRegister,
  type CouplingsInfo,
  type LiveHazard,
  type RegisterInfo,
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
  getYardClock,
  importYardClock,
  revertYardClock,
  type ClockDoorFinding,
} from "./api";
import { fmtStamp, type YardClockInfo } from "./clock";
import { DiscardButton } from "./DiscardButton";
import { SHEET_SOURCE, SHEET_SOURCE_URL } from "./deckSheets";
import {
  fmtBytes,
  parseBudgetCsv,
  parseCouplingCsv,
  parseGeometryCsv,
  parseHazardLogCsv,
  parseManningCsv,
  parseRegisterCsv,
  parseZoneCsv,
  deltaSummary,
} from "./ingest";
import { Loading } from "./Loading";
import { ModuleHeader } from "./ModuleHeader";
import { commitBtnStyle, C, errText, mh, msgColor } from "./theme";
import {
  crossCheckInstants,
  intlCrossCheck,
  offsetLabel,
  parseClockCsv,
  shiftChip,
  transitionLabel,
} from "./yardClock";

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
  onMutated,
  onOpenModule,
}: {
  identity: Identity;
  vesselId: string;
  hullLabel: string;
  asOf: AsOf;
  /** Called after any commit or revert here changed the hull's served facts,
   *  so the app re-reads what every other screen is built on — the
   *  timeframe's clock above all. */
  onMutated: () => void;
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
  const [shipRegister, setShipRegister] = useState<RegisterInfo | null>(null);
  const [couplings, setCouplings] = useState<CouplingsInfo | null>(null);
  const [hazards, setHazards] = useState<LiveHazard[]>([]);
  /** The hull's clock in effect, as the door serves it: the document or the
   *  honest UTC default. Null only while the read is failing. */
  const [yardClock, setYardClockInfo] = useState<(YardClockInfo & { now_local: string; offset_now: string }) | null>(null);
  /** Whether the coupling door should propose deck penetrations from deck
   *  order and frame overlap. On by default: a register without vertical
   *  paths lets heat go nowhere, which is a lie the trace would then tell. */
  const [deriveVertical, setDeriveVertical] = useState(true);
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

  const stageRegister = (file: File) => {
    setMsg(null);
    setBusy(`reading ${file.name}…`);
    file
      .text()
      .then((text) => {
        const { decks, spaces } = parseRegisterCsv(text);
        return importRegister(identity, vesselId, file.name, decks, spaces, true).then((r) => {
          setBusy(null);
          const f = r.findings;
          const orphans = f.orphaned_hazards;
          setStaged({
            kind: "Compartment register",
            label: file.name,
            sizeBytes: file.size,
            summary:
              `${r.decks} decks · ${r.spaces} spaces — Confirm replaces the served register ` +
              `(${shipRegister?.spaces_served ?? "?"} spaces) on every screen` +
              (f.unplaceable.length > 0
                ? ` · ⚠ ${f.unplaceable.length} cannot be placed (no frame, placard unparsable): ${f.unplaceable.slice(0, 6).join(", ")}${f.unplaceable.length > 6 ? ", …" : ""}`
                : "") +
              (f.empty_decks.length > 0 ? ` · ${f.empty_decks.length} deck${f.empty_decks.length === 1 ? "" : "s"} with nothing on ${f.empty_decks.length === 1 ? "it" : "them"}: ${f.empty_decks.join(", ")}` : "") +
              (orphans.length > 0
                ? ` · ⚠ ${orphans.length} live field condition${orphans.length === 1 ? "" : "s"} lose${orphans.length === 1 ? "s" : ""} ${orphans.length === 1 ? "its" : "their"} space: ${orphans.slice(0, 4).map((o) => o.compartment).join(", ")}${orphans.length > 4 ? ", …" : ""}`
                : "") +
              (f.activities_losing_their_space > 0
                ? ` · ⚠ ${f.activities_losing_their_space} scheduled activit${f.activities_losing_their_space === 1 ? "y" : "ies"} located to spaces it does not carry`
                : " · every located activity keeps its space"),
            commit: () =>
              importRegister(identity, vesselId, file.name, decks, spaces, false).then(
                (x) => `✓ ${x.label}: this hull is now ${x.spaces} spaces on ${x.decks} decks`,
              ),
          });
        });
      })
      .catch((e: unknown) => {
        setBusy(null);
        setMsg(String(e));
      });
  };

  const stageCouplings = (file: File) => {
    setMsg(null);
    setBusy(`reading ${file.name}…`);
    file
      .text()
      .then((text) => {
        const edges = parseCouplingCsv(text);
        return importCouplings(identity, vesselId, file.name, edges, deriveVertical, true).then((r) => {
          setBusy(null);
          const sample = r.derived_edges.slice(0, 4).map((e) => `${e.from} ↓ ${e.to}`).join(", ");
          setStaged({
            kind: "Coupling register",
            label: file.name,
            sizeBytes: file.size,
            summary:
              `${r.authored} authored edge${r.authored === 1 ? "" : "s"}` +
              (deriveVertical
                ? ` · ${r.derived} deck penetration${r.derived === 1 ? "" : "s"} derived from deck order and frame overlap${sample ? ` (${sample}${r.derived > 4 ? ", …" : ""})` : ""}`
                : " · nothing derived") +
              ` — Confirm replaces the ${couplings?.edges_served ?? "?"} edges every trace walks today`,
            commit: () =>
              importCouplings(identity, vesselId, file.name, edges, deriveVertical, false).then(
                (x) => `✓ ${x.label}: traces now walk ${x.edges} edges (${x.authored} authored, ${x.derived} derived)`,
              ),
          });
        });
      })
      .catch((e: unknown) => {
        setBusy(null);
        setMsg(String(e));
      });
  };

  const stageHazardLog = (file: File) => {
    setMsg(null);
    setBusy(`reading ${file.name}…`);
    file
      .text()
      .then((text) => {
        const rows = parseHazardLogCsv(text);
        return importHazardLog(identity, vesselId, file.name, rows, true).then((r) => {
          setBusy(null);
          const raise = r.would_raise ?? [];
          setStaged({
            kind: "Field-condition log",
            label: file.name,
            sizeBytes: file.size,
            summary:
              `${r.rows} rows · would raise ${raise.length}` +
              (raise.length > 0
                ? ` (${raise.slice(0, 5).map((x) => `${x.compartment} ${x.kind}`).join(", ")}${raise.length > 5 ? ", …" : ""})`
                : "") +
              ` · ${r.already_live.length} already live and left alone` +
              " — each raise lands in the ledger by name; nothing is cleared by a log",
            commit: () =>
              importHazardLog(identity, vesselId, file.name, rows, false).then(
                (x) => `✓ ${x.label}: ${x.raised?.length ?? 0} raised, ${x.already_live.length} already live`,
              ),
          });
        });
      })
      .catch((e: unknown) => {
        setBusy(null);
        setMsg(String(e));
      });
  };

  // The yard clock's door. The CSV is parsed here (the same form the boot
  // loader reads), the server previews it — refused whole with every reason,
  // or findings: shifts that leave the day open, a schedule of record parsed
  // in another clock — and the browser's own tz database is asked whether it
  // agrees with the authored rule at now, half a year on, and an hour either
  // side of each transition. A disagreement is a finding on the card before
  // anything is stored: a mis-authored rule is wrong by an hour for half the
  // year, and this is where it is caught.
  const stageClock = (file: File) => {
    setMsg(null);
    setBusy(`reading ${file.name}…`);
    file
      .text()
      .then((text) => {
        const clock = parseClockCsv(text);
        return importYardClock(identity, vesselId, file.name, clock, true).then((r) => {
          setBusy(null);
          const findings: ClockDoorFinding[] = [
            ...r.findings,
            ...intlCrossCheck(clock, crossCheckInstants(clock, Date.now())),
          ];
          const transitions = r.preview.transitions.map((t) => `${t.local} (${t.to})`).join(", ");
          setStaged({
            kind: "Yard clock",
            label: file.name,
            sizeBytes: file.size,
            summary:
              `${clock.zone} · now ${r.preview.now_local} (${r.preview.offset_now})` +
              (transitions ? ` · this year the clock moves ${transitions}` : " · the clock never moves") +
              ` · ${clock.shifts.map(shiftChip).join(" · ")}` +
              (findings.length > 0 ? ` · ⚠ ${findings.map((f) => f.text).join(" · ")}` : " · the browser's tz database agrees with the rule") +
              " — Confirm puts every clock on every screen in this zone",
            commit: () =>
              importYardClock(identity, vesselId, file.name, clock, false).then(
                (x) => `✓ ${x.label}: every time on screen now reads in ${clock.zone} — ${clock.shifts.length} shifts, watch ${clock.watch_minutes / 60} h`,
              ),
          });
        });
      })
      .catch((e: unknown) => {
        setBusy(null);
        setMsg(errText(e));
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
        onMutated();
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
      getRegister(identity, vesselId).catch(() => null),
      getCouplings(identity, vesselId).catch(() => null),
      listHazards(identity, vesselId, asOf).catch(() => []),
      getYardClock(identity, vesselId).catch(() => null),
    ])
      .then(([r, z, m, g, sr, cp, hz, yc]) => {
        if (stale) return;
        setRegister(r);
        setZones(z);
        setManning(m);
        setGeometry(g);
        setShipRegister(sr);
        setCouplings(cp);
        setHazards(hz);
        setYardClockInfo(yc);
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
          { value: shipRegister?.served ?? "seeded", label: "compartment register" },
          { value: register.schedule_source ? "ingested" : "generated", label: "schedule of record" },
          { value: zones.source ? "authored" : "inferred", label: "zone chart" },
          { value: register.reconciliation.source ? "ingested" : "seeded", label: "budget book" },
          { value: yardClock?.source === "document" ? yardClock.clock.zone : "UTC", label: "yard clock", title: yardClock?.source === "document" ? `Every clock on screen is ${yardClock.clock.zone}'s wall clock, from ${yardClock.label}.` : "No yard clock loaded — every time on screen is a UTC instant marked Z." },
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
          kind="Compartment register"
          status={shipRegister?.register ? { label: "INGESTED", tone: "#3D6BFF" } : { label: "SEEDED", tone: "#94a3b8" }}
          name={shipRegister?.register?.label ?? "the seeded demo register — a notional CVN-73 slice"}
          lines={[
            {
              text: shipRegister
                ? `${shipRegister.spaces_served} spaces on ${shipRegister.decks_served} decks — the hull every screen is built on`
                : "register unavailable",
              gloss:
                "The base layer. Every space, deck, zone and category the schedule locates to, the plan draws and the trace walks comes from this document. Once a register is ingested it IS the hull; the seeded template stops existing for it until a revert.",
            },
            ...(shipRegister?.register
              ? [{ text: `${shipRegister.register.decks} decks, ${shipRegister.register.spaces} spaces as ingested`, tone: C.dim }]
              : [{ text: "no register ingested — the seeded slice stands in, and says so", tone: C.dim }]),
          ]}
          upload={{
            label: "⭱ Upload register CSV",
            accept: ".csv,text/csv,text/plain",
            title:
              "Ingest the hull's compartment list (CSV lines: deck,<code>,<label>,<ordinal> and space,<no>,<name>,<deck>,<zone>,<category>[,<frame>,<side>]). The preview names every space that cannot be placed, every live field condition and scheduled activity that would lose its space. All-or-nothing.",
            onFile: stageRegister,
          }}
          importHint="Drawn on the Deck Explorer"
          onOpenHome={() => onOpenModule("deckExplorer")}
          onRevert={
            shipRegister?.register
              ? () => {
                  setMsg("⏳ discarding the compartment register…");
                  void revertRegister(identity, vesselId)
                    .then(() => {
                      setMsg("✓ back to the seeded register");
                      setNonce((n) => n + 1);
                    })
                    .catch((e: unknown) => setMsg(errText(e)));
                }
              : undefined
          }
        />

        <SourceCard
          kind="Coupling register"
          status={couplings?.register ? { label: "INGESTED", tone: "#3D6BFF" } : { label: "SEEDED", tone: "#94a3b8" }}
          name={couplings?.register?.label ?? "the seeded couplings — the demo cascade's paths"}
          lines={[
            {
              text: couplings
                ? `${couplings.edges_served} edges walked by every trace · types: ${couplings.types.map((t) => `${t.code} (${t.propagates.join("+")}, ${t.max_reach} hop${t.max_reach === 1 ? "" : "s"})`).join(" · ")}`
                : "couplings unavailable",
              gloss:
                "The paths a hazard can travel: deck penetrations, shared bulkheads, exhaust trunks, electrical buses. A rule binds to a coupling type; a trace walks the edges. No edge, no cascade — which is why the door can derive vertical adjacency rather than let heat go nowhere.",
            },
            ...(couplings?.register
              ? [{
                  text: `${couplings.register.authored} authored · ${couplings.register.derived} derived from deck order and frame overlap`,
                  tone: couplings.register.derived > 0 ? C.warn : C.dim,
                  gloss: "Derived edges are proposals from geometry, marked as such wherever a trace walks them. Authored edges are a person's claim.",
                }]
              : []),
          ]}
          extra={
            <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10.5, color: C.dim, cursor: "pointer" }} title="When on, the door proposes a deck_penetration edge from every space to the space directly below it — adjacent deck ordinal, overlapping frames, compatible side — and marks each one derived.">
              <input
                type="checkbox"
                checked={deriveVertical}
                onChange={(e) => setDeriveVertical(e.target.checked)}
                style={{ margin: 0 }}
              />
              derive vertical adjacency on import
            </label>
          }
          upload={{
            label: "⭱ Upload couplings CSV",
            accept: ".csv,text/csv,text/plain",
            title:
              "Ingest the hull's coupling register (CSV: from,to,code[,symmetric]). Every end must be on the register and every code a type the rules bind to. The preview lists every derived edge before Confirm. All-or-nothing.",
            onFile: stageCouplings,
          }}
          importHint="Walked by every trace on the Deck Explorer"
          onOpenHome={() => onOpenModule("deckExplorer")}
          onRevert={
            couplings?.register
              ? () => {
                  setMsg("⏳ discarding the coupling register…");
                  void revertCouplings(identity, vesselId)
                    .then(() => {
                      setMsg("✓ back to the seeded couplings");
                      setNonce((n) => n + 1);
                    })
                    .catch((e: unknown) => setMsg(errText(e)));
                }
              : undefined
          }
        />

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
                      ? `register disagrees: ${oob.map((o) => `${o.compartment} (${o.deck_code} Fr ${o.frame} vs ${o.zone} ${o.bounds})`).join(" · ")}`
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
              "Ingest the yard's zone chart (CSV: zone,lo_frame,hi_frame[,top_deck,bottom_deck] — one block per row; a zone may own several, and the blocks partition every deck). All-or-nothing; the audit is previewed before anything is stored.",
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
          kind="Yard clock"
          status={
            yardClock?.source === "document"
              ? { label: "INGESTED", tone: "#3D6BFF" }
              : { label: "DEFAULT · UTC", tone: "#f59e0b" }
          }
          name={
            yardClock?.source === "document"
              ? `${yardClock.label} — ${yardClock.clock.zone}`
              : "no yard clock — every time on screen is a Z-stamped UTC instant"
          }
          lines={clockLines(yardClock, register.schedule_source)}
          upload={{
            label: "⭱ Upload clock CSV",
            accept: ".csv,text/csv,text/plain",
            title:
              "Ingest the yard's clock (CSV lines: zone,<IANA name>,<±HH:MM>; daylight,<±HH:MM>,<month>,<week 1-5>,<sun..sat>,<HH:MM>,<month>,<week>,<weekday>,<HH:MM>; watch,<minutes>; shift,<name>,<HH:MM>,<HH:MM>). Refused whole with every reason. The preview lists this year's clock changes and today's shifts, and checks the rule against this browser's own tz database before Confirm.",
            onFile: stageClock,
          }}
          importHint="Read by every clock on every screen"
          onOpenHome={() => onOpenModule("dailyOps")}
          revertTitle="Back to UTC — every clock on screen is Z again, in amber, until a yard clock is loaded."
          onRevert={
            yardClock?.source === "document"
              ? () => {
                  setMsg("⏳ discarding the yard clock…");
                  void revertYardClock(identity, vesselId)
                    .then(() => {
                      setMsg("✓ back to UTC — every clock on screen is Z again");
                      setNonce((n) => n + 1);
                      onMutated();
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
          kind="Field-condition log"
          status={hazards.length > 0 ? { label: `${hazards.length} LIVE`, tone: "#f59e0b" } : { label: "NONE LIVE", tone: "#94a3b8" }}
          name={hazards.length > 0 ? `${hazards.length} field condition${hazards.length === 1 ? "" : "s"} live as of the board's instant` : "no field condition is live as of the board's instant"}
          lines={[
            {
              text: "the day's tag-out, permit and stop-work list, raised by the file rather than one at a time",
              gloss:
                "Not a document the screens serve — each row becomes a raise, ledgered by name under the log it came from. A row already live is left alone. Nothing is cleared by a log: clearance is a person's act with a basis, made on the Deck Explorer.",
            },
            ...(hazards.length > 0
              ? [{
                  text: hazards.slice(0, 6).map((h) => `${h.origin} ${h.kind}`).join(" · ") + (hazards.length > 6 ? ` · +${hazards.length - 6} more` : ""),
                  tone: C.dim,
                }]
              : []),
          ]}
          upload={{
            label: "⭱ Upload log CSV",
            accept: ".csv,text/csv,text/plain",
            title:
              "Raise the day's field conditions from a log (CSV: compartment,kind,label[,since]). Kinds in the engine's names or the yard's words. The preview says what would be raised and what is already live. The whole file is refused on one unknown space, empty label or future instant.",
            onFile: stageHazardLog,
          }}
          importHint="Raised and cleared one at a time on the Deck Explorer"
          onOpenHome={() => onOpenModule("deckExplorer")}
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

/**
 * The yard clock card's lines: the offsets and the rule as the card describes
 * them, the watch and the shifts by the yard's names, and — when a schedule
 * of record is served — the reminder that its wall clock was stamped in the
 * clock it was imported under.
 */
function clockLines(
  yc: (YardClockInfo & { now_local: string; offset_now: string }) | null,
  scheduleSource: string | null,
): { text: string; tone?: string; gloss?: string }[] {
  if (!yc) return [{ text: "yard clock unavailable", tone: C.danger }];
  const c = yc.clock;
  const rule = c.daylight;
  const lines: { text: string; tone?: string; gloss?: string }[] = [
    {
      text:
        `standard ${offsetLabel(c.standard_offset_minutes)}` +
        (rule
          ? ` · daylight ${offsetLabel(rule.offset_minutes)} from ${transitionLabel(rule.start)} to ${transitionLabel(rule.end)}`
          : " · no daylight rule — the clock never moves"),
      gloss:
        "An authored rule, not a tz database: the yard's own signed claim about its clock, evaluated identically on the server and in this shell against one shared vector file. A legislative change is a document edit, not a code release.",
    },
    {
      text: `watch ${c.watch_minutes / 60} h · ${c.shifts.map(shiftChip).join(" · ")}`,
      gloss: "The watch is the floor of time resolution on every board; the shifts are the chips on Daily Ops and the Reports' shift sheet, by the yard's names.",
    },
    {
      text: `now ${yc.now_local} (${yc.offset_now}) · the record stamps ${fmtStamp(Date.now())}`,
      tone: C.dim,
    },
  ];
  if (yc.source !== "document") {
    lines.push({
      text: "No yard clock loaded: every board renders UTC and marks it Z rather than guess a zone. Load the yard's clock here and every clock on every screen becomes the yard's wall clock.",
      tone: C.warn,
    });
  } else if (scheduleSource) {
    lines.push({
      text: `${scheduleSource} was read in the clock in effect when it was imported — re-import it after a clock change to re-stamp its wall clock`,
      tone: C.dim,
      gloss: "The XER carries P6's wall clock; the door converts it in the hull's clock at import time. The clock door's preview says so when the two disagree.",
    });
  }
  return lines;
}

/** One document's card: what it is, what landed, the door in, and the way out. */
function SourceCard({
  kind,
  status,
  name,
  lines,
  upload,
  extra,
  importHint,
  onOpenHome,
  onRevert,
  revertTitle,
}: {
  kind: string;
  status: { label: string; tone: string };
  name: string;
  lines: { text: string; tone?: string; gloss?: string }[];
  /** The document's own door: a picker, and the whole card as a drop target. */
  upload?: { label: string; accept: string; title: string; onFile: (f: File) => void };
  /** A door's own control, rendered under the lines — e.g. a derivation toggle. */
  extra?: ReactNode;
  importHint?: string;
  onOpenHome?: () => void;
  onRevert?: () => void;
  /** What the screens fall back to when this document is discarded. */
  revertTitle?: string;
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
              title={revertTitle ?? "Throw this document away — the screens return to what the tool can honestly serve without it."}
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
        {extra}
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

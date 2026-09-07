// The schedule door — the hull's schedule of record as a card with a door,
// a field map, a quarantine and a run history under it.
//
// The export the yard's P6 actually produces does not name its fields the
// way the sample does, carries rows the parser cannot honestly accept, and
// is saved from Windows in Windows-1252. This panel is where all of that is
// handled in the open: the file is decoded in the browser and the run says
// which branch was taken; the map — which UDF or activity code carries the
// compartment, the work item, the work type and the trade; which projects
// to serve — is chosen from the file's OWN fields, and every change re-runs
// the dry run so the located count moves before anything is stored; the
// rows set aside are listed with their line and reason, folded at 25 with
// the count always said; the rows excluded (level-of-effort, WBS summaries,
// other projects) are listed, not lost. Confirm is gated by the capability
// the server would refuse without, with the same sentence.
//
// Every commit is a run. The history lists them newest first with the
// served one marked; any run can be diffed against the served one in the
// same words the door's delta uses, and any prior run can be served again —
// a revert to an earlier import, two clicks, ledgered as SCHEDULE_REPLACED
// naming both runs. A failed history read renders "run history
// unavailable", never an empty table.

import { useEffect, useState } from "react";
import {
  diffScheduleRuns,
  importSchedule,
  listScheduleRuns,
  previewSchedule,
  revertSchedule,
  serveScheduleRun,
  DEFAULT_FIELD_MAP,
  FIELD_SLOTS,
  type ActivityRegister,
  type FieldMap,
  type FieldMapInfo,
  type FieldSlot,
  type FieldsSeen,
  type Identity,
  type ImportPreview,
  type QuarantinedRow,
  type ScheduleDelta,
  type ScheduleRunSummary,
  type XerEncoding,
} from "./api";
import { fmtDayTime } from "./clock";
import { useIdentity } from "./identity";
import {
  choiceKey,
  classWords,
  decodeXerFile,
  deltaSummary,
  exclusionSummary,
  fieldChoices,
  fieldMapSummary,
  fmtBytes,
  foldRows,
  importedByWords,
  quarantineGroups,
  quarantineSummary,
  runLine,
} from "./ingest";
import { SourceCard } from "./SourceCard";
import { commitBtnStyle, C, errText, mh, msgColor, tdStyle, thStyle } from "./theme";

/** The picked file, decoded, waiting on its dry run and a Confirm. */
interface StagedXer {
  label: string;
  sizeBytes: number;
  xer: string;
  encoding: XerEncoding;
}

const SLOT_WORDS: Record<FieldSlot, string> = {
  compartment: "Compartment",
  work_item: "Work item",
  work_type: "Work type",
  trade: "Trade",
};

const quietBtn: React.CSSProperties = {
  font: "inherit", fontSize: 10.5, cursor: "pointer", padding: "2px 8px", borderRadius: 5,
  color: C.dim, background: "transparent", border: `1px solid ${C.line}`,
};

const disabledBtn: React.CSSProperties = {
  ...quietBtn, cursor: "not-allowed", color: C.faint, opacity: 0.7,
};

export function ScheduleDoor({
  identity,
  vesselId,
  register,
  fieldMap,
  nonce,
  onMutated,
  onOpenModule,
}: {
  identity: Identity;
  vesselId: string;
  /** The served register, as the board read it — the card's own lines. */
  register: ActivityRegister;
  /** The hull's stored map, or null when that read failed. */
  fieldMap: FieldMapInfo | null;
  /** The board's re-read counter: the history follows it. */
  nonce: number;
  /** After a commit, a serve or a revert: the board and the app re-read. */
  onMutated: () => void;
  onOpenModule: (moduleId: string) => void;
}) {
  const { can, refusal } = useIdentity();
  const mayCommit = can("commit_document");

  const [staged, setStaged] = useState<StagedXer | null>(null);
  /** The map the dry run reads through while a file is staged. */
  const [map, setMap] = useState<FieldMap>(DEFAULT_FIELD_MAP);
  /** Whether the reader has changed the map: until then the door reads the
   *  stored one and says so (`document` / `default`), not an inline copy. */
  const [mapTouched, setMapTouched] = useState(false);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [showAllQuarantine, setShowAllQuarantine] = useState(false);

  const [runsOpen, setRunsOpen] = useState(false);
  const [runs, setRuns] = useState<ScheduleRunSummary[] | "unavailable" | null>(null);
  const [diff, setDiff] = useState<{ runId: string; against: string; delta: ScheduleDelta } | null>(null);
  const [serveArmed, setServeArmed] = useState<string | null>(null);

  // A hull switch invalidates everything staged: a file previewed against
  // hull A must never be one click from committing into hull B.
  useEffect(() => {
    setStaged(null);
    setPreview(null);
    setPreviewError(null);
    setBusy(null);
    setMsg(null);
    setRuns(null);
    setDiff(null);
    setServeArmed(null);
  }, [vesselId]);

  // The dry run: re-run on every change of the staged file or its map, with
  // a stale guard so a slow preview of an earlier map cannot land on top of
  // a faster later one.
  useEffect(() => {
    if (!staged) return undefined;
    let stale = false;
    setBusy(`previewing ${staged.label} (${fmtBytes(staged.sizeBytes)})…`);
    setPreviewError(null);
    previewSchedule(identity, vesselId, staged.label, staged.xer, {
      encoding: staged.encoding,
      ...(mapTouched ? { fieldMap: map } : {}),
    })
      .then((p) => {
        if (stale) return;
        setPreview(p);
        setBusy(null);
      })
      .catch((e: unknown) => {
        if (stale) return;
        setPreviewError(errText(e));
        setBusy(null);
      });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, staged, map, mapTouched]);

  // The run history, read when the fold is opened and whenever the board
  // re-reads (a commit, a serve, a revert all move the served pointer).
  useEffect(() => {
    if (!runsOpen) return undefined;
    let stale = false;
    listScheduleRuns(identity, vesselId)
      .then((r) => {
        if (!stale) setRuns(r.runs);
      })
      .catch(() => {
        if (!stale) setRuns("unavailable");
      });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, runsOpen, nonce]);

  const stage = (file: File) => {
    setMsg(null);
    setPreview(null);
    setShowAllQuarantine(false);
    setBusy(`reading ${file.name} (${fmtBytes(file.size)})…`);
    decodeXerFile(file)
      .then(({ xer, encoding }) => {
        // The stored map is the starting point — the one the door would read
        // through anyway — so the selects land on the hull's own convention.
        setMap(fieldMap?.map ?? DEFAULT_FIELD_MAP);
        setMapTouched(false);
        setStaged({ label: file.name, sizeBytes: file.size, xer, encoding });
      })
      .catch((e: unknown) => {
        setBusy(null);
        setMsg(errText(e));
      });
  };

  const cancel = () => {
    setStaged(null);
    setPreview(null);
    setPreviewError(null);
    setBusy(null);
  };

  const confirm = () => {
    const s = staged;
    if (!s) return;
    const inline = mapTouched ? map : undefined;
    cancel();
    setBusy(`ingesting ${s.label} (${fmtBytes(s.sizeBytes)})…`);
    importSchedule(identity, vesselId, s.label, s.xer, { encoding: s.encoding, fieldMap: inline })
      .then((r) => {
        setBusy(null);
        setMsg(`✓ ${r.label}: ${r.activities} activities, ${r.edges} edges · run #${r.seq} · ${quarantineSummary(r.quarantine)}`);
        onMutated();
      })
      .catch((e: unknown) => {
        setBusy(null);
        setMsg(errText(e));
      });
  };

  const editMap = (next: FieldMap) => {
    setMap(next);
    setMapTouched(true);
  };

  const serve = (run: ScheduleRunSummary) => {
    setServeArmed(null);
    setMsg(null);
    setBusy(`serving run #${run.seq} (${run.label}) again…`);
    serveScheduleRun(identity, vesselId, run.run_id)
      .then((r) => {
        setBusy(null);
        setMsg(`✓ run #${r.served.seq} (${r.served.label}) is the schedule of record again — ${deltaSummary(r.delta)}`);
        setDiff(null);
        onMutated();
      })
      .catch((e: unknown) => {
        setBusy(null);
        setMsg(errText(e));
      });
  };

  const showDiff = (run: ScheduleRunSummary) => {
    setMsg(null);
    setBusy(`diffing run #${run.seq} against the served run…`);
    diffScheduleRuns(identity, vesselId, run.run_id)
      .then((r) => {
        setBusy(null);
        setDiff({ runId: run.run_id, against: `#${r.against.seq} ${r.against.label}`, delta: r.delta });
      })
      .catch((e: unknown) => {
        setBusy(null);
        setMsg(errText(e));
      });
  };

  const m = register.mapping;
  const mismatches = register.reconciliation.mismatches;
  const served = register.schedule_run ?? null;
  const name = served
    ? `reading ${served.label}, imported ${fmtDayTime(served.imported_at_ms)} by ${importedByWords(served.imported_by)} · run #${served.seq}`
    : register.schedule_source
      ? `reading ${register.schedule_source} — set outside the run history`
      : "built from the seeded work orders and packages";

  return (
    <SourceCard
      wide
      kind="Schedule of record"
      status={register.schedule_source ? { label: "INGESTED", tone: "#3D6BFF" } : { label: "GENERATED", tone: "#94a3b8" }}
      name={name}
      lines={[
        {
          text:
            `${register.activities.length} activities · ${register.edges.length} edges · ${m.milestones} key events` +
            (served
              ? ` · ${served.counts.quarantined} quarantined · ${served.counts.excluded_loe + served.counts.excluded_wbs + served.counts.excluded_project} excluded · ${served.encoding} (decoded by the ${served.decoded_by})`
              : ""),
          tone: served && served.counts.quarantined > 0 ? C.danger : undefined,
          gloss: served
            ? `Projects served: ${served.projects_served.join(", ") || "all"} · map: ${fieldMapSummary(served.field_map)}`
            : undefined,
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
          "Ingest a Primavera P6 XER export as this hull's schedule of record — full multi-year exports included; the door takes files in the hundreds of megabytes, in UTF-8 or Windows-1252. The file is read through the hull's field map, chosen here from the fields the file itself carries. Rows the parser cannot honestly accept are quarantined with their line and reason and the rest is served; the file is refused whole only when nothing survives.",
        onFile: stage,
      }}
      importHint="Also on the Sequence Board"
      onOpenHome={() => onOpenModule("sequenceBoard")}
      revertTitle="Throw away the served schedule of record; the generated demo register is served again. The runs stay — any of them can be served again from the history below."
      onRevert={
        register.schedule_source
          ? () => {
              setMsg("⏳ discarding the ingested schedule…");
              void revertSchedule(identity, vesselId)
                .then(() => {
                  setMsg("✓ back to the generated register — the run history is kept");
                  onMutated();
                })
                .catch((e: unknown) => setMsg(errText(e)));
            }
          : undefined
      }
      extra={
        <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4 }}>
          {busy && <div style={{ fontSize: 11.5, color: C.warn }}>⏳ {busy}</div>}
          {staged && (
            <StagedPanel
              staged={staged}
              preview={preview}
              previewError={previewError}
              map={map}
              onMap={editMap}
              mapTouched={mapTouched}
              storedMapLabel={fieldMap?.source === "document" ? fieldMap.label : null}
              currentCount={register.activities.length}
              showAll={showAllQuarantine}
              onShowAll={() => setShowAllQuarantine(true)}
              mayCommit={mayCommit}
              refusal={refusal("commit_document")}
              onConfirm={confirm}
              onCancel={cancel}
            />
          )}
          <RunsFold
            open={runsOpen}
            onToggle={() => setRunsOpen((o) => !o)}
            runs={runs}
            diff={diff}
            serveArmed={serveArmed}
            onArm={setServeArmed}
            onServe={serve}
            onDiff={showDiff}
            mayServe={mayCommit}
            refusal={refusal("commit_document")}
          />
          {msg && <div style={{ fontSize: 11.5, color: msgColor(msg) }}>{msg}</div>}
        </div>
      }
    />
  );
}

/* ------------------------------------------------------------ the preview */

function StagedPanel({
  staged,
  preview,
  previewError,
  map,
  onMap,
  mapTouched,
  storedMapLabel,
  currentCount,
  showAll,
  onShowAll,
  mayCommit,
  refusal,
  onConfirm,
  onCancel,
}: {
  staged: StagedXer;
  preview: ImportPreview | null;
  previewError: string | null;
  map: FieldMap;
  onMap: (m: FieldMap) => void;
  mapTouched: boolean;
  storedMapLabel: string | null;
  currentCount: number;
  showAll: boolean;
  onShowAll: () => void;
  mayCommit: boolean;
  refusal: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const p = preview;
  const mp = p?.mapping;
  const line: React.CSSProperties = { display: "flex", gap: 8, alignItems: "baseline", fontSize: 11.5, flexWrap: "wrap" };
  const tag: React.CSSProperties = {
    fontSize: 9, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: C.dim, minWidth: 84,
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "9px 12px", border: "1px solid #f59e0b66", borderRadius: 8, background: "rgba(245,158,11,0.06)" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
        <b style={{ fontSize: 12.5 }}>{staged.label}</b>
        <span style={{ fontSize: 10.5, color: C.dim }}>
          {fmtBytes(staged.sizeBytes)} · {staged.encoding}
          <span title="Which branch this browser's decoder took: strict UTF-8 first, Windows-1252 (P6's default on Windows) when that fails. The run records it."> (decoded by the browser)</span>
        </span>
        {p && (
          <span style={{ fontSize: 11.5, color: C.bright }}>
            {p.activities} activities · {p.edges} edges · {p.mapping.milestones} key events ·{" "}
            <span title="The projects in the file the map serves; the rest are excluded and listed.">
              projects served: {p.run.projects_served.join(", ") || "none"}
              {p.fields_seen.projects.length > p.run.projects_served.length && ` (of ${p.fields_seen.projects.length} in the file)`}
            </span>
          </span>
        )}
        <span style={{ fontSize: 10.5, color: C.dim }}>— previewed, nothing stored</span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            onClick={onConfirm}
            disabled={!mayCommit || !p}
            title={
              !mayCommit
                ? refusal
                : !p
                  ? "Waiting on the dry run."
                  : `Store this export as the schedule of record, as run #${"n"} of this hull, read through the map shown. Reversible: Discard brings the generated register back, and any run can be served again from the history.`.replace("#n", "the next number")
            }
            style={mayCommit && p ? commitBtnStyle : { ...commitBtnStyle, cursor: "not-allowed", color: C.faint, border: `1px solid ${C.line}`, background: "transparent", opacity: 0.7 }}
          >
            Confirm import
          </button>
          <button onClick={onCancel} title="Walk away — the preview cost nothing and nothing was stored." style={quietBtn}>
            Cancel
          </button>
        </span>
        {!mayCommit && (
          <span style={{ width: "100%", fontSize: 11, color: C.warn }}>
            {refusal} — the preview cost nothing and stored nothing.
          </span>
        )}
      </div>

      {previewError && (
        <div style={{ fontSize: 11.5, color: C.danger }} title="The door refused the file whole — nothing survives to serve, or the map is malformed. The sentence is the server's.">
          {previewError}
        </div>
      )}

      <FieldMapPanel
        seen={p?.fields_seen ?? null}
        map={map}
        onMap={onMap}
        source={p ? p.run.field_map_source : mapTouched ? "inline" : "document"}
        storedMapLabel={storedMapLabel}
      />

      {p && mp && (
        <>
          <div style={line}>
            <span style={tag}>Location</span>
            <span style={{ color: mp.unlocated.length > 0 ? C.danger : mp.located_derived.length > 0 ? C.warn : C.ok }}>
              {mp.located_authored} of {mp.work_activities} authored
              {mp.located_derived.length > 0 && (
                <span title={`Read from task names: ${mp.located_derived.slice(0, 8).map((d) => `${d.activity} → ${d.compartment}`).join(", ")} — graded guesses, marked ≈ wherever they appear.`}>
                  {" "}· {mp.located_derived.length} read from task names
                </span>
              )}
              {mp.unlocated.length > 0 && (
                <span title={`Unlocated: ${mp.unlocated.slice(0, 8).map((u) => `${u.activity}${u.zone_hint ? ` (${u.zone_hint} per WBS)` : ""}`).join(", ")}${mp.unlocated.length > 8 ? ", …" : ""}`}>
                  {" "}· {mp.unlocated.length} unlocated
                </span>
              )}
              {mp.unknown_spaces.length > 0 && (
                <span style={{ color: C.danger, fontWeight: 700 }}>
                  {" "}· {mp.unknown_spaces.length} to spaces this register does not carry
                </span>
              )}
            </span>
            <span style={{ color: C.dim }}>
              · Confirm replaces the current register ({currentCount} activities) on every screen
            </span>
          </div>

          <div style={line}>
            <span style={tag}>Hours</span>
            <span style={{ color: p.reconciliation.mismatches.length > 0 ? C.warn : C.ok }}>
              {p.reconciliation.mismatches.length > 0
                ? `do not reconcile: ${p.reconciliation.mismatches.map((x) => x.code).join(", ")}`
                : "reconcile with the work items"}
            </span>
            <span style={{ color: C.dim }} title="Only labor assignments (RT_Labor) are man-hours; material and equipment lines are counted and set aside, and an untyped resource is counted as labor with a finding.">
              · labor only: {p.run.counts.material_skipped} material and {p.run.counts.equipment_skipped} equipment assignment{p.run.counts.material_skipped + p.run.counts.equipment_skipped === 1 ? "" : "s"} not in anyone&apos;s man-hours
            </span>
          </div>

          <QuarantineFold rows={p.quarantine} showAll={showAll} onShowAll={onShowAll} />

          <div style={line}>
            <span style={tag}>Excluded</span>
            <span style={{ color: C.dim }} title="Listed, not lost: level-of-effort and WBS-summary rows are not work; rows in projects the map does not serve stay in the file.">
              {exclusionSummary(p.exclusions)}
            </span>
          </div>

          {p.findings.length > 0 && (
            <div style={line}>
              <span style={tag}>Findings</span>
              <span style={{ display: "flex", flexDirection: "column", gap: 2, color: C.warn }}>
                {p.findings.map((f) => (
                  <span key={f}>⚠ {f}</span>
                ))}
              </span>
            </div>
          )}

          <div style={line}>
            <span style={tag}>Delta</span>
            <span style={{ color: p.delta.newly_refused.count > 0 ? C.warn : C.bright }}>{deltaSummary(p.delta)}</span>
          </div>
        </>
      )}
    </div>
  );
}

/* --------------------------------------------------------- the field map */

function FieldMapPanel({
  seen,
  map,
  onMap,
  source,
  storedMapLabel,
}: {
  seen: FieldsSeen | null;
  map: FieldMap;
  onMap: (m: FieldMap) => void;
  source: "inline" | "document" | "default";
  storedMapLabel: string | null;
}) {
  const selectStyle: React.CSSProperties = {
    font: "inherit", fontSize: 11, color: C.text, background: C.raised, border: `1px solid ${C.line}`,
    borderRadius: 5, padding: "2px 6px", maxWidth: 260,
  };
  const projects = seen?.projects ?? [];
  const servesAll = map.projects.length === 0;
  const isServed = (name: string) => servesAll || map.projects.includes(name);
  const toggleProject = (name: string) => {
    const next = projects.filter((p) => (p.short_name === name ? !isServed(name) : isServed(p.short_name))).map((p) => p.short_name);
    // Every project ticked is "all" — the map's own word for it.
    onMap({ ...map, projects: next.length === projects.length ? [] : next });
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5, padding: "7px 10px", border: `1px solid ${C.line}`, borderRadius: 6, background: C.panel }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap", fontSize: 11 }}>
        <b style={{ fontSize: 11.5 }}>Field map</b>
        <span style={{ color: C.dim }}>
          {source === "inline"
            ? "chosen here — committed with the run as this hull's map when it differs from the stored one"
            : source === "document"
              ? `the hull's stored map${storedMapLabel ? ` (${storedMapLabel})` : ""} — change a field and the dry run re-runs`
              : "today's default convention — no map on file; change a field and the dry run re-runs"}
        </span>
        {!seen && <span style={{ color: C.warn }}>· waiting on the survey of this file&apos;s fields</span>}
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", alignItems: "center" }}>
        {FIELD_SLOTS.map((slot) => {
          const choices = fieldChoices(seen, slot, map[slot]);
          return (
            <label key={slot} style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 11, color: C.dim }}>
              {SLOT_WORDS[slot]} ←
              <select
                value={choiceKey(map[slot])}
                onChange={(e) => {
                  const pick = choices.find((c) => c.key === e.target.value);
                  if (pick) onMap({ ...map, [slot]: pick.source });
                }}
                style={selectStyle}
                title={
                  slot === "compartment"
                    ? "Which field carries the compartment placard. A UDF is graded High; an activity code Medium; with none, placards may be read out of task names (Medium) — never silently."
                    : slot === "trade"
                      ? "Which field carries the trade — the first labor resource assigned, a UDF, or an activity code."
                      : slot === "work_type"
                        ? "Which field carries the work type the rule table binds to."
                        : "Which field carries the work item / work order number."
                }
              >
                {choices.map((c) => (
                  <option key={c.key} value={c.key}>{c.label}</option>
                ))}
              </select>
            </label>
          );
        })}
        <label style={{ display: "inline-flex", gap: 6, alignItems: "center", fontSize: 11, color: C.dim, cursor: "pointer" }} title="When the compartment field is silent on a row, read a placard out of the task's own name — graded Medium and marked ≈ wherever it appears.">
          <input
            type="checkbox"
            checked={map.placards_from_names}
            onChange={(e) => onMap({ ...map, placards_from_names: e.target.checked })}
            style={{ margin: 0 }}
          />
          read placards out of task names when the field is silent
        </label>
      </div>
      {projects.length > 0 && (
        <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", fontSize: 11, color: C.dim }}>
          <span title="The projects this export carries. Untick one and its rows are excluded and listed; a relationship into it is quarantined as cross-project logic.">
            Projects served{servesAll ? " (all)" : ""}:
          </span>
          {projects.map((p) => (
            <label key={p.id} style={{ display: "inline-flex", gap: 5, alignItems: "center", cursor: "pointer" }}>
              <input type="checkbox" checked={isServed(p.short_name)} onChange={() => toggleProject(p.short_name)} style={{ margin: 0 }} />
              <span style={{ fontFamily: "monospace", color: C.bright }}>{p.short_name}</span>
              <span>({p.tasks} task{p.tasks === 1 ? "" : "s"})</span>
            </label>
          ))}
        </div>
      )}
      {seen && (
        <div style={{ fontSize: 10.5, color: C.subtle }} title="The survey of this file — no schedule content, the one thing a yard can mail back about its own export.">
          this file carries: UDFs {seen.udfs.map((u) => u.name).join(", ") || "none"} · activity codes {seen.activity_code_types.map((t) => t.name).join(", ") || "none"}
          {" "}· resources {Object.entries(seen.resource_types).map(([k, v]) => `${k.replace("RT_", "")} ${v}`).join(", ")}
          {!seen.has_rsrc_type && " (no rsrc_type — every assignment counted as labor)"}
          {" "}· task types {Object.entries(seen.task_types).filter(([, v]) => v > 0).map(([k, v]) => `${k.replace("TT_", "")} ${v}`).join(", ")}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------- the quarantine */

function QuarantineFold({ rows, showAll, onShowAll }: { rows: QuarantinedRow[]; showAll: boolean; onShowAll: () => void }) {
  const ordered = quarantineGroups(rows).flatMap((g) => g.rows);
  const { shown, hidden } = foldRows(ordered, showAll);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 11.5 }}>
        <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: C.dim, minWidth: 84 }}>Quarantine</span>
        <span
          style={{ color: rows.length > 0 ? C.danger : C.ok, fontWeight: rows.length > 0 ? 700 : undefined }}
          title="Rows the parser could not honestly accept, set aside with their line and reason so a scheduler can find each one in P6 and fix it there. The rest of the file is served; the count is on the card and in the ledger."
        >
          {quarantineSummary(rows)}
        </span>
      </div>
      {rows.length > 0 && (
        <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 6 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11 }}>
            <thead>
              <tr>
                {["Line", "Table", "Code", "Class", "Reason"].map((h) => (
                  <th key={h} style={{ ...thStyle, padding: "4px 8px" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={`${r.line}-${r.table}-${r.class}`}>
                  <td style={{ ...tdStyle, padding: "3px 8px", fontSize: 11, fontFamily: "monospace", color: C.bright }}>{r.line}</td>
                  <td style={{ ...tdStyle, padding: "3px 8px", fontSize: 11, fontFamily: "monospace", color: C.dim }}>{r.table}</td>
                  <td style={{ ...tdStyle, padding: "3px 8px", fontSize: 11, fontFamily: "monospace", color: C.bright }}>{r.code ?? "—"}</td>
                  <td style={{ ...tdStyle, padding: "3px 8px", fontSize: 11, color: C.warn, whiteSpace: "nowrap" }}>{classWords(r.class)}</td>
                  <td style={{ ...tdStyle, padding: "3px 8px", fontSize: 11, color: C.text }}>{r.reason}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {hidden > 0 && (
            <div style={{ padding: "4px 8px", fontSize: 10.5, color: C.dim, display: "flex", gap: 8, alignItems: "center" }}>
              {shown.length} of {rows.length} shown · {hidden} more behind this fold
              <button onClick={onShowAll} style={quietBtn}>show all {rows.length}</button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* --------------------------------------------------------------- the runs */

function RunsFold({
  open,
  onToggle,
  runs,
  diff,
  serveArmed,
  onArm,
  onServe,
  onDiff,
  mayServe,
  refusal,
}: {
  open: boolean;
  onToggle: () => void;
  runs: ScheduleRunSummary[] | "unavailable" | null;
  diff: { runId: string; against: string; delta: ScheduleDelta } | null;
  serveArmed: string | null;
  onArm: (runId: string | null) => void;
  onServe: (run: ScheduleRunSummary) => void;
  onDiff: (run: ScheduleRunSummary) => void;
  mayServe: boolean;
  refusal: string;
}) {
  // An armed serve left behind must not fire a minute later by accident.
  useEffect(() => {
    if (!serveArmed) return undefined;
    const t = setTimeout(() => onArm(null), 8000);
    return () => clearTimeout(t);
  }, [serveArmed, onArm]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
      <button
        onClick={onToggle}
        title="Every import of this hull's schedule, newest first, with the served one marked. Any run can be diffed against the served one and served again — a revert to a prior import, ledgered."
        style={{ ...quietBtn, alignSelf: "flex-start", color: C.accent, border: `1px solid ${C.accent}55` }}
        aria-expanded={open}
      >
        {open ? "▾" : "▸"} Runs{Array.isArray(runs) ? ` (${runs.length})` : ""}
      </button>
      {open && runs === null && <div style={{ fontSize: 11, color: C.dim }}>Reading the run history…</div>}
      {open && runs === "unavailable" && (
        <div style={{ fontSize: 11.5, color: C.warn }}>run history unavailable — the read failed, so no run is listed rather than none</div>
      )}
      {open && Array.isArray(runs) && runs.length === 0 && (
        <div style={{ fontSize: 11, color: C.dim }}>no run yet — the first import of a schedule of record records run #1</div>
      )}
      {open && Array.isArray(runs) && runs.length > 0 && (
        <div style={{ overflowX: "auto", border: `1px solid ${C.line}`, borderRadius: 6 }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11 }}>
            <thead>
              <tr>
                {["Run", "Export", "Imported", "By", "Rows served", "Quarantined", "Encoding", "Map", ""].map((h) => (
                  <th key={h} style={{ ...thStyle, padding: "4px 8px" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <RunRow
                  key={r.run_id}
                  run={r}
                  diff={diff?.runId === r.run_id ? diff : null}
                  armed={serveArmed === r.run_id}
                  onArm={onArm}
                  onServe={onServe}
                  onDiff={onDiff}
                  mayServe={mayServe}
                  refusal={refusal}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function RunRow({
  run,
  diff,
  armed,
  onArm,
  onServe,
  onDiff,
  mayServe,
  refusal,
}: {
  run: ScheduleRunSummary;
  diff: { against: string; delta: ScheduleDelta } | null;
  armed: boolean;
  onArm: (runId: string | null) => void;
  onServe: (run: ScheduleRunSummary) => void;
  onDiff: (run: ScheduleRunSummary) => void;
  mayServe: boolean;
  refusal: string;
}) {
  const td: React.CSSProperties = { ...tdStyle, padding: "4px 8px", fontSize: 11, color: C.text };
  const x = run.counts.excluded_loe + run.counts.excluded_wbs + run.counts.excluded_project;
  return (
    <>
      <tr title={runLine(run)} style={{ background: run.served ? "rgba(61,107,255,0.06)" : undefined }}>
        <td style={{ ...td, fontFamily: "monospace", whiteSpace: "nowrap" }}>
          #{run.seq}
          {run.served && (
            <span style={{ marginLeft: 6, fontSize: 9, fontWeight: 700, letterSpacing: 0.6, padding: "1px 6px", borderRadius: 4, color: C.accent, border: `1px solid ${C.accent}55`, background: `${C.accent}14` }} title="This run's rows are the schedule of record every screen reads now.">
              SERVED
            </span>
          )}
        </td>
        <td style={{ ...td, fontFamily: "monospace", color: C.bright, wordBreak: "break-all" }}>{run.label}</td>
        <td style={{ ...td, whiteSpace: "nowrap", color: C.dim }}>{fmtDayTime(run.imported_at_ms)}</td>
        <td style={{ ...td, color: run.imported_by.person ? C.bright : C.warn }} title={`${run.imported_by.person ?? "no person"} · via ${run.imported_by.via} · org ${run.imported_by.org}`}>
          {importedByWords(run.imported_by)}
        </td>
        <td style={{ ...td, whiteSpace: "nowrap", color: C.bright }} title={`${run.counts.work} work · ${run.counts.key_events} key events · ${run.counts.edges} edges · ${x} excluded`}>
          {run.counts.served.toLocaleString()}{x > 0 && <span style={{ color: C.dim }}> · {x} excluded</span>}
        </td>
        <td style={{ ...td, whiteSpace: "nowrap", color: run.counts.quarantined > 0 ? C.danger : C.ok }}>{run.counts.quarantined}</td>
        <td style={{ ...td, whiteSpace: "nowrap", color: C.dim }} title={`decoded by the ${run.decoded_by}`}>{run.encoding}</td>
        <td style={{ ...td, color: C.dim, maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={fieldMapSummary(run.field_map)}>
          {fieldMapSummary(run.field_map)}
        </td>
        <td style={{ ...td, whiteSpace: "nowrap" }}>
          {!run.served && (
            <span style={{ display: "inline-flex", gap: 6, alignItems: "center" }}>
              <button onClick={() => onDiff(run)} style={quietBtn} title="What this run changes against the served run — the door's own delta, under today's hazards.">
                diff vs served
              </button>
              {!mayServe ? (
                <button disabled style={disabledBtn} title={refusal}>serve this run…</button>
              ) : !armed ? (
                <button
                  onClick={() => onArm(run.run_id)}
                  style={quietBtn}
                  title="Serve this run's rows as the schedule of record again — a revert to a prior import. Nothing changes until you confirm."
                >
                  serve this run…
                </button>
              ) : (
                <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
                  <span style={{ fontSize: 10.5, color: C.dangerSoft }}>
                    Serve run #{run.seq} again? A revert to a prior import: its {run.counts.served.toLocaleString()} rows replace the served schedule on every screen, ledgered as SCHEDULE_REPLACED naming both runs.
                  </span>
                  <button
                    onClick={() => onServe(run)}
                    style={{ font: "inherit", fontSize: 10.5, fontWeight: 700, cursor: "pointer", padding: "2px 9px", borderRadius: 5, color: C.dangerSoft, background: "rgba(220,38,38,0.14)", border: "1px solid rgba(220,38,38,0.55)" }}
                  >
                    Serve
                  </button>
                  <button onClick={() => onArm(null)} style={quietBtn}>Keep</button>
                </span>
              )}
            </span>
          )}
        </td>
      </tr>
      {diff && (
        <tr>
          <td colSpan={9} style={{ ...td, color: diff.delta.newly_refused.count > 0 ? C.warn : C.bright, background: "rgba(61,107,255,0.04)" }}>
            run #{run.seq} {deltaSummary({ ...diff.delta, baseline: `served run ${diff.against}` })}
          </td>
        </tr>
      )}
    </>
  );
}

import { useEffect, useState } from "react";
import {
  compartmentState,
  getPackage,
  listPackages,
  type AsOf,
  type DeckStateRow,
  type Identity,
  type Governing,
  type PackageDetail,
  type PackageSummary,
} from "./api";
import { IsoWalk, type WalkStep, type WalkTone } from "./IsoWalk";
import { Loading } from "./Loading";
import { ModuleHeader } from "./ModuleHeader";
import { C, fmtClear, mh, STATE_STYLE } from "./theme";

/** One refusal in a space, in the engine's own prose. */
interface SpaceWhy {
  rule_code: string;
  reason: string;
  hazard: string;
  origin: string;
  /** The governing document the rule cites, e.g. "NFPA 306; NSTM Ch. 074". */
  authority: string;
  clearing_authority: string;
  earliest_clear: number | null;
  /** True when the hold lives in ANOTHER space and reaches this one. */
  remote: boolean;
}

export default function DistributedPackages({
  identity,
  vesselId,
  hullLabel,
  asOf,
  spaces,
  onOpenSpace,
}: {
  identity: Identity;
  vesselId: string;
  hullLabel: string;
  /** The instant the footprint's authorization is read at; `null` is live. */
  asOf: AsOf;
  /** Per-space verdicts at the same instant — the walkthrough hull's ground truth. */
  spaces: DeckStateRow[];
  onOpenSpace: (compartment: string) => void;
}) {
  // `null` while the list is in flight: "no distributed packages" is a claim
  // about the hull, and a claim must not render while the answer is unknown.
  const [packages, setPackages] = useState<PackageSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [detail, setDetail] = useState<PackageDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setDetail(null);
    setPackages(null);
    let stale = false;
    listPackages(identity, vesselId)
      .then((p) => {
        if (stale) return;
        setPackages(p);
        setSelected(p[0]?.code ?? null);
      })
      .catch((e: unknown) => {
        if (stale) return;
        setPackages(null);
        setSelected(null);
        setError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [identity, vesselId]);

  useEffect(() => {
    if (!selected) return undefined;
    // Cleared up front and guarded against reordering: a slow response for
    // the previous tab must never render under the newly selected one.
    setDetail(null);
    setDetailError(null);
    let stale = false;
    getPackage(identity, vesselId, selected, asOf)
      .then((d) => {
        if (!stale) setDetail(d);
      })
      .catch((e: unknown) => {
        if (!stale) setDetailError(String(e));
      });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, selected, asOf]);

  // The cause layer: the held footprint spaces' decision traces carry the
  // hop-by-hop path of whatever holds them — drawn so a hold three decks
  // from its origin stops looking arbitrary.
  const [routes, setRoutes] = useState<[string, string][]>([]);
  /** Each held space's refusals, in the engine's own prose — the WHY layer. */
  const [whyBySpace, setWhyBySpace] = useState<Map<string, SpaceWhy[]>>(new Map());
  useEffect(() => {
    // Cleared before the fetch, not after: the previous package's routes must
    // not draw under this one's legend while the traces are in flight.
    setRoutes([]);
    setWhyBySpace(new Map());
    const held = detail?.footprint.filter((f) => f.state !== "ALLOW") ?? [];
    if (held.length === 0) {
      return undefined;
    }
    let stale = false;
    void Promise.all(
      held.map((f) =>
        compartmentState(identity, vesselId, f.compartment_no, asOf)
          .then((r) => [f.compartment_no, r] as const)
          .catch(() => null),
      ),
    ).then((results) => {
      if (stale) return;
      const seen = new Set<string>();
      const edges: [string, string][] = [];
      const why = new Map<string, SpaceWhy[]>();
      for (const entry of results) {
        if (!entry) continue;
        const [space, r] = entry;
        for (const t of r.decision.trace) {
          for (let i = 0; i + 1 < t.path.length; i += 1) {
            const a = t.path[i];
            const b = t.path[i + 1];
            if (a === undefined || b === undefined) continue;
            const key = `${a}→${b}`;
            if (seen.has(key)) continue;
            seen.add(key);
            edges.push([a, b]);
          }
          // The refusing steps ARE the why, in the engine's own words.
          if (t.state === "BLOCK" || t.state === "SUSPEND") {
            const list = why.get(space) ?? [];
            if (!list.some((w) => w.rule_code === t.rule_code && w.origin === t.source)) {
              list.push({
                rule_code: t.rule_code,
                reason: t.reason,
                hazard: t.hazard,
                origin: t.source,
                authority: t.authority,
                clearing_authority: t.clearing_authority,
                earliest_clear: t.earliest_clear,
                remote: t.source !== space,
              });
            }
            why.set(space, list);
          }
        }
      }
      setRoutes(edges);
      setWhyBySpace(why);
    });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, asOf, detail]);

  if (error) {
    return <p style={{ color: C.danger }}>This hull is out of scope for you ({error}).</p>;
  }
  if (packages === null) {
    return <Loading label="Reading the distributed packages…" />;
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

  // The footprint as a guided tour: upstream to downstream, the order the
  // test authority walks it, with the governing constraint told loudest.
  const walkCast: { space: string; tone: WalkTone }[] = (detail?.footprint ?? []).map((f) => ({
    space: f.compartment_no,
    tone:
      g !== null && g.compartment === f.compartment_no
        ? ("danger" as const)
        : f.state === "ALLOW"
          ? ("ok" as const)
          : ("warn" as const),
  }));
  const walkSteps: WalkStep[] = [];
  if (detail) {
    walkSteps.push({
      title: `Walk the ${detail.package.code} footprint`,
      tone: "accent",
      body:
        `${detail.package.name} — one work order across ${detail.package.compartment_count} compartments. ` +
        `A segment cannot be ${detail.package.test_verb} until it and everything upstream of it is complete, so the walk runs upstream → downstream.`,
      spaces: detail.footprint.map((f) => f.compartment_no),
    });
    detail.footprint.forEach((f, i) => {
      const isGov = g !== null && g.compartment === f.compartment_no;
      walkSteps.push({
        title: `${i + 1} · ${f.compartment_no}${isGov ? " — THE GOVERNING CONSTRAINT" : ""}`,
        tone: isGov ? "danger" : f.state === "ALLOW" ? "ok" : "warn",
        body:
          (isGov && g ? `${g.consequence} ` : "") +
          `${f.state}${f.rules_fired.length > 0 ? ` (${f.rules_fired.join(", ")})` : ""} · ` +
          (f.complete ? "work complete" : `${mh(f.remaining_hours)} of work left`) +
          (isGov ? "" : f.state === "ALLOW" ? " — nothing refuses this segment's work." : " — held; downstream segments wait on this space."),
        spaces: [f.compartment_no],
        arrowFrom: i > 0 ? detail.footprint[i - 1]?.compartment_no : undefined,
      });
    });
    const stranded = detail.package.total_stranded_hours;
    walkSteps.push({
      title: "What the distribution costs",
      tone: stranded > 0 ? "danger" : "ok",
      body:
        `${mh(stranded)} stranded — finished or finishable work that cannot be ${detail.package.test_verb} from here. ` +
        `Segments ready: ${detail.package.testable_segment_count} of ${detail.package.segment_count}. One held compartment strands man-hours it does not contain.`,
      spaces: detail.footprint.filter((f) => f.state !== "ALLOW").map((f) => f.compartment_no),
    });
  }

  return (
    <div>
      <ModuleHeader
        kicker={`Distributed Packages · ${hullLabel}`}
        title="One work order, many compartments"
        stats={[
          detail !== null && {
            value: mh(detail.package.total_stranded_hours), label: "stranded",
            tone: detail.package.total_stranded_hours > 0 ? C.danger : undefined,
            title: "Finished or finishable man-hours that cannot be tested from here — the cost of the distribution, not of any one space.",
          },
          detail !== null && {
            value: mh(detail.package.budget_hours - detail.package.earned_hours), label: "remaining",
            title: "Install man-hours left across the whole footprint.",
          },
          detail !== null && {
            value: `${detail.package.open_compartment_count} of ${detail.package.compartment_count}`, label: "compartments open",
            title: "Spaces in the footprint that permit work right now.",
          },
          detail !== null && {
            value: `${detail.package.testable_segment_count} of ${detail.package.segment_count}`,
            label: `ready to be ${detail.package.test_verb}`,
            tone: detail.package.testable_segment_count === 0 ? C.danger : C.ok,
            title: "A segment is testable only when it AND everything upstream of it is complete.",
          },
        ]}
        note={
          <>
            Authorization state is a <b style={{ color: C.bright }}>distribution over the
            footprint</b>, not a value: a segment cannot be{" "}
            {detail?.package.test_verb ?? "tested"} until it <i>and everything upstream of it</i>{" "}
            is complete — so one held compartment strands man-hours it does not contain.
          </>
        }
      />

      {/* package tabs */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {packages.map((p) => (
          <button
            key={p.code}
            onClick={() => setSelected(p.code)}
            style={{
              padding: "6px 11px", borderRadius: 6, cursor: "pointer", font: "inherit", fontSize: 12,
              textAlign: "left",
              background: p.code === selected ? C.raised : "transparent",
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

      {detailError && (
        <p style={{ color: C.danger, fontSize: 12.5 }}>
          Package detail unavailable ({detailError}).
        </p>
      )}
      {!detail && !detailError && <Loading label="Reading the footprint…" />}

      {detail && (
        <>
          {/* WHY, in plain English — worst news first, every claim clickable */}
          <WhyPanel detail={detail} g={g} whyBySpace={whyBySpace} onOpenSpace={onOpenSpace} />

          {/* the waits-on map: what cannot move until what completes */}
          <SegmentFlow detail={detail} g={g} />

          {/* the footprint in three dimensions, stepped */}
          <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: C.dim, marginBottom: 7 }}>
            3D walkthrough · the footprint, upstream to downstream
          </div>
          <div style={{ marginBottom: 16 }}>
            <IsoWalk
              key={selected ?? ""}
              spaces={spaces}
              steps={walkSteps}
              routes={routes}
              cast={walkCast}
              onOpenSpace={onOpenSpace}
            />
          </div>

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
                        color: s.testable ? C.ok : C.warn,
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
                        <span style={{ color: C.warn }}>
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
                    <span style={{ marginLeft: "auto", fontSize: 11.5, fontVariantNumeric: "tabular-nums", color: f.complete ? C.ok : C.text }}>
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

/** "Why can't this proceed?" — the derivation, in plain English, worst news
 *  first. Every sentence is composed from served facts: the engine's own
 *  trace prose for holds, the package topology for stranding, the governing
 *  constraint's consequence. Nothing here is written by hand per hull. */
function WhyPanel({
  detail,
  g,
  whyBySpace,
  onOpenSpace,
}: {
  detail: PackageDetail;
  g: Governing | null;
  whyBySpace: Map<string, SpaceWhy[]>;
  onOpenSpace: (compartment: string) => void;
}) {
  const verb = detail.package.test_verb;
  const ready = detail.package.testable_segment_count;
  const total = detail.package.segment_count;
  const strandedSegs = detail.segments.filter((x) => x.complete && !x.testable);
  const incomplete = detail.segments.filter((x) => !x.complete);

  const space = (no: string) => (
    <button
      key={no}
      onClick={() => onOpenSpace(no)}
      title="Open on the deck plan"
      style={{
        font: "inherit", fontSize: 11, fontFamily: "monospace", cursor: "pointer",
        padding: "0 5px", borderRadius: 4, color: C.bright,
        background: "rgba(148,163,184,0.08)", border: `1px solid ${C.line}`,
      }}
    >
      {no}
    </button>
  );

  const govWhy = g ? (whyBySpace.get(g.compartment) ?? [])[0] : undefined;

  return (
    <div style={{ border: "1px solid rgba(239,68,68,0.4)", background: "rgba(239,68,68,0.045)", borderRadius: 8, padding: "12px 15px", marginBottom: 14 }}>
      <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: C.dangerSoft, marginBottom: 6 }}>
        Why can&apos;t this proceed?
      </div>
      <p style={{ fontSize: 13.5, margin: "0 0 8px", color: C.text }}>
        {ready === 0
          ? `Nothing in ${detail.package.code} can be ${verb} today.`
          : `Only ${ready} of ${total} segments can be ${verb} today.`}{" "}
        <span style={{ color: C.dim }}>The chain, in order:</span>
      </p>
      <ol style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 7, fontSize: 12.5, lineHeight: 1.5 }}>
        {g && g.constraint.kind === "authorization" && (
          <li>
            <b style={{ color: C.dangerSoft }}>The bottleneck is a hold, not missing work.</b>{" "}
            {space(g.compartment)} refuses work right now
            {govWhy ? (
              <>
                : <i>{govWhy.reason}</i> Rule{" "}
                <b style={{ fontFamily: "monospace" }}>{govWhy.rule_code}</b> refuses it
                {govWhy.authority ? ` (per ${govWhy.authority})` : ""}.
              </>
            ) : (
              <> ({g.constraint.rules.join(", ")}).</>
            )}{" "}
            Only <b style={{ color: C.bright }}>{g.constraint.clearing_authority}</b> can clear it
            {g.constraint.earliest_clear
              ? ` — earliest ${fmtClear(g.constraint.earliest_clear)}`
              : " — on verification, never on a clock"}
            . {g.consequence} <b>Adding crew will not move this.</b>
          </li>
        )}
        {g && g.constraint.kind === "completion" && (
          <li>
            <b style={{ color: C.bright }}>The bottleneck is unfinished work, not a hold.</b>{" "}
            Nothing refuses {space(g.compartment)} — {mh(g.own_remaining)} of install remains
            there, and everything downstream waits on it. This one responds to crew.
          </li>
        )}
        {incomplete.slice(0, 4).map((seg) => {
          const heldSpaces = seg.open_compartments.filter(
            (no) => (whyBySpace.get(no) ?? []).length > 0 && no !== g?.compartment,
          );
          return (
            <li key={seg.code}>
              <b style={{ fontFamily: "monospace" }}>{seg.code}</b> · {seg.name}:{" "}
              {mh(seg.budget - seg.earned)} of install left in{" "}
              {seg.open_compartments.map((no, i) => (
                <span key={no}>
                  {i > 0 && ", "}
                  {space(no)}
                </span>
              ))}
              .
              {heldSpaces.map((no) => {
                const w = (whyBySpace.get(no) ?? [])[0];
                if (!w) return null;
                return (
                  <span key={no}>
                    {" "}
                    And {space(no)} is itself refused today: <i>{w.reason}</i>
                    {w.remote && (
                      <> — the hold lives in {space(w.origin)} and reaches it.</>
                    )}{" "}
                    Cleared by <b style={{ color: C.bright }}>{w.clearing_authority}</b>
                    {w.earliest_clear ? `, earliest ${fmtClear(w.earliest_clear)}` : " on verification"}.
                  </span>
                );
              })}
            </li>
          );
        })}
        {incomplete.length > 4 && (
          <li style={{ color: C.dim }}>…and {incomplete.length - 4} more segments with install remaining.</li>
        )}
        {strandedSegs.length > 0 && (
          <li>
            <b style={{ color: C.warn }}>
              {strandedSegs.map((x) => x.code).join(", ")}{" "}
              {strandedSegs.length === 1 ? "is" : "are"} fully installed and still stuck
            </b>{" "}
            — finished work cannot be {verb} until everything upstream of it is complete. That is
            the stranding: {mh(detail.package.total_stranded_hours)} of done or doable work,
            waiting on the items above.
          </li>
        )}
      </ol>
      <p style={{ fontSize: 11, color: C.dim, margin: "9px 0 0" }}>
        Two different kinds of stuck, and they answer to different people: completion constraints
        respond to crew; authorization holds respond only to their clearing authority. Every claim
        above is the engine&apos;s, from the same evaluation every other screen reads.
      </p>
    </div>
  );
}

/** The waits-on map: segments as nodes, "cannot be tested until this
 *  completes" as arrows — read left to right, upstream to downstream. Built
 *  from `held_by`, so it draws what holds what NOW, not the as-designed
 *  topology: an arrow disappears the moment its upstream completes. */
function SegmentFlow({ detail, g }: { detail: PackageDetail; g: Governing | null }) {
  const segs = detail.segments;
  const byCode = new Map(segs.map((x) => [x.code, x]));
  const depth = new Map<string, number>();
  const depthOf = (code: string, guard: number): number => {
    if (guard > 16) return 0;
    const cached = depth.get(code);
    if (cached !== undefined) return cached;
    const seg = byCode.get(code);
    const d =
      !seg || seg.held_by.length === 0
        ? 0
        : 1 + Math.max(...seg.held_by.map((up) => depthOf(up, guard + 1)));
    depth.set(code, d);
    return d;
  };
  for (const x of segs) depthOf(x.code, 0);
  const cols = new Map<number, string[]>();
  for (const x of segs) {
    const d = depth.get(x.code) ?? 0;
    cols.set(d, [...(cols.get(d) ?? []), x.code]);
  }
  const NODE_W = 138;
  const NODE_H = 46;
  const COL_W = 178;
  const ROW_H = 58;
  const maxDepth = Math.max(...[...cols.keys()]);
  const maxRows = Math.max(...[...cols.values()].map((c) => c.length));
  const W = (maxDepth + 1) * COL_W + 30;
  const H = maxRows * ROW_H + 26;
  const pos = new Map<string, { x: number; y: number }>();
  for (const [d, codes] of cols) {
    codes.forEach((code, i) => pos.set(code, { x: 16 + d * COL_W, y: 14 + i * ROW_H }));
  }
  return (
    <div style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: C.well, marginBottom: 14 }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "7px 12px", borderBottom: `1px solid ${C.line}` }}>
        <b style={{ fontSize: 11.5 }}>Waits-on map</b>
        <span style={{ fontSize: 10.5, color: C.dim }}>
          an arrow means &quot;cannot be {detail.package.test_verb} until this completes&quot; —
          drawn from what holds what now, so arrows disappear as upstreams finish
        </span>
      </div>
      <div style={{ overflowX: "auto" }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: W * 0.8, maxWidth: W * 1.4, display: "block" }}>
          <defs>
            <marker id="waits-arrow" viewBox="0 0 8 8" refX={7} refY={4} markerWidth={6} markerHeight={6} orient="auto">
              <path d="M 0 0.5 L 8 4 L 0 7.5 z" fill={C.warn} />
            </marker>
          </defs>
          {segs.flatMap((x) =>
            x.held_by.map((up) => {
              const a = pos.get(up);
              const b = pos.get(x.code);
              if (!a || !b) return null;
              const x1 = a.x + NODE_W;
              const y1 = a.y + NODE_H / 2;
              const x2 = b.x;
              const y2 = b.y + NODE_H / 2;
              return (
                <path
                  key={`${up}->${x.code}`}
                  d={`M ${x1} ${y1} C ${x1 + 26} ${y1}, ${x2 - 26} ${y2}, ${x2 - 2} ${y2}`}
                  fill="none"
                  stroke={C.warn}
                  strokeWidth={1.2}
                  strokeDasharray="5 3"
                  opacity={0.8}
                  markerEnd="url(#waits-arrow)"
                >
                  <title>{`${x.code} waits on ${up}`}</title>
                </path>
              );
            }),
          )}
          {segs.map((x) => {
            const p = pos.get(x.code);
            if (!p) return null;
            const isGov = g !== null && x.open_compartments.includes(g.compartment);
            const border = x.testable ? C.ok : x.complete ? C.warn : C.line;
            const pct = x.budget > 0 ? x.earned / x.budget : 0;
            return (
              <g key={x.code}>
                <title>
                  {`${x.code} — ${x.name}\n${x.earned.toLocaleString()} / ${x.budget.toLocaleString()} MH` +
                    (x.testable
                      ? `\nREADY to be ${detail.package.test_verb}`
                      : x.complete
                        ? `\ncomplete — held upstream by ${x.held_by.join(", ")}`
                        : `\ninstall incomplete · in ${x.open_compartments.join(", ")}`) +
                    (isGov ? "\nContains the governing constraint." : "")}
                </title>
                <rect x={p.x} y={p.y} width={NODE_W} height={NODE_H} rx={7} fill={C.panel} stroke={isGov ? C.danger : border} strokeWidth={isGov ? 1.8 : 1.1} />
                <text x={p.x + 10} y={p.y + 17} fill={C.text} fontSize={11} fontWeight={700} fontFamily="monospace">
                  {x.code}
                </text>
                <text x={p.x + 10} y={p.y + 29} fill={C.dim} fontSize={8}>
                  {x.kind}
                </text>
                <text x={p.x + NODE_W - 8} y={p.y + 17} fill={x.testable ? C.ok : x.complete ? C.warn : C.subtle} fontSize={8.5} fontWeight={700} textAnchor="end">
                  {x.testable ? "READY" : x.complete ? "HELD" : `${Math.round(pct * 100)}%`}
                </text>
                <rect x={p.x + 9} y={p.y + NODE_H - 11} width={NODE_W - 18} height={3.5} rx={1.5} fill="rgba(148,163,184,0.15)" />
                <rect x={p.x + 9} y={p.y + NODE_H - 11} width={(NODE_W - 18) * Math.min(1, pct)} height={3.5} rx={1.5} fill={x.complete ? C.ok : "#3D6BFF"} />
              </g>
            );
          })}
        </svg>
      </div>
      <div style={{ display: "flex", gap: 14, flexWrap: "wrap", padding: "6px 12px 8px", fontSize: 10.5, color: C.dim }}>
        <span><span style={{ color: C.ok }}>▭</span> ready</span>
        <span><span style={{ color: C.warn }}>▭</span> complete, held upstream</span>
        <span><span style={{ color: C.subtle }}>▭</span> install in progress</span>
        <span><span style={{ color: C.danger }}>▭</span> contains the governing constraint</span>
        <span><span style={{ color: C.warn }}>⇢</span> waits on</span>
      </div>
    </div>
  );
}

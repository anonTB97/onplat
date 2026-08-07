// The Deck Explorer's upper two altitudes.
//
// The prototype's organising idea: one set of facts, read at three heights. A
// foreman wants a deck plan. A zone superintendent wants their zone's spaces
// ranked by what is costing the most. A project superintendent wants the hull on
// one screen and the name of whoever is holding up the most man-hours.
//
// Both boards render a rollup computed by wadl-plan and served whole. Nothing
// here re-adds, re-ranks or re-derives it — the ordering is the API's, so the
// zone a superintendent opens is the zone the board said was worst.

import { worstOf, type HeldSpace, type ReadinessGroup, type Rollup, type Tally } from "./api";
import { C, mh, READINESS_STYLE } from "./theme";

const DIM = C.dim;
const LINE = C.line;

/** Where a click on a board should land. */
export interface Drill {
  zone?: string;
  deck?: string;
  compartment?: string;
}

function Bar({ tally }: { tally: Tally }) {
  const total = Math.max(1, tally.spaces);
  const parts = [
    ["held", tally.held],
    ["go", tally.go],
    ["idle", tally.idle],
    ["latent", tally.latent],
  ] as const;
  return (
    <div style={{ display: "flex", height: 6, borderRadius: 3, overflow: "hidden", background: "#0b0c0e" }}>
      {parts.map(([k, n]) =>
        n === 0 ? null : (
          <div
            key={k}
            title={`${n} ${READINESS_STYLE[k].label} — ${READINESS_STYLE[k].gloss}`}
            style={{ width: `${(n / total) * 100}%`, background: READINESS_STYLE[k].fg }}
          />
        ),
      )}
    </div>
  );
}

function Tile({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: string }) {
  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 8, padding: "10px 12px", background: "#121316", minWidth: 152 }}>
      <div style={{ fontSize: 9.5, letterSpacing: 0.7, textTransform: "uppercase", color: DIM }}>{label}</div>
      <div style={{ fontSize: 21, fontWeight: 700, marginTop: 2, color: tone ?? C.text, fontVariantNumeric: "tabular-nums" }}>
        {value}
      </div>
      {sub && <div style={{ fontSize: 11, color: DIM, marginTop: 1 }}>{sub}</div>}
    </div>
  );
}

function Holders({ group }: { group: ReadinessGroup }) {
  if (group.holders.length === 0) {
    return (
      <p style={{ fontSize: 12, color: DIM, margin: "6px 0 0" }}>
        Nothing held here. That is a positive statement from the engine, not an
        absence of information.
      </p>
    );
  }
  return (
    <div style={{ marginTop: 6 }}>
      {group.holders.map((h) => (
        <div key={h.authority} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 12.5, padding: "2px 0" }}>
          <span style={{ fontVariantNumeric: "tabular-nums", color: READINESS_STYLE.held.fg, fontWeight: 700, minWidth: 82 }}>
            {mh(h.hours)}
          </span>
          <span>waiting on <b style={{ color: "#ccd1da" }}>{h.authority || "unnamed authority"}</b></span>
          <span style={{ color: DIM }}>
            ({h.spaces} {h.spaces === 1 ? "space" : "spaces"})
          </span>
        </div>
      ))}
    </div>
  );
}

function WorstSpaces({ spaces, onDrill }: { spaces: HeldSpace[]; onDrill: (d: Drill) => void }) {
  if (spaces.length === 0) return null;
  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ fontSize: 9.5, letterSpacing: 0.7, textTransform: "uppercase", color: DIM }}>
        Worst first — hours here, plus hours this hold strands elsewhere
      </div>
      {spaces.map((s) => (
        <button
          key={s.compartment_no}
          onClick={() => onDrill({ zone: s.zone, deck: s.deck_code, compartment: s.compartment_no })}
          style={{
            display: "block", width: "100%", textAlign: "left", marginTop: 5,
            background: READINESS_STYLE.held.bg, border: `1px solid ${READINESS_STYLE.held.border}`,
            borderRadius: 6, padding: "7px 9px", cursor: "pointer", font: "inherit", color: C.text,
          }}
        >
          <div style={{ display: "flex", gap: 8, alignItems: "baseline", flexWrap: "wrap" }}>
            <span style={{ fontFamily: "monospace", fontSize: 12 }}>{s.compartment_no}</span>
            <span style={{ fontSize: 11, color: DIM }}>{s.deck_code} · {s.zone}</span>
            <span style={{ marginLeft: "auto", fontSize: 11.5, fontVariantNumeric: "tabular-nums" }}>
              {mh(s.hours)} here
              {s.stranded_hours > 0 && (
                // The persuasive half. Hours in OTHER compartments that cannot be
                // tested until this one clears — the reason to send an authority
                // here first, and never added into a total because two upstream
                // holds can strand the same segment.
                <>
                  {" · "}
                  <b style={{ color: READINESS_STYLE.held.fg }}>strands {mh(s.stranded_hours)}</b>
                </>
              )}
            </span>
          </div>
          <div style={{ fontSize: 11, color: DIM, marginTop: 2 }}>
            {s.trades.join(" · ") || "no trade recorded"} — cleared by{" "}
            <b style={{ color: "#ccd1da" }}>{s.clearing_authority || "unnamed authority"}</b>
          </div>
        </button>
      ))}
    </div>
  );
}

/** Ship altitude: the hull on one screen, for a project superintendent. */
export function ShipBoard({ rollup, onDrill }: { rollup: Rollup; onDrill: (d: Drill) => void }) {
  const t = rollup.ship.tally;
  return (
    <div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
        <Tile
          label="Held"
          value={mh(t.held_hours)}
          sub={`${t.held} ${t.held === 1 ? "space" : "spaces"} — crews standing by`}
          tone={t.held_hours > 0 ? READINESS_STYLE.held.fg : undefined}
        />
        <Tile label="Workable today" value={mh(t.workable_hours)} sub={`${t.go} spaces open with work`} tone={READINESS_STYLE.go.fg} />
        <Tile label="Spare capacity" value={String(t.idle)} sub="authorized, nothing booked" />
        <Tile label="Closed, unbooked" value={String(t.latent)} sub="costs nothing today; do not plan into it" />
      </div>

      {rollup.unattributed_hours > 0 && (
        // Said out loud rather than folded into a total. These hours are real
        // and belong to no zone, so a board that quietly dropped them would
        // read cleaner than the hull actually is.
        <p style={{ fontSize: 11.5, color: READINESS_STYLE.held.fg, marginTop: 10, marginBottom: 0 }}>
          {mh(rollup.unattributed_hours)} of outstanding work names a compartment that is
          not in this hull's register, so it is in no zone below. That is a data-quality
          finding — a footprint authored against the class, a hull delta, or a mis-keyed
          placard — not a rounding difference.
        </p>
      )}

      <div style={{ marginTop: 14, border: `1px solid ${LINE}`, borderRadius: 8, padding: 14, background: "#121316" }}>
        <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: DIM }}>
          Who can release the hull
        </div>
        <Holders group={rollup.ship} />
        <WorstSpaces spaces={rollup.ship.worst_spaces} onDrill={onDrill} />
      </div>
    </div>
  );
}

/** Zone altitude: one card per zone, worst first — the API's ordering, kept. */
export function ZoneBoard({ rollup, onDrill }: { rollup: Rollup; onDrill: (d: Drill) => void }) {
  if (rollup.zones.length === 0) {
    return <p style={{ color: DIM, fontSize: 12.5 }}>This hull's register carries no zones.</p>;
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(340px, 1fr))", gap: 12 }}>
      {rollup.zones.map((z) => {
        const worst = worstOf(z.tally);
        const style = READINESS_STYLE[worst];
        return (
          <div key={z.key} style={{ border: `1px solid ${style.border}`, borderRadius: 8, padding: 13, background: "#121316" }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
              <button
                onClick={() => onDrill({ zone: z.key })}
                title="Open this zone's compartments"
                style={{ background: "none", border: "none", padding: 0, font: "inherit", fontSize: 15, fontWeight: 700, color: C.text, cursor: "pointer" }}
              >
                Zone {z.key}
              </button>
              <span style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, color: style.fg }}>{style.label}</span>
              <span style={{ marginLeft: "auto", fontSize: 11, color: DIM }}>
                {z.tally.spaces} {z.tally.spaces === 1 ? "space" : "spaces"}
              </span>
            </div>
            <div style={{ marginTop: 8 }}>
              <Bar tally={z.tally} />
            </div>
            <div style={{ display: "flex", gap: 12, marginTop: 8, fontSize: 11.5, flexWrap: "wrap" }}>
              <span style={{ color: READINESS_STYLE.held.fg, fontVariantNumeric: "tabular-nums" }}>
                {mh(z.tally.held_hours)} held
              </span>
              <span style={{ color: READINESS_STYLE.go.fg, fontVariantNumeric: "tabular-nums" }}>
                {mh(z.tally.workable_hours)} workable
              </span>
            </div>
            <Holders group={z} />
            <WorstSpaces spaces={z.worst_spaces} onDrill={onDrill} />
          </div>
        );
      })}
    </div>
  );
}

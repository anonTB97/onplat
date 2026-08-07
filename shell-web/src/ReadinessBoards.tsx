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

import {
  worstOf,
  type Deck,
  type DeckStateRow,
  type HeldSpace,
  type ReadinessGroup,
  type Rollup,
  type Tally,
} from "./api";
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

/**
 * Zone altitude's section view: the zone as a frame × deck grid.
 *
 * This is the view a zone superintendent actually works from, and the reason it
 * is a grid rather than a list: a zone is a *slice through the ship*, and the
 * question it exists to answer — "if I clear this space, what sits directly above
 * and below it?" — is a question about two axes. A list flattens one of them away.
 *
 * Frames run bow-right, matching every plate and the deck plan, so a planner
 * moving between the two views does not have to mirror the ship in their head.
 */
export function ZoneMatrix({
  zone,
  rows,
  decks,
  selected,
  toneOf,
  onSelect,
  cascade,
}: {
  zone: string;
  rows: DeckStateRow[];
  decks: Deck[];
  selected: string | null;
  toneOf: (r: DeckStateRow) => { fg: string; bg: string; border: string };
  onSelect: (compartment: string) => void;
  /** Compartments on the selected space's cascade path. */
  cascade: Set<string>;
}) {
  const inZone = rows.filter((r) => r.compartment.zone === zone);
  const framed = inZone.filter((r) => r.compartment.frame !== null);
  if (framed.length === 0) {
    return (
      <p style={{ color: DIM, fontSize: 12.5 }}>
        No compartment in {zone} carries a frame station, so there is nothing to lay
        out against the ship&rsquo;s length.
      </p>
    );
  }

  const frames = framed.map((r) => r.compartment.frame as number);
  const lo = Math.min(...frames);
  const hi = Math.max(...frames);
  // Buckets wide enough that a column is a readable band of the ship rather than
  // one frame — a zone spanning sixty frames would otherwise be sixty columns.
  const COLS = Math.min(8, Math.max(2, hi - lo + 1));
  const width = Math.max(1, (hi - lo + 1) / COLS);
  const columns = Array.from({ length: COLS }, (_, i) => ({
    from: Math.round(lo + i * width),
    to: Math.round(lo + (i + 1) * width) - 1,
  }));
  // Bow on the right, so the highest frames are the leftmost column.
  columns.reverse();

  const deckRows = decks
    .filter((d) => inZone.some((r) => r.compartment.deck_code === d.code))
    .sort((a, b) => a.ordinal - b.ordinal);

  // A column the cascade passes through on more than one deck IS the deck
  // penetration, drawn. This grid is the clearest place in the product to see one
  // — three spaces stacked in one column at the same frame is the hazard's route
  // through the ship — so the column is tinted rather than left to be spotted.
  const penetrated = new Set(
    columns
      .filter((c) => {
        const decksHit = new Set(
          framed
            .filter(
              (r) =>
                cascade.has(r.compartment.compartment_no) &&
                (r.compartment.frame as number) >= c.from &&
                (r.compartment.frame as number) <= c.to,
            )
            .map((r) => r.compartment.deck_code),
        );
        return decksHit.size > 1;
      })
      .map((c) => c.from),
  );

  const cell = (deckCode: string, from: number, to: number) =>
    framed.filter(
      (r) =>
        r.compartment.deck_code === deckCode &&
        (r.compartment.frame as number) >= from &&
        (r.compartment.frame as number) <= to,
    );

  return (
    <div style={{ border: `1px solid ${LINE}`, borderRadius: 8, background: "#121316", overflow: "hidden" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "baseline", padding: "8px 11px", borderBottom: `1px solid ${LINE}`, flexWrap: "wrap" }}>
        <span style={{ fontSize: 12.5, fontWeight: 700 }}>Zone {zone} — section</span>
        <span style={{ fontSize: 10.5, color: DIM }}>
          frame × deck · Fr {lo}–{hi} · bow right
        </span>
        <span style={{ marginLeft: "auto", fontSize: 10.5, color: DIM }}>
          {framed.length} of {inZone.length} spaces placed
        </span>
      </div>

      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 520 }}>
          <thead>
            <tr>
              <th style={{ ...headCell, textAlign: "left", minWidth: 96 }}>Deck ↓</th>
              {columns.map((c) => (
                <th
                  key={c.from}
                  style={{
                    ...headCell,
                    background: penetrated.has(c.from) ? "rgba(167,139,250,0.12)" : undefined,
                    color: penetrated.has(c.from) ? "#c4b5fd" : headCell.color,
                  }}
                  title={penetrated.has(c.from) ? "The cascade crosses decks at these frames" : undefined}
                >
                  Fr {c.from === c.to ? c.from : `${c.from}–${c.to}`}
                  {penetrated.has(c.from) && " ↕"}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {deckRows.map((d) => (
              <tr key={d.code}>
                <th style={{ ...bodyCell, textAlign: "left", fontWeight: 600, fontSize: 11, color: C.text }}>
                  {d.label}
                </th>
                {columns.map((c) => {
                  const here = cell(d.code, c.from, c.to);
                  return (
                    <td
                      key={c.from}
                      style={{
                        ...bodyCell,
                        background: penetrated.has(c.from) ? "rgba(167,139,250,0.07)" : undefined,
                      }}
                    >
                      {here.length === 0 ? (
                        // An empty cell is a real statement — no space of this
                        // zone on this deck at these frames — so it is drawn as
                        // absence rather than left blank and ambiguous.
                        <span style={{ color: "#353842", fontSize: 11 }}>·</span>
                      ) : (
                        here.map((r) => {
                          const tone = toneOf(r);
                          const isSel = r.compartment.compartment_no === selected;
                          return (
                            <button
                              key={r.compartment.compartment_no}
                              onClick={() => onSelect(r.compartment.compartment_no)}
                              title={`${r.compartment.name} — ${r.state}${
                                r.remaining_hours > 0 ? ` · ${mh(r.remaining_hours)} left` : ""
                              }`}
                              style={{
                                display: "block", width: "100%", marginBottom: 2, cursor: "pointer",
                                font: "inherit", fontSize: 10, fontFamily: "monospace",
                                padding: "3px 4px", borderRadius: 4,
                                background: tone.bg, color: tone.fg,
                                border: `1px solid ${
                                  isSel ? C.accent : cascade.has(r.compartment.compartment_no) ? "#c4b5fd" : tone.border
                                }`,
                                borderWidth: isSel || cascade.has(r.compartment.compartment_no) ? 2 : 1,
                              }}
                            >
                              {r.compartment.compartment_no}
                              {r.readiness === "held" && (
                                <span style={{ color: READINESS_STYLE.held.fg }}> ⚑</span>
                              )}
                            </button>
                          );
                        })
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {penetrated.size > 0 && (
        <p style={{ fontSize: 10.5, color: "#c4b5fd", padding: "7px 11px", margin: 0, borderTop: `1px solid ${LINE}` }}>
          ↕ marks frames where the selected space&rsquo;s cascade crosses a deck. Those
          columns are the deck penetration — the part a single deck sheet cannot show.
        </p>
      )}
      {framed.length < inZone.length && (
        <p style={{ fontSize: 10.5, color: DIM, padding: "7px 11px", margin: 0, borderTop: `1px solid ${LINE}` }}>
          {inZone.length - framed.length} space
          {inZone.length - framed.length === 1 ? "" : "s"} in this zone carry no frame
          station and are not in the grid.
        </p>
      )}
    </div>
  );
}

const headCell: React.CSSProperties = {
  fontSize: 9.5,
  letterSpacing: 0.5,
  textTransform: "uppercase",
  color: C.dim,
  fontWeight: 600,
  padding: "5px 6px",
  borderBottom: `1px solid ${C.line}`,
  borderRight: `1px solid ${C.line}`,
  whiteSpace: "nowrap",
};

const bodyCell: React.CSSProperties = {
  padding: 4,
  borderBottom: `1px solid ${C.line}`,
  borderRight: `1px solid ${C.line}`,
  verticalAlign: "top",
  textAlign: "center",
};

/** The holders and worst spaces for one group — reused by the zone section. */
export function ZoneHolders({ group, onDrill }: { group: ReadinessGroup; onDrill: (d: Drill) => void }) {
  return (
    <>
      <Holders group={group} />
      <WorstSpaces spaces={group.worst_spaces} onDrill={onDrill} />
    </>
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

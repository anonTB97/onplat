// The Deck Explorer's left selector rail.
//
// The prototype keeps a persistent rail beside the canvas whose *contents change
// with the altitude*: decks when you are working one deck, sections when you are
// working a zone, and a leadership list when you are looking at the hull. That is
// not decoration — it is what makes the altitude control feel like moving between
// heights rather than swapping unrelated screens, because the thing you pick from
// is always "the next level down from where you are standing".
//
// Every row is ranked or ordered by something real, and every row carries the
// number that justifies its position. A rail of bare labels would make the user
// click through decks to find out where the problem is.

import { useState } from "react";
import { worstOf, type Deck, type DeckStateRow, type Rollup } from "./api";
import { C, mh, READINESS_STYLE } from "./theme";

const DIM = C.dim;
const LINE = C.line;

const RAIL_W = 186;

function Head({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "11px 12px 8px",
        fontSize: 9.5,
        fontWeight: 600,
        letterSpacing: 0.8,
        textTransform: "uppercase",
        color: DIM,
        borderBottom: `1px solid ${LINE}`,
      }}
    >
      {children}
    </div>
  );
}

function Row({
  selected,
  accent,
  onClick,
  title,
  children,
}: {
  selected: boolean;
  accent?: string;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      title={title}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        font: "inherit",
        color: C.text,
        cursor: "pointer",
        padding: "7px 11px",
        background: selected ? C.raised : "transparent",
        border: "none",
        // The accent is a left edge rather than a full border: it reads as "you
        // are here" down a long list without boxing every row.
        borderLeft: `3px solid ${selected ? C.accent : (accent ?? "transparent")}`,
        borderBottom: `1px solid ${LINE}`,
      }}
    >
      {children}
    </button>
  );
}

function Badge({ n, tone }: { n: number; tone: string }) {
  return (
    <span
      style={{
        minWidth: 16,
        height: 16,
        borderRadius: 8,
        padding: "0 4px",
        background: tone,
        color: "#0b0c0e",
        fontSize: 10,
        fontWeight: 700,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {n}
    </span>
  );
}

export function SelectorRail({
  altitude,
  decks,
  rows,
  rollup,
  selectedDeck,
  zoneFilter,
  onDeck,
  onZone,
  load,
  horizonLabel,
}: {
  altitude: "ship" | "zone" | "compartment";
  decks: Deck[];
  rows: DeckStateRow[];
  rollup: Rollup | null;
  selectedDeck: string | null;
  zoneFilter: string | null;
  onDeck: (code: string) => void;
  onZone: (zone: string) => void;
  /** Scheduled man-hours per space inside the reading window, when the
   *  caller wants the rail to answer for the horizon too. */
  load?: Map<string, { hours: number; count: number; refused: number }>;
  horizonLabel?: string;
}) {
  const [showEmpty, setShowEmpty] = useState(false);
  const shell: React.CSSProperties = {
    flex: `0 0 ${RAIL_W}px`,
    width: RAIL_W,
    alignSelf: "flex-start",
    border: `1px solid ${LINE}`,
    borderRadius: 8,
    background: "#121316",
    overflow: "hidden",
  };

  if (altitude === "compartment") {
    // Decks the register says nothing about are folded under one row. On a
    // small register they outnumber the decks with data, and eleven rows of
    // "plate only" was the first thing a new reader saw. The row says how many
    // and why, and opens to the plates on request — nothing is hidden, it is
    // summarised. A selected deck is always shown, folded or not.
    const withData = decks.filter((d) => d.compartment_count > 0);
    const plateOnly = decks.filter((d) => d.compartment_count === 0);
    const selectedIsFolded = plateOnly.some((d) => d.code === selectedDeck);
    const shownDecks = showEmpty || selectedIsFolded || withData.length === 0 ? decks : withData;
    return (
      <div style={shell}>
        <Head>Decks · top → btm</Head>
        {plateOnly.length > 0 && withData.length > 0 && !selectedIsFolded && (
          <Row
            selected={false}
            onClick={() => setShowEmpty(!showEmpty)}
            title="Decks whose drawing is on file but whose compartments are not in this hull's register yet — the plate opens, nothing is pinned on it"
          >
            <div style={{ fontSize: 11, color: DIM }}>
              {showEmpty ? "▾" : "▸"} {plateOnly.length} deck{plateOnly.length === 1 ? "" : "s"} without register data · plates only
            </div>
          </Row>
        )}
        {shownDecks.map((d) => {
          const onThis = rows.filter((r) => r.compartment.deck_code === d.code);
          const held = onThis.filter((r) => r.readiness === "held").length;
          const restricted = onThis.filter((r) => r.state !== "ALLOW").length;
          // The horizon's answer per deck: what the schedule actually puts
          // here inside the reading window.
          const deckLoad = load
            ? onThis.reduce(
                (acc, r) => {
                  const l = load.get(r.compartment.compartment_no);
                  if (l) {
                    acc.hours += l.hours;
                    acc.count += l.count;
                    acc.refused += l.refused;
                  }
                  return acc;
                },
                { hours: 0, count: 0, refused: 0 },
              )
            : null;
          return (
            <Row
              key={d.code}
              selected={d.code === selectedDeck}
              onClick={() => onDeck(d.code)}
              title={`${d.label} — ${d.compartment_count} compartments in the register`}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>{d.label}</span>
                {held > 0 && <Badge n={held} tone={READINESS_STYLE.held.fg} />}
              </div>
              <div style={{ fontSize: 10.5, color: DIM, marginTop: 1 }}>
                {d.compartment_count === 0 ? (
                  // Said, not hidden. The deck exists and its drawing is worth
                  // opening; what is missing is our register data, not the deck.
                  <span>no register data · plate only</span>
                ) : (
                  <>
                    {d.compartment_count} space{d.compartment_count === 1 ? "" : "s"}
                    {restricted > 0 && ` · ${restricted} restricted`}
                    {deckLoad && deckLoad.count > 0 && (
                      <div
                        title={`Scheduled on this deck inside the reading window (this ${horizonLabel ?? "window"})`}
                        style={{ color: deckLoad.refused > 0 ? READINESS_STYLE.held.fg : "#8b93a2" }}
                      >
                        this {horizonLabel}: {deckLoad.count} act · {Math.round(deckLoad.hours).toLocaleString()} MH
                        {deckLoad.refused > 0 && ` · ${deckLoad.refused} refused`}
                      </div>
                    )}
                  </>
                )}
              </div>
            </Row>
          );
        })}
      </div>
    );
  }

  if (altitude === "zone") {
    const zones = rollup?.zones ?? [];
    return (
      <div style={shell}>
        <Head>Sections · worst first</Head>
        {zones.length === 0 && (
          <p style={{ fontSize: 11.5, color: DIM, padding: "9px 11px", margin: 0 }}>
            This hull&rsquo;s register carries no zones.
          </p>
        )}
        {zones.map((z) => {
          const tone = READINESS_STYLE[worstOf(z.tally)];
          return (
            <Row
              key={z.key}
              selected={z.key === zoneFilter}
              accent={tone.fg}
              onClick={() => onZone(z.key)}
              title={tone.gloss}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>Zone {z.key}</span>
                <span style={{ fontSize: 9.5, fontWeight: 700, color: tone.fg, letterSpacing: 0.5 }}>
                  {tone.label}
                </span>
              </div>
              <div style={{ fontSize: 10.5, color: DIM, marginTop: 1 }}>
                {z.tally.spaces} space{z.tally.spaces === 1 ? "" : "s"}
                {z.tally.held_hours > 0 && (
                  <>
                    {" · "}
                    <span style={{ color: READINESS_STYLE.held.fg }}>{mh(z.tally.held_hours)} held</span>
                  </>
                )}
              </div>
              {z.holders[0] && (
                <div style={{ fontSize: 10, color: DIM, marginTop: 1 }}>
                  waiting on {z.holders[0].authority}
                </div>
              )}
            </Row>
          );
        })}
      </div>
    );
  }

  // Ship altitude. The prototype lists construction directors here; this hull's
  // register has no director or superintendent assignments, so inventing four
  // names would be the one thing on this screen that is not a fact. Decks ranked
  // by hours held answers the same question a director list is asked — "whose
  // patch is the problem" — out of data that exists.
  const byPain = rollup?.decks ?? [];
  return (
    <div style={shell}>
      <Head>Decks · by hours held</Head>
      {byPain.length === 0 && (
        <p style={{ fontSize: 11.5, color: DIM, padding: "9px 11px", margin: 0 }}>Reading the hull…</p>
      )}
      {byPain.map((g) => {
        const tone = READINESS_STYLE[worstOf(g.tally)];
        const label = decks.find((d) => d.code === g.key)?.label ?? g.key;
        return (
          <Row key={g.key} selected={false} accent={tone.fg} onClick={() => onDeck(g.key)} title={tone.gloss}>
            <div style={{ fontSize: 12.5, fontWeight: 600 }}>{label}</div>
            <div style={{ fontSize: 10.5, color: DIM, marginTop: 1 }}>
              {g.tally.held_hours > 0 ? (
                <span style={{ color: READINESS_STYLE.held.fg }}>{mh(g.tally.held_hours)} held</span>
              ) : (
                <span>{mh(g.tally.workable_hours)} workable</span>
              )}
            </div>
          </Row>
        );
      })}
      <p style={{ fontSize: 10, color: "#5a6070", padding: "8px 11px", margin: 0 }}>
        The prototype lists construction directors here. This register carries no
        director or superintendent assignments, so this ranks what it does have.
      </p>
    </div>
  );
}

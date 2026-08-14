// The shell's chrome: classification markings, top bar, guardrail strip,
// breadcrumb and module rail.
//
// This is not trim. In a yard the chrome is what makes a screen safe to put on a
// wall: the handling markings say what may leave the room, the guardrail strip
// says the tool advises and does not act, the context selector says which hull
// you are looking at, and the persona says which of eight jobs you are doing.
// Getting the module wrong is a bad afternoon; getting the chrome wrong is a
// screenshot in the wrong hands or a decision taken against the wrong hull.

import { useEffect, useMemo, useRef, useState } from "react";
import type { DeckStateRow, Issue, VesselSummary, WhoAmI } from "./api";
import { claim, fixSpace, KIND } from "./IssuesBoard";
import type { Horizon } from "./TimeControl";
import { C, mh } from "./theme";

const DIM = C.dim;
const LINE = C.line;

/**
 * Handling markings, fixed to the top and bottom of the viewport.
 *
 * Both edges, and fixed rather than scrolled, because the whole point is that a
 * photograph or screenshot of any part of this tool carries its markings. A
 * banner that scrolls off the top is a banner that is absent from the screenshot
 * somebody actually takes.
 *
 * Set MARKINGS to the deploying organisation's own handling caveats — these are
 * the prototype's, and they are a statement about this build: the deck plates are
 * a public US Navy document and every number in the demo is notional.
 */
const MARKINGS = [
  "BigBear.ai Proprietary",
  "Competition Sensitive",
  "All Represented Information is Open Sourced",
];

export const MARKING_H = 18;

export function ClassificationBanner({ edge }: { edge: "top" | "bottom" }) {
  return (
    <div
      style={{
        position: "fixed",
        left: 0,
        right: 0,
        [edge]: 0,
        height: MARKING_H,
        zIndex: 50,
        background: "#191a1f",
        borderTop: edge === "bottom" ? `1px solid ${LINE}` : undefined,
        borderBottom: edge === "top" ? `1px solid ${LINE}` : undefined,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 8,
        fontSize: 9.5,
        letterSpacing: 0.8,
        textTransform: "uppercase",
        color: "#8b93a3",
        fontWeight: 600,
        pointerEvents: "none",
      }}
    >
      {MARKINGS.map((m, i) => (
        <span key={m} style={{ display: "flex", gap: 8 }}>
          {i > 0 && <span style={{ color: C.faint }}>|</span>}
          {m}
        </span>
      ))}
    </div>
  );
}

/* ---------------------------------------------------------------- personas */

/**
 * The eight personas, and the altitude each one lands on.
 *
 * Straight from the prototype, and the mapping is the interesting part: an
 * executive opens the hull, a zone manager opens their section, a planner opens a
 * deck. Same facts, and the tool guesses the height from the job rather than
 * making everyone navigate down from the top every morning.
 */
export type Altitude = "ship" | "zone" | "compartment";

export interface Persona {
  name: string;
  focus: string;
  /** The height the Deck Explorer opens at — hull, zone or compartment. */
  altitude: Altitude;
  /**
   * The time resolution this persona reads at.
   *
   * The same argument as `altitude`, on the other axis. An executive should not
   * arrive at an hour-by-hour scrubber and a production super should not arrive
   * at a month-by-month one; both would have to navigate away from it every
   * morning. Space and time are the two dimensions of the same question — where
   * and when is work being held up — so a persona names its opening point in
   * both.
   */
  horizon: Horizon;
}

export const PERSONAS: Persona[] = [
  { name: "Planner", focus: "Conflicts & sequence", altitude: "compartment", horizon: "week" },
  { name: "Zone Manager", focus: "Your zone's muster", altitude: "zone", horizon: "week" },
  { name: "Production Super", focus: "Shift plan", altitude: "zone", horizon: "shift" },
  { name: "Project Super", focus: "Availability health", altitude: "ship", horizon: "month" },
  { name: "IPT", focus: "Mitigation decisions", altitude: "compartment", horizon: "month" },
  {
    name: "Program Office",
    focus: "Risk / on-time confidence",
    altitude: "ship",
    horizon: "availability",
  },
  {
    name: "Material Manager",
    focus: "Material readiness",
    altitude: "compartment",
    horizon: "week",
  },
  {
    name: "Executive",
    focus: "Throughput / dock utilization",
    altitude: "ship",
    horizon: "availability",
  },
];

const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .map((w) => w[0])
    .join("")
    .slice(0, 2)
    .toUpperCase();

/* -------------------------------------------------------------------- icons */

const ic = (d: string) => (
  <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
    {d.split("|").map((path) => (
      <path key={path} d={path} />
    ))}
  </svg>
);

export const ICONS: Record<string, React.ReactNode> = {
  dailyOps: ic("M12 7v5l3 2|M12 3a9 9 0 100 18 9 9 0 000-18z"),
  // The prototype's own Deck Explorer glyph: stacked decks.
  deckExplorer: ic("M12 3l9 5-9 5-9-5 9-5z|M3 12l9 5 9-5|M3 16l9 5 9-5"),
  sequenceBoard: ic("M4 5h10|M4 12h16|M4 19h7|M18 3v4|M8 10v4|M14 17v4"),
  workOrders: ic("M5 4h11l3 3v13H5z|M9 10h6|M9 14h6"),
  conflicts: ic("M12 4l9 16H3z|M12 10v4|M12 17h.01"),
  portfolio: ic("M4 18l8-3 8 3|M12 4v11|M7 9h10"),
  distPackages: ic("M6 6h4v4H6z|M14 14h4v4h-4z|M10 8h4v6"),
  cascade: ic("M12 3v5|M12 8l-6 5|M12 8l6 5|M6 13v5|M18 13v5"),
  // An open manual: the page you read before you run the yard.
  guide: ic("M12 5c-2-1.4-4.5-2-7-2v16c2.5 0 5 .6 7 2 2-1.4 4.5-2 7-2V3c-2.5 0-5 .6-7 2z|M12 5v16"),
  // A chained record: the page, and the links down its spine.
  ledger: ic("M6 3h12v18H6z|M10 8h5|M10 12h5|M10 16h3|M8 6v0.01|M8 10v0.01|M8 14v0.01|M8 18v0.01"),
  // A database cylinder: the documents the screens are built from.
  sources: ic("M4 6.5c0-1.4 3.6-2.5 8-2.5s8 1.1 8 2.5S16.4 9 12 9 4 7.9 4 6.5z|M4 6.5v11c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5v-11|M4 12c0 1.4 3.6 2.5 8 2.5s8-1.1 8-2.5"),
};

/* ------------------------------------------------------------------- topbar */

function Hamburger() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  );
}

const menuPanel: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 6px)",
  right: 0,
  zIndex: 40,
  minWidth: 300,
  background: "#15171c",
  border: `1px solid ${LINE}`,
  borderRadius: 8,
  boxShadow: "0 18px 40px rgba(0,0,0,0.55)",
  overflow: "hidden",
};

const menuHead: React.CSSProperties = {
  padding: "9px 12px",
  fontSize: 9.5,
  letterSpacing: 0.8,
  textTransform: "uppercase",
  color: DIM,
  borderBottom: `1px solid ${LINE}`,
};

/**
 * A hull the shell can be pointed at.
 *
 * Deliberately NOT just what the API returned. Two of the demo hulls are
 * in-tenant but unassigned, and pointing the shell at one is how the RBAC refusal
 * becomes visible — the server's 404 and the OUT OF SCOPE banner. A picker that
 * only offered hulls that work would quietly delete the most important thing this
 * shell demonstrates about itself.
 */
export interface HullChoice {
  id: string;
  label: string;
  vessel?: VesselSummary;
}

/** One search hit — a compartment the caller can jump to. */
export interface SearchHit {
  compartment: string;
  name: string;
  deck: string;
  zone: string;
  detail: string;
}

export function TopBar({
  onCollapse,
  hulls,
  selected,
  onSelectVessel,
  hullLabel,
  persona,
  onPersona,
  rows,
  issues,
  onJump,
  onOpenIssues,
  outOfScope,
  who,
}: {
  onCollapse: () => void;
  hulls: HullChoice[];
  selected: string;
  onSelectVessel: (id: string) => void;
  hullLabel: string;
  persona: Persona;
  onPersona: (p: Persona) => void;
  rows: DeckStateRow[];
  /** The hull's issue board, ranked — the alert bell's currency. */
  issues: Issue[];
  onJump: (compartment: string) => void;
  /** Opens the Issues board (Conflicts & Risk). */
  onOpenIssues: () => void;
  outOfScope: boolean;
  /** Server-resolved identity; null while loading or if the read failed. */
  who: WhoAmI | null;
}) {
  const [menu, setMenu] = useState<"context" | "persona" | "alerts" | null>(null);
  const [query, setQuery] = useState("");
  /** The keyboard-highlighted search hit; Enter takes it, arrows move it. */
  const [hitIdx, setHitIdx] = useState(0);
  const box = useRef<HTMLElement>(null);
  const searchBox = useRef<HTMLDivElement>(null);

  // Click-away and Esc. A menu that only closes by clicking the thing that
  // opened it is the kind of small wrongness that makes a tool feel unfinished.
  useEffect(() => {
    if (!menu && query === "") return undefined;
    const away = (e: MouseEvent) => {
      if (menu && box.current && !box.current.contains(e.target as Node)) setMenu(null);
      // The search results panel obeys the same rule as every menu: a click
      // anywhere else dismisses it.
      if (query !== "" && searchBox.current && !searchBox.current.contains(e.target as Node)) {
        setQuery("");
      }
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenu(null);
    };
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", key);
    };
  }, [menu, query]);

  // Search over what is loaded: placard number, space name, zone, and the work
  // booked in it. Frames match on "fr 164" or bare "164", because that is how a
  // frame gets said out loud on a deck plate.
  const hits: SearchHit[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    const frame = /^(?:fr\s*)?(\d{1,3})$/.exec(q);
    return rows
      .filter((r) => {
        const c = r.compartment;
        if (frame && c.frame !== null) return String(c.frame) === frame[1];
        return (
          c.compartment_no.toLowerCase().includes(q) ||
          c.name.toLowerCase().includes(q) ||
          c.zone.toLowerCase().includes(q) ||
          r.work_order_codes.some((w) => w.toLowerCase().includes(q)) ||
          r.trades.some((t) => t.toLowerCase().includes(q))
        );
      })
      .slice(0, 8)
      .map((r) => ({
        compartment: r.compartment.compartment_no,
        name: r.compartment.name,
        deck: r.compartment.deck_code,
        zone: r.compartment.zone,
        detail:
          r.readiness === "held"
            ? `${r.state} · ${mh(r.remaining_hours)} held`
            : r.work_order_codes.join(", ") || r.state,
      }));
  }, [query, rows]);

  // The bell counts issues, not held spaces: the issue board already covers
  // "held with crews booked" and adds the kinds a held-space count is blind to
  // — broken plans, compound holds, strandings. One currency for "what needs a
  // decision", shared with the Conflicts & Risk badge.
  const alerts = issues.length + (outOfScope ? 1 : 0);

  return (
    <header
      ref={box}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 14,
        padding: "0 14px",
        height: 52,
        background: "#191a1f",
        borderBottom: `1px solid ${LINE}`,
      }}
    >
      <button onClick={onCollapse} title="Toggle module rail" aria-label="Toggle module rail" style={iconBtn}>
        <Hamburger />
      </button>

      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <div style={{ fontSize: 14.5, fontWeight: 700, letterSpacing: -0.2, whiteSpace: "nowrap" }}>
          Shipyard AI
          <span style={{ fontSize: 8, verticalAlign: "super", color: DIM }}>™</span>{" "}
          <span style={{ color: C.accent }}>Onboard</span>
        </div>
      </div>

      {/* global search */}
      <div ref={searchBox} style={{ position: "relative", flex: "1 1 320px", maxWidth: 520 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 7, background: C.well, border: `1px solid ${LINE}`, borderRadius: 7, padding: "0 9px", height: 32 }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.subtle} strokeWidth={1.8}>
            <circle cx="11" cy="11" r="7" />
            <line x1="21" y1="21" x2="16.5" y2="16.5" strokeLinecap="round" />
          </svg>
          <input
            type="text"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setHitIdx(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "Escape") setQuery("");
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setHitIdx((i) => Math.min(i + 1, hits.length - 1));
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setHitIdx((i) => Math.max(i - 1, 0));
              }
              if (e.key === "Enter" && hits[hitIdx]) {
                onJump((hits[hitIdx] as SearchHit).compartment);
                setQuery("");
              }
            }}
            placeholder="Search compartments, spaces, zones, work items, frames…"
            aria-label="Search the hull"
            title="Search everything loaded for this hull — compartment numbers, names, zones, work items, frame stations (try “fr 164”). ↑↓ to pick, Enter to jump."
            style={{ flex: 1, background: "transparent", border: "none", color: C.text, font: "inherit", fontSize: 12 }}
          />
          {query && (
            <span style={{ fontSize: 10.5, color: DIM, whiteSpace: "nowrap" }}>
              {hits.length || "no"} match{hits.length === 1 ? "" : "es"}
            </span>
          )}
        </div>
        {hits.length > 0 && (
          <div style={{ ...menuPanel, left: 0, right: "auto", minWidth: "100%" }}>
            {hits.map((h) => (
              <button
                key={h.compartment}
                onClick={() => {
                  onJump(h.compartment);
                  setQuery("");
                }}
                title="Open this space on the deck plan"
                style={{ display: "block", width: "100%", textAlign: "left", padding: "7px 11px", background: hits.indexOf(h) === hitIdx ? C.raised : "transparent", border: "none", borderBottom: `1px solid ${LINE}`, cursor: "pointer", font: "inherit", color: C.text }}
              >
                <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span style={{ fontFamily: "monospace", fontSize: 12 }}>{h.compartment}</span>
                  <span style={{ fontSize: 11, color: DIM }}>{h.deck} · {h.zone}</span>
                  <span style={{ marginLeft: "auto", fontSize: 10.5, color: DIM }}>{h.detail}</span>
                </div>
                <div style={{ fontSize: 11, color: C.bright }}>{h.name}</div>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* context selector — which hull, and what else is in the portfolio */}
      <div style={{ position: "relative", marginLeft: "auto" }}>
        <button
          onClick={() => setMenu(menu === "context" ? null : "context")}
          title="Which hull every screen answers for — switch it here"
          style={clusterBtn}
          aria-expanded={menu === "context"}
        >
          <span style={{ textAlign: "left" }}>
            <span style={{ display: "block", fontSize: 8.5, letterSpacing: 0.8, textTransform: "uppercase", color: DIM }}>
              In focus
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600 }}>
              {hullLabel}
              {outOfScope && <span style={{ width: 6, height: 6, borderRadius: 3, background: C.danger }} />}
            </span>
          </span>
          <Chevron />
        </button>
        {menu === "context" && (
          <div style={menuPanel}>
            <div style={menuHead}>Portfolio — availabilities</div>
            {hulls.length === 0 && (
              <p style={{ fontSize: 11.5, color: DIM, padding: "9px 12px", margin: 0 }}>
                No hulls configured for this surface.
              </p>
            )}
            {hulls.map((h) => {
              const v = h.vessel;
              const isSel = h.id === selected;
              return (
                <button
                  key={h.id}
                  onClick={() => {
                    onSelectVessel(h.id);
                    setMenu(null);
                  }}
                  style={{
                    display: "block", width: "100%", textAlign: "left", padding: "8px 12px",
                    background: isSel ? C.raised : "transparent",
                    border: "none", borderBottom: `1px solid ${LINE}`,
                    borderLeft: `3px solid ${isSel ? C.accent : v ? "transparent" : C.danger}`,
                    cursor: "pointer", font: "inherit", color: C.text,
                  }}
                >
                  <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                    <span style={{ fontFamily: "monospace", fontSize: 12, color: v ? C.accent : C.danger }}>
                      {v ? v.hull_no : h.label.split(" ·")[0]}
                    </span>
                    <span style={{ fontSize: 11.5, fontWeight: 600 }}>
                      {v ? v.availability_code : ""}
                    </span>
                    <span style={{ marginLeft: "auto", fontSize: 10, color: v ? DIM : C.danger }}>
                      {v ? v.confidence : "not assigned"}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: DIM }}>
                    {v ? `${v.name} · ${v.class_code}` : "the API refuses this hull's data — RBAC, not an error"}
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* persona — sets the altitude the Deck Explorer opens at */}
      <div style={{ position: "relative" }}>
        <button
          title="Your job sets where screens open — altitude and time horizon — nothing else changes" onClick={() => setMenu(menu === "persona" ? null : "persona")} style={clusterBtn} aria-expanded={menu === "persona"}>
          <span style={{ width: 26, height: 26, borderRadius: 13, background: C.raised, color: C.accent, fontSize: 10.5, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center" }}>
            {initialsOf(persona.name)}
          </span>
          <span style={{ textAlign: "left" }}>
            <span style={{ display: "block", fontSize: 8.5, letterSpacing: 0.8, textTransform: "uppercase", color: DIM }}>
              Persona
            </span>
            <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, whiteSpace: "nowrap" }}>
              {persona.name}
              {/* The trust boundary, worn on the sleeve: development identity
                  is amber and says so, so a screenshot can never pass a shim
                  session off as an authenticated one. Proxy mode shows nothing
                  here — authenticated is the unremarkable state. */}
              {who?.identity_mode === "dev-headers" && (
                <span
                  title="Development identity shim — headers trusted as given. In production this session would come through the CAC-authenticated proxy."
                  style={{ fontSize: 8, fontWeight: 700, letterSpacing: 0.6, padding: "1.5px 5px", borderRadius: 3, color: C.warn, background: "rgba(245,158,11,0.12)", border: "1px solid rgba(245,158,11,0.5)" }}
                >
                  DEV ID
                </span>
              )}
            </span>
          </span>
          <Chevron />
        </button>
        {menu === "persona" && (
          <div style={menuPanel}>
            {/* Who the SERVER says you are — the resolved scope every query
                actually runs under, not an echo of what the shell sent. */}
            <div style={{ padding: "9px 12px", borderBottom: `1px solid ${LINE}` }}>
              <div style={{ fontSize: 9.5, letterSpacing: 0.8, textTransform: "uppercase", color: DIM, marginBottom: 4 }}>
                Signed in — as the server resolves it
              </div>
              {who ? (
                <>
                  <div style={{ fontSize: 11, color: C.bright }}>
                    org <span style={{ fontFamily: "monospace", fontSize: 10.5 }}>…{who.org.slice(-12)}</span>
                    {" · "}
                    {who.assigned_vessels.length} hull{who.assigned_vessels.length === 1 ? "" : "s"} assigned
                  </div>
                  <div style={{ fontSize: 10.5, marginTop: 3, color: who.identity_mode === "dev-headers" ? C.warn : C.ok }}>
                    {who.identity_mode === "dev-headers"
                      ? "dev header shim — identity trusted as given (development only)"
                      : `identity ${who.identity_mode.replace(/-/g, " ")} by the authenticated proxy`}
                  </div>
                </>
              ) : (
                <div style={{ fontSize: 11, color: DIM }}>identity unavailable — /api/whoami did not answer</div>
              )}
            </div>
            <div style={menuHead}>Switch persona — sets the landing altitude</div>
            {PERSONAS.map((p) => (
              <button
                key={p.name}
                onClick={() => {
                  onPersona(p);
                  setMenu(null);
                }}
                style={{
                  display: "flex", gap: 9, alignItems: "center", width: "100%", textAlign: "left",
                  padding: "7px 12px",
                  background: p.name === persona.name ? C.raised : "transparent",
                  border: "none", borderBottom: `1px solid ${LINE}`,
                  borderLeft: `3px solid ${p.name === persona.name ? C.accent : "transparent"}`,
                  cursor: "pointer", font: "inherit", color: C.text,
                }}
              >
                <span style={{ width: 24, height: 24, borderRadius: 12, background: C.well, color: p.name === persona.name ? C.accent : DIM, fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flex: "none" }}>
                  {initialsOf(p.name)}
                </span>
                <span>
                  <span style={{ display: "block", fontSize: 12, fontWeight: 600 }}>{p.name}</span>
                  <span style={{ display: "block", fontSize: 10.5, color: DIM }}>
                    {p.focus} · opens at {p.altitude}
                  </span>
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* alerts */}
      <div style={{ position: "relative" }}>
        <button onClick={() => setMenu(menu === "alerts" ? null : "alerts")} title="Alerts" aria-label={`Alerts (${alerts})`} style={{ ...iconBtn, position: "relative" }}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7}>
            <path d="M6 9a6 6 0 0112 0c0 5 2 6 2 6H4s2-1 2-6z" strokeLinejoin="round" />
            <path d="M10 19a2 2 0 004 0" strokeLinecap="round" />
          </svg>
          {alerts > 0 && (
            <span style={{ position: "absolute", top: -4, right: -4, minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: "#dc2626", border: "2px solid #191a1f", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: "#fff", fontVariantNumeric: "tabular-nums" }}>
              {alerts}
            </span>
          )}
        </button>
        {menu === "alerts" && (
          <div style={menuPanel}>
            <div style={menuHead}>What needs a decision</div>
            {outOfScope && (
              <div style={{ padding: "8px 12px", borderBottom: `1px solid ${LINE}`, fontSize: 11.5, color: C.danger }}>
                The hull in focus is not assigned to you — the API refuses its data.
              </div>
            )}
            {issues.length === 0 && !outOfScope && (
              <p style={{ fontSize: 11.5, color: DIM, padding: "9px 12px", margin: 0 }}>
                No issues at this instant. That is a positive statement from the
                engine and the register, not an absence of information.
              </p>
            )}
            {issues.slice(0, 7).map((issue, idx) => {
              const k = KIND[issue.kind];
              const space = fixSpace(issue);
              return (
                <button
                  key={`${issue.kind}-${idx}`}
                  onClick={() => {
                    // A spatial issue lands on the space with options open; a
                    // schedule finding lands on the board itself.
                    if (space) onJump(space);
                    else onOpenIssues();
                    setMenu(null);
                  }}
                  style={{ display: "block", width: "100%", textAlign: "left", padding: "8px 12px", background: "transparent", border: "none", borderBottom: `1px solid ${LINE}`, borderLeft: `3px solid ${k.fg}`, cursor: "pointer", font: "inherit", color: C.text }}
                >
                  <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                    <span style={{ fontSize: 8.5, fontWeight: 700, letterSpacing: 0.4, padding: "1px 5px", borderRadius: 3, color: k.fg, background: k.bg, border: `1px solid ${k.border}` }}>
                      {k.label}
                    </span>
                    <span style={{ marginLeft: "auto", fontSize: 11, color: "#f87171", fontVariantNumeric: "tabular-nums" }}>
                      {mh(issue.hours_at_risk)}
                    </span>
                  </div>
                  <div style={{ fontSize: 11, color: C.bright, marginTop: 3 }}>{claim(issue)}</div>
                </button>
              );
            })}
            {issues.length > 0 && (
              <button
                onClick={() => {
                  onOpenIssues();
                  setMenu(null);
                }}
                style={{ display: "block", width: "100%", textAlign: "center", padding: "8px 12px", background: "transparent", border: "none", cursor: "pointer", font: "inherit", fontSize: 11.5, color: C.accent }}
              >
                All {issues.length} issues on the board →
              </button>
            )}
          </div>
        )}
      </div>
    </header>
  );
}

function Chevron() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={C.dim} strokeWidth={2}>
      <polyline points="6 9 12 15 18 9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const iconBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  width: 30,
  height: 30,
  flex: "none",
  borderRadius: 6,
  background: "transparent",
  border: `1px solid ${C.line}`,
  color: C.dim,
  cursor: "pointer",
  padding: 0,
};

const clusterBtn: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  padding: "4px 9px",
  borderRadius: 7,
  background: "transparent",
  border: `1px solid ${C.line}`,
  color: C.text,
  cursor: "pointer",
  font: "inherit",
};

/* --------------------------------------------------------- guardrail strip */

export function GuardrailStrip() {
  return (
    <div style={{ display: "flex", gap: 12, alignItems: "center", padding: "6px 16px", background: C.panel, borderBottom: `1px solid ${LINE}`, fontSize: 11.5, flexWrap: "wrap" }}>
      <span style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={C.accent} strokeWidth={1.8}>
          <path d="M12 3l8 4v5c0 5-4 8-8 9-4-1-8-4-8-9V7z" strokeLinejoin="round" />
          <path d="M9 12l2 2 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        <span>
          <b>Decision support</b> — flags risk; the planner decides. Does not modify the schedule.
        </span>
      </span>
      <span style={{ color: "#424656" }}>·</span>
      <span style={{ letterSpacing: 0.5 }}>ILLUSTRATIVE / NOTIONAL DATA</span>
      <span style={{ color: "#424656" }}>·</span>
      <span style={{ display: "flex", alignItems: "center", gap: 5, color: C.accent, fontWeight: 600 }}>
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.9}>
          <rect x="5" y="11" width="14" height="9" rx="1.5" />
          <path d="M8 11V8a4 4 0 018 0v3" />
        </svg>
        IL5 / sovereign
      </span>
    </div>
  );
}

/* ------------------------------------------------------------- module rail */

export interface ModuleDef {
  group: string;
  label: string;
  id: string;
  icon: string;
  built: boolean;
}

export function ModuleRail({
  modules,
  activeLabel,
  collapsed,
  onPick,
  issueCount = 0,
}: {
  modules: ModuleDef[];
  activeLabel: string;
  collapsed: boolean;
  onPick: (m: ModuleDef) => void;
  /** Issues on the board — badged on Conflicts & Risk, the same currency as
   * the alert bell. */
  issueCount?: number;
}) {
  return (
    <nav
      style={{
        width: collapsed ? 52 : 214,
        flex: "none",
        background: C.rail,
        borderRight: `1px solid ${LINE}`,
        padding: "6px 0",
        display: "flex",
        flexDirection: "column",
      }}
    >
      <div style={{ flex: 1 }}>
        {modules.map((m) => {
          const active = m.label === activeLabel;
          return (
            <div key={m.label}>
              {m.group &&
                (collapsed ? (
                  <div style={{ height: 1, background: "#1d2a3f", margin: "8px 12px 6px" }} />
                ) : (
                  <div style={{ padding: "11px 15px 4px", fontSize: 8.5, letterSpacing: 1.3, textTransform: "uppercase", color: C.faint }}>
                    {m.group}
                  </div>
                ))}
              <button
                onClick={() => onPick(m)}
                title={collapsed ? m.label : undefined}
                aria-label={m.label}
                aria-current={active ? "page" : undefined}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  width: "100%",
                  textAlign: "left",
                  padding: collapsed ? "9px 0" : "8px 15px",
                  justifyContent: collapsed ? "center" : undefined,
                  font: "inherit",
                  fontSize: 12.5,
                  cursor: "pointer",
                  color: active ? C.text : "#aab0bd",
                  border: "none",
                  borderLeft: `3px solid ${active ? C.accent : "transparent"}`,
                  background: active
                    ? "linear-gradient(90deg,rgba(61,107,255,0.18),rgba(61,107,255,0.02))"
                    : "transparent",
                }}
              >
                <span style={{ display: "flex", color: active ? C.accent : C.subtle, flex: "none" }}>
                  {ICONS[m.icon] ?? ICONS.portfolio}
                </span>
                {!collapsed && (
                  <>
                    {/* Wraps rather than truncating. "Deconfliction C…" in a
                        navigation rail is worse than two tidy lines: a reader has
                        to hover to find out where they would be going. */}
                    <span style={{ flex: 1, lineHeight: 1.25 }}>{m.label}</span>
                    {m.id === "leverage" && issueCount > 0 && (
                      <span style={{ minWidth: 16, height: 16, padding: "0 4px", borderRadius: 8, background: "#dc2626", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 700, color: "#fff", fontVariantNumeric: "tabular-nums" }}>
                        {issueCount}
                      </span>
                    )}
                    {/* A module with no view says so here rather than looking
                        identical to a built one and then disappointing. */}
                    {!m.built && (
                      <span style={{ fontSize: 8.5, letterSpacing: 0.5, textTransform: "uppercase", color: "#5a6070", border: "1px solid #2f3b52", borderRadius: 3, padding: "0 3px" }}>
                        soon
                      </span>
                    )}
                  </>
                )}
              </button>
            </div>
          );
        })}
      </div>
      {!collapsed && (
        <div style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 15px", borderTop: "1px solid #1d2a3f", fontSize: 10.5, color: "#7d8494" }}>
          <span style={{ width: 6, height: 6, borderRadius: 3, background: C.ok }} />
          Sovereign node · synced
        </div>
      )}
    </nav>
  );
}

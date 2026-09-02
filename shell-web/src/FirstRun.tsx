// The first-run strip: three cards a person reads once, on the screen their
// role opens, and then dismisses for good.
//
// The Field Guide already explains the tool; nobody is sent to it. This is the
// three sentences that stand between a new reader and the board in front of
// them — what the tool is, what the colours mean, where their day starts — and
// a link to the rest. Dismissal is a per-browser convenience kept in local
// storage, wrapped so a browser that refuses storage still renders the cards
// (and simply shows them again next time).

import { useState } from "react";
import { C, STATE_ORDER, STATE_STYLE } from "./theme";

const KEY = "wadl.firstrun.v1";

function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(KEY, "1");
  } catch {
    // Storage refused — the cards will show again; that is the honest fallback.
  }
}

export function FirstRun({
  roleName,
  opens,
  onOpenGuide,
  onOpenLegend,
}: {
  roleName: string;
  /** Where this role's day opens, e.g. "the shift board". */
  opens: string;
  onOpenGuide: () => void;
  onOpenLegend: () => void;
}) {
  const [dismissed, setDismissed] = useState<boolean>(readDismissed);
  if (dismissed) return null;
  const card: React.CSSProperties = {
    flex: "1 1 260px", minWidth: 0, padding: "10px 13px", borderRadius: 7,
    background: C.panel, border: `1px solid ${C.line}`, fontSize: 12, lineHeight: 1.45,
  };
  const head: React.CSSProperties = {
    fontSize: 9.5, letterSpacing: 0.9, textTransform: "uppercase", color: C.accent, marginBottom: 4, fontWeight: 700,
  };
  const link: React.CSSProperties = {
    font: "inherit", fontSize: 11.5, cursor: "pointer", padding: "1px 7px", borderRadius: 5,
    color: C.accent, background: "transparent", border: `1px solid ${C.accent}44`,
  };
  return (
    <section
      aria-label="First time here"
      style={{ display: "flex", gap: 10, alignItems: "stretch", flexWrap: "wrap", marginBottom: 14 }}
    >
      <div style={card}>
        <div style={head}>What this is</div>
        The yard&apos;s schedule says <i>when</i>; the ship&apos;s authorization state says{" "}
        <i>whether</i>. This tool holds both and shows where they disagree. It flags; the
        planner decides; nothing here changes the schedule of record.
      </div>
      <div style={card}>
        <div style={head}>What the colours mean</div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
          {STATE_ORDER.map((s) => (
            <span key={s} title={STATE_STYLE[s].gloss} style={{ display: "flex", gap: 5, alignItems: "center", whiteSpace: "nowrap" }}>
              <span style={{ width: 9, height: 9, borderRadius: 2, background: STATE_STYLE[s].fg }} />
              <b style={{ color: STATE_STYLE[s].fg, fontSize: 10.5, letterSpacing: 0.4 }}>{STATE_STYLE[s].label}</b>
            </span>
          ))}
        </div>
        A red badge is a hold on a space; an amber badge is work that cannot run as planned.{" "}
        <button onClick={onOpenLegend} style={link}>Legend</button>
      </div>
      <div style={card}>
        <div style={head}>Where your day starts</div>
        You are reading as <b>{roleName}</b>, which opens {opens}. Change the role from the
        top bar and the tool opens where that job&apos;s morning begins. The clock up top is one
        instant for every screen.{" "}
        <button onClick={onOpenGuide} style={link}>Field guide</button>
        <button
          onClick={() => {
            writeDismissed();
            setDismissed(true);
          }}
          style={{ ...link, marginLeft: 6, color: C.dim, borderColor: C.line }}
          title="Hide these cards on this browser"
        >
          Got it
        </button>
      </div>
    </section>
  );
}

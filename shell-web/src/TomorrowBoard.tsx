// The Tomorrow board — Daily Ops' fourth chip: the next shift's work against
// the engine AT THE SHIFT'S START, with the holds in front of it split into
// what a person can clear tonight, what clears on its own, and what needs a
// plan; then the sendable work per trade.
//
// Two reads at the shift's start (per-space verdicts, hull-wide leverage)
// are fetched together: both land or the board renders one amber block, never
// an empty board — an empty Tomorrow reads as "nothing held", the one lie a
// shift board must not tell. The derivation is `tomorrow.ts`; this file
// fetches, words, and prints.

import { useEffect, useMemo, useState } from "react";
import {
  deckStates,
  leverage,
  type Activity,
  type DeckStateRow,
  type Identity,
  type Mitigation,
} from "./api";
import { fmtDayTime } from "./clock";
import { Loading } from "./Loading";
import { downloadCsv, printReport } from "./Reports";
import { badgeStyle, C, chipStyle, mh, commitBtnStyle } from "./theme";
import {
  confidenceWord,
  groupHeadline,
  planSentence,
  projectionNote,
  selfClearSentence,
  slotWord,
  tomorrowBoard,
  tomorrowSheet,
  type ClearanceGroup,
  type SelfClearRow,
  type ShiftRow,
  type ShiftWindow,
  type SpaceRow,
  type TomorrowBoard as Board,
} from "./tomorrow";
import type { YardClock } from "./yardClock";

/** Rows a trade's column shows before it folds — the same fold as the shift board. */
const COLUMN_ROWS = 25;

const nActs = (n: number): string => `${n} ${n === 1 ? "activity" : "activities"}`;

type AtStart =
  | { kind: "loading" }
  | { kind: "ok"; spaces: DeckStateRow[]; actions: Mitigation[] }
  | { kind: "outside" }
  | { kind: "failed"; error: string };

const RED = { fg: C.dangerSoft, bg: "rgba(239,68,68,0.12)", border: "rgba(239,68,68,0.45)" };
const AMBER = { fg: "#fbbf24", bg: "rgba(245,158,11,0.10)", border: "rgba(245,158,11,0.4)" };
const GREEN = { fg: C.ok, bg: "rgba(34,197,94,0.10)", border: "rgba(34,197,94,0.45)" };
const GREY = { fg: C.dim, bg: "rgba(148,163,184,0.08)", border: C.line };

export default function TomorrowBoard({
  identity,
  vesselId,
  hullLabel,
  clock,
  shift,
  asOfMs,
  activities,
  spacesNow,
  verdictsOk,
  zone,
  role,
  scheduleSource,
  onOpenSpace,
  onOpenJob,
}: {
  identity: Identity;
  vesselId: string;
  hullLabel: string;
  clock: YardClock;
  /** The next shift after the as-of instant, from `nextShift`. */
  shift: ShiftWindow;
  /** The instant the register and `spacesNow` were read at. */
  asOfMs: number;
  activities: Activity[];
  spacesNow: DeckStateRow[];
  verdictsOk: boolean | null;
  zone: string | null;
  /** The role producing the sheet. */
  role: string;
  scheduleSource: string | null;
  onOpenSpace: (compartment: string) => void;
  onOpenJob: (code: string) => void;
}) {
  const [atStart, setAtStart] = useState<AtStart>({ kind: "loading" });

  // Both reads at the shift's start, together, with a stale guard: a slow
  // answer for one shift start must not land under a later one.
  useEffect(() => {
    let stale = false;
    setAtStart({ kind: "loading" });
    Promise.all([deckStates(identity, vesselId, shift.start), leverage(identity, vesselId, shift.start)])
      .then(([spaces, lev]) => {
        if (!stale) setAtStart({ kind: "ok", spaces, actions: lev.actions });
      })
      .catch((e: unknown) => {
        if (stale) return;
        const text = String(e);
        setAtStart(/→ 422/.test(text) ? { kind: "outside" } : { kind: "failed", error: text });
      });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, shift.start]);

  const board: Board | null = useMemo(
    () =>
      atStart.kind === "ok"
        ? tomorrowBoard({ clock, shift, asOfMs, activities, spacesNow, spacesAtStart: atStart.spaces, leverageAtStart: atStart.actions, zone })
        : null,
    [atStart, clock, shift, asOfMs, activities, spacesNow, zone],
  );

  const sheet = () =>
    board ? tomorrowSheet(board, { hull: hullLabel, asOfMs, scheduleSource, producedBy: role }, zone) : null;

  if (atStart.kind === "loading") return <Loading label={`Computing clearances at ${fmtDayTime(shift.start)}…`} />;

  if (atStart.kind === "outside") {
    return (
      <Block tone="amber">
        <b>The next shift is outside the availability — no projection.</b> The engine only
        answers inside the hull&apos;s availability; {fmtDayTime(shift.start)} is not in it.
      </Block>
    );
  }
  if (atStart.kind === "failed" || board === null) {
    return (
      <Block tone="amber">
        <b>Projection unavailable</b> — the engine did not answer for {fmtDayTime(shift.start)}
        {atStart.kind === "failed" ? ` (${atStart.error})` : ""}; do not read this board as tomorrow&apos;s
        clearance. Reload, or check the API.
      </Block>
    );
  }

  const t = board.totals;
  return (
    <div>
      <div
        role="note"
        style={{ margin: "0 0 10px", padding: "6px 10px", borderRadius: 6, border: `1px solid rgba(245,158,11,0.45)`, background: "rgba(245,158,11,0.07)", color: C.warn, fontSize: 11, fontFamily: "monospace", letterSpacing: 0.2 }}
        title="Every hold on this board is the engine's verdict for the shift's start, computed under the field conditions on record at the as-of instant. Nothing raised or cleared between now and then is known here."
      >
        {projectionNote(board)}
      </div>

      {verdictsOk === false && (
        <Block tone="amber">
          <b>Verdicts for now unavailable.</b> The &quot;held now&quot; half of the self-clearing
          rows cannot be read at this instant; the shift-start verdicts above still stand.
        </Block>
      )}

      {/* The headline: one figure per section, each naming its layer. */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 12 }}>
        <Stat value={nActs(t.activities)} label={`${mh(Math.round(t.mhShift))} on the shift`} title="Schedule of record, pro-rated into the shift by the shell." tone={GREY} />
        <Stat value={`${board.clearable.length} clearable tonight`} label={mh(Math.round(t.mhClearable))} title="Single actions from the engine's leverage read at the shift start that free a space with work on the shift. The count is actions; the hours are the shift's." tone={board.clearable.length > 0 ? RED : GREY} />
        <Stat value={`${board.selfClearing.length} clears on its own`} label={mh(Math.round(t.mhSelf))} title="Holds on a clock (the engine's earliest clear): cured before the start, or clearing during or after the shift. Hours count only the holds still standing at the start." tone={board.selfClearing.some((r) => r.when !== "before_shift") ? AMBER : GREY} />
        <Stat value={`${board.needsPlan.length} needs a plan`} label={mh(Math.round(t.mhPlan))} title="Held at the shift start with no clock and no single action that opens it — the engine's verdict and its leverage read, both at the start." tone={board.needsPlan.length > 0 ? RED : GREY} />
        <Stat value="sendable" label={mh(Math.round(t.mhSendable))} title="Work in spaces the engine opens at the shift start. Not an authorization — the plate's verdict at the moment the crew goes is the one that counts." tone={GREEN} />
        <span style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
          <button
            onClick={() => {
              const r = sheet();
              if (r) downloadCsv(r);
            }}
            style={chipStyle(false)}
            title="The board as CSV, with the cut in its first rows"
          >
            ↓ CSV
          </button>
          <button
            onClick={() => {
              const r = sheet();
              if (r) printReport(r);
            }}
            style={commitBtnStyle}
            title="A monochrome one-pager for the clipboard wall — the projection note and every layer on it"
          >
            ⎙ Print sheet
          </button>
        </span>
      </div>

      {zone && (
        <p style={{ margin: "0 0 10px", fontSize: 11.5, color: C.warn }}>
          <b>Zone {zone} in focus</b> — work located in the zone (or hinted to it by its WBS) is on this board; the rest of the shift is one click away on the Deck Explorer&apos;s focus bar.
        </p>
      )}

      <Section
        heading="Clearable tonight"
        gloss="A person can open these before the crew arrives. Each action is the engine's, with who has to do it; the caveat says what the platform is assuming."
        tone={RED}
        count={board.clearable.length}
        empty="No single action at the shift start frees a space with work on it."
      >
        {board.clearable.map((g) => (
          <ClearanceCard key={`${g.origin}·${g.hazard}`} g={g} onOpenSpace={onOpenSpace} onOpenJob={onOpenJob} />
        ))}
      </Section>

      <Section
        heading="Clears on its own"
        gloss="Holds on a clock — nothing to do but know when. Cured before the start: the work is sendable. During the shift: send the crew after. After: see Week Ahead."
        tone={AMBER}
        count={board.selfClearing.length}
        empty="No hold on a clock stands in front of this shift."
      >
        {board.selfClearing.map((r) => (
          <HoldCard key={r.space} space={r.space} name={r.name} sentence={selfClearSentence(r, shift)} tone={r.when === "before_shift" ? GREEN : AMBER} word={selfWord(r)} rows={r.rows} onOpenSpace={onOpenSpace} onOpenJob={onOpenJob} />
        ))}
      </Section>

      <Section
        heading="Needs a plan"
        gloss="Held at the shift start with no clock and no single action that opens it — a plan, not a phone call. The options panel on the plate prices the combinations."
        tone={RED}
        count={board.needsPlan.length}
        empty="Every held space has a clock or a single clearing action."
      >
        {board.needsPlan.map((r: SpaceRow) => (
          <HoldCard key={r.space} space={r.space} name={r.name} sentence={planSentence(r)} tone={RED} word="NEEDS A PLAN" rows={r.rows} onOpenSpace={onOpenSpace} onOpenJob={onOpenJob} />
        ))}
      </Section>

      <Section
        heading="Sendable"
        gloss="Open at the shift start, per trade, heaviest first. NOT EXECUTABLE AS PLANNED is the plan's problem somewhere in the activity's own window — not this shift's."
        tone={GREEN}
        count={board.sendable.reduce((s, c) => s + c.rows.length, 0)}
        empty="Nothing on this shift is open at its start."
      >
        <TradeColumns board={board} onOpenSpace={onOpenSpace} onOpenJob={onOpenJob} />
      </Section>

      {(board.unlocated.length > 0 || board.undated.length > 0) && (
        <p style={{ fontSize: 11.5, color: C.dim, margin: "12px 0 0" }}>
          Counted, not placed:{" "}
          {board.unlocated.length > 0 && (
            <span style={{ color: C.warn }} title="The schedule did not say where — the engine cannot assess a space it was not given.">
              {nActs(board.unlocated.length)} not located
            </span>
          )}
          {board.unlocated.length > 0 && board.undated.length > 0 && " · "}
          {board.undated.length > 0 && (
            <span style={{ color: C.warn }} title="No dates in the schedule of record — on every shift rather than hidden from all of them, carrying no shift hours.">
              {nActs(board.undated.length)} undated
            </span>
          )}
          . The Sequence Board lists them.
        </p>
      )}
    </div>
  );
}

/* ------------------------------------------------------------- pieces */

function selfWord(r: SelfClearRow): string {
  switch (r.when) {
    case "before_shift":
      return "✓ CURED BEFORE THE SHIFT";
    case "during_shift":
      return "⏳ CLEARS DURING THE SHIFT";
    case "after_shift":
      return "⏳ CLEARS AFTER THE SHIFT";
  }
}

function Block({ tone, children }: { tone: "amber"; children: React.ReactNode }) {
  const t = tone === "amber" ? AMBER : RED;
  return (
    <div role="alert" style={{ margin: "0 0 12px", padding: "8px 12px", borderRadius: 6, border: `1px solid ${t.border}`, background: t.bg, color: C.warn, fontSize: 12.5 }}>
      {children}
    </div>
  );
}

function Stat({ value, label, title, tone }: { value: string; label: string; title: string; tone: { fg: string; bg: string; border: string } }) {
  return (
    <span title={title} style={{ display: "inline-flex", gap: 6, alignItems: "baseline", padding: "3px 9px", borderRadius: 5, border: `1px solid ${tone.border}`, background: tone.bg, fontSize: 11.5 }}>
      <b style={{ color: tone.fg }}>{value}</b>
      <span style={{ color: C.dim, fontSize: 10.5 }}>{label}</span>
    </span>
  );
}

function Section({
  heading,
  gloss,
  tone,
  count,
  empty,
  children,
}: {
  heading: string;
  gloss: string;
  tone: { fg: string; bg: string; border: string };
  count: number;
  empty: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ marginBottom: 16 }}>
      <header style={{ display: "flex", gap: 10, alignItems: "baseline", marginBottom: 6, flexWrap: "wrap" }}>
        <h2 style={{ fontSize: 14, margin: 0, color: tone.fg }}>{heading}</h2>
        <span style={{ fontSize: 11, color: C.dim }} title={gloss}>
          {count === 0 ? empty : gloss}
        </span>
      </header>
      {count > 0 && children}
    </section>
  );
}

function ClearanceCard({ g, onOpenSpace, onOpenJob }: { g: ClearanceGroup; onOpenSpace: (no: string) => void; onOpenJob: (code: string) => void }) {
  const caveat = confidenceWord(g.confidence);
  return (
    <article style={{ border: `1px solid ${RED.border}`, borderRadius: 8, background: C.panel, marginBottom: 8 }}>
      <header style={{ padding: "8px 12px", borderBottom: `1px solid ${C.line}`, display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={badgeStyle(RED)} title="Who has to act, in the yard's words — the engine's clearing authority for this hazard.">{g.actor.toUpperCase()}</span>
        <b style={{ fontSize: 12.5 }}>{g.hazard}</b>
        <button
          onClick={() => onOpenSpace(g.spaces[0] ?? g.origin.split(" → ")[0] ?? "")}
          title="Open on the plate — the clear-with-basis door is there."
          style={{ font: "inherit", fontFamily: "monospace", fontSize: 11, cursor: "pointer", color: C.accent, background: "transparent", border: "none", padding: 0, textDecoration: "underline", textUnderlineOffset: 2 }}
        >
          {g.origin}
        </button>
        <span style={{ fontSize: 11, color: C.dim }} title={groupHeadline(g)}>
          frees {g.frees.length} space{g.frees.length === 1 ? "" : "s"}
          {g.freesWithWork !== g.frees.length ? ` (${g.freesWithWork} with work on this shift)` : ""} · {nActs(g.rows.length)} ·{" "}
          <b style={{ color: C.bright }}>{mh(Math.round(g.mhShift))}</b> on the shift · {g.trades.join(", ")}
        </span>
        {caveat && <span style={badgeStyle(AMBER)} title="What the platform is assuming: the effect is the engine's; whether the authority attends, or the closure work is itself permitted, is not known here.">{caveat}</span>}
        {g.closes.length > 0 && (
          <span style={badgeStyle(RED)} title={`Would shut: ${g.closes.join(", ")}`}>
            WOULD SHUT {g.closes.length} SPACE{g.closes.length === 1 ? "" : "S"}
          </span>
        )}
      </header>
      <Rows rows={g.rows} onOpenSpace={onOpenSpace} onOpenJob={onOpenJob} />
    </article>
  );
}

function HoldCard({
  space,
  name,
  sentence,
  tone,
  word,
  rows,
  onOpenSpace,
  onOpenJob,
}: {
  space: string;
  name: string;
  sentence: string;
  tone: { fg: string; bg: string; border: string };
  word: string;
  rows: ShiftRow[];
  onOpenSpace: (no: string) => void;
  onOpenJob: (code: string) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <article style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: C.panel, marginBottom: 6 }}>
      <header style={{ padding: "7px 12px", display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={badgeStyle(tone)}>{word}</span>
        <button
          onClick={() => onOpenSpace(space)}
          title="Open on the plate — the hold's evidence and options are there."
          style={{ font: "inherit", fontFamily: "monospace", fontSize: 11.5, cursor: "pointer", color: C.accent, background: "transparent", border: "none", padding: 0, textDecoration: "underline", textUnderlineOffset: 2 }}
        >
          {space}
        </button>
        <b style={{ fontSize: 12.5 }}>{name}</b>
        <span style={{ fontSize: 11.5, color: C.bright }}>— {sentence}</span>
        <button
          onClick={() => setOpen((o) => !o)}
          title="The activities booked into this space on the shift"
          style={{ marginLeft: "auto", font: "inherit", fontSize: 10.5, cursor: "pointer", padding: "1px 7px", borderRadius: 4, color: C.dim, background: "transparent", border: `1px solid ${C.line}` }}
        >
          {open ? "hide work" : "show work"}
        </button>
      </header>
      {open && <Rows rows={rows} onOpenSpace={onOpenSpace} onOpenJob={onOpenJob} />}
    </article>
  );
}

function Rows({ rows, onOpenSpace, onOpenJob }: { rows: ShiftRow[]; onOpenSpace: (no: string) => void; onOpenJob: (code: string) => void }) {
  return (
    <div>
      {rows.map((r) => (
        <Row key={r.a.activity_id} r={r} onOpenSpace={onOpenSpace} onOpenJob={onOpenJob} />
      ))}
    </div>
  );
}

/** One activity line: code · name · slot · MH · space · plan-level word. */
function Row({ r, onOpenSpace, onOpenJob, showSpace = true }: { r: ShiftRow; onOpenSpace: (no: string) => void; onOpenJob: (code: string) => void; showSpace?: boolean }) {
  const a = r.a;
  const doomed = a.executability.verdict === "not_executable";
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline", padding: "5px 12px", borderTop: `1px solid ${C.hairline}`, fontSize: 12 }}>
      {a.work_order_code ? (
        <button
          onClick={() => onOpenJob(a.work_order_code ?? "")}
          title={`Open the job card for ${a.work_order_code}`}
          style={{ font: "inherit", fontFamily: "monospace", cursor: "pointer", color: C.accent, whiteSpace: "nowrap", background: "transparent", border: "none", padding: 0, textDecoration: "underline", textUnderlineOffset: 2 }}
        >
          {a.code}
        </button>
      ) : (
        <span style={{ fontFamily: "monospace", color: C.accent, whiteSpace: "nowrap" }}>{a.code}</span>
      )}
      <span style={{ flex: 1, minWidth: 120 }}>
        {a.name}
        <span style={{ color: C.dim, marginLeft: 8, fontFamily: "monospace", fontSize: 10, whiteSpace: "nowrap" }}>{slotWord(a.planned)}</span>
      </span>
      <span style={{ fontSize: 10.5, color: C.dim, whiteSpace: "nowrap" }}>{a.trade}</span>
      <span
        title={`${mh(Math.round(r.mhShift))} falls inside the shift (schedule of record, pro-rated by the shell) · ${mh(a.remaining_hours)} open in total`}
        style={{ fontSize: 10.5, color: C.dim, whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}
      >
        {Math.round(r.mhShift).toLocaleString()} / {a.remaining_hours.toLocaleString()} MH
      </span>
      {showSpace && (
        <button
          onClick={() => onOpenSpace(r.space)}
          title={`Open ${r.space} on the plate${a.compartment_reliability !== "high" ? " — location read from the task's own name, a graded guess" : ""}`}
          style={{ font: "inherit", fontSize: 10, fontFamily: "monospace", cursor: "pointer", padding: "1px 5px", borderRadius: 4, color: C.bright, background: "rgba(148,163,184,0.08)", border: `1px solid ${C.line}` }}
        >
          {a.compartment_reliability !== "high" && "≈ "}
          {r.space}
        </button>
      )}
      {doomed && (
        <span style={badgeStyle(AMBER)} title="The space refuses work somewhere inside this activity's own planned window — the plan's problem, not this shift's.">
          NOT EXECUTABLE AS PLANNED
        </span>
      )}
    </div>
  );
}

function TradeColumns({ board, onOpenSpace, onOpenJob }: { board: Board; onOpenSpace: (no: string) => void; onOpenJob: (code: string) => void }) {
  const [unfolded, setUnfolded] = useState<Set<string>>(new Set());
  return (
    <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill,minmax(430px,1fr))", alignItems: "start" }}>
      {board.sendable.map((g) => (
        <section key={g.trade} style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: C.panel }}>
          <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", padding: "8px 12px", borderBottom: `1px solid ${C.line}` }}>
            <b style={{ fontSize: 13 }}>{g.trade}</b>
            <span style={{ fontSize: 11, color: C.dim }} title={`This shift's share, pro-rated by overlap. Total open on these activities: ${mh(g.remaining)}.`}>
              {nActs(g.rows.length)} · <b style={{ color: C.bright }}>{mh(Math.round(g.mhShift))} on the shift</b> · {mh(g.remaining)} total left
            </span>
          </header>
          {(unfolded.has(g.trade) ? g.rows : g.rows.slice(0, COLUMN_ROWS)).map((r) => (
            <Row key={r.a.activity_id} r={r} onOpenSpace={onOpenSpace} onOpenJob={onOpenJob} />
          ))}
          {!unfolded.has(g.trade) && g.rows.length > COLUMN_ROWS && (
            <button
              onClick={() => setUnfolded((s) => new Set(s).add(g.trade))}
              title="Show every activity in this trade's column. The header's counts and hours already cover all of them."
              style={{ width: "100%", textAlign: "left", font: "inherit", fontSize: 11, cursor: "pointer", padding: "7px 12px", color: C.accent, background: "transparent", border: "none", borderTop: `1px solid ${C.hairline}` }}
            >
              + {g.rows.length - COLUMN_ROWS} more in {g.trade} — show all
            </button>
          )}
        </section>
      ))}
    </div>
  );
}

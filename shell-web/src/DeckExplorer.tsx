import { useEffect, useMemo, useState } from "react";
import {
  compartmentState,
  deckStates,
  listDecks,
  type Deck,
  type DeckStateRow,
  type Decision,
  type Identity,
} from "./api";
import { C, fmtClear, STATE_STYLE } from "./theme";

const DIM = C.dim;
const LINE = C.line;
const TEXT = C.text;

export default function DeckExplorer({
  identity,
  vesselId,
  hullLabel,
}: {
  identity: Identity;
  vesselId: string;
  hullLabel: string;
}) {
  const [decks, setDecks] = useState<Deck[]>([]);
  const [rows, setRows] = useState<DeckStateRow[]>([]);
  const [selectedDeck, setSelectedDeck] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [decision, setDecision] = useState<Decision | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    setSelected(null);
    setDecision(null);
    Promise.all([listDecks(identity, vesselId), deckStates(identity, vesselId)])
      .then(([d, r]) => {
        setDecks(d);
        setRows(r);
        setSelectedDeck(d[0]?.code ?? null);
      })
      .catch((e: unknown) => {
        setDecks([]);
        setRows([]);
        setError(String(e));
      });
  }, [identity, vesselId]);

  // Selecting a compartment fetches its full trace from the engine-backed
  // endpoint. The client never derives a state itself.
  useEffect(() => {
    if (!selected) return;
    compartmentState(identity, vesselId, selected)
      .then((r) => setDecision(r.decision))
      .catch(() => setDecision(null));
  }, [identity, vesselId, selected]);

  const onDeck = useMemo(
    () => rows.filter((r) => r.compartment.deck_code === selectedDeck),
    [rows, selectedDeck],
  );

  const affected = rows.filter((r) => r.state !== "ALLOW");
  const selectedRow = rows.find((r) => r.compartment.compartment_no === selected);

  if (error) {
    return (
      <p style={{ color: STATE_STYLE.BLOCK.fg }}>
        This hull is out of scope for you, or the API is unreachable ({error}).
      </p>
    );
  }

  return (
    <div>
      <div style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: "#3D6BFF" }}>
        Deck Explorer · {hullLabel}
      </div>
      <h1 style={{ fontSize: 22, margin: "4px 0 2px" }}>Compartment authorization</h1>
      <p style={{ color: DIM, fontSize: 12.5, margin: "0 0 14px", maxWidth: 720 }}>
        State is computed by the rule engine and read through the API — the shell never
        derives it. {affected.length} of {rows.length} compartments are currently
        restricted by a live hazard.
      </p>

      {/* deck ruler — ordered downward, which is what makes "directly above" real */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {decks.map((d) => {
          const isSel = d.code === selectedDeck;
          const restricted = rows.filter(
            (r) => r.compartment.deck_code === d.code && r.state !== "ALLOW",
          ).length;
          return (
            <button
              key={d.code}
              onClick={() => setSelectedDeck(d.code)}
              style={{
                display: "flex", alignItems: "center", gap: 8, padding: "6px 11px",
                background: isSel ? "#20222b" : "transparent", color: isSel ? TEXT : DIM,
                border: `1px solid ${isSel ? "#3D6BFF" : LINE}`, borderRadius: 6,
                cursor: "pointer", font: "inherit", fontSize: 12,
              }}
            >
              <span style={{ fontFamily: "monospace", opacity: 0.6 }}>{d.ordinal}</span>
              <span style={{ fontWeight: 600 }}>{d.label}</span>
              {restricted > 0 && (
                <span style={{
                  minWidth: 16, height: 16, borderRadius: 8, padding: "0 4px",
                  background: STATE_STYLE.BLOCK.fg, color: "#0b0c0e",
                  fontSize: 10, fontWeight: 700, display: "flex",
                  alignItems: "center", justifyContent: "center",
                }}>{restricted}</span>
              )}
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 18, alignItems: "flex-start", flexWrap: "wrap" }}>
        {/* plan view */}
        <div style={{ flex: "1 1 460px", minWidth: 340 }}>
          <div style={{ display: "grid", gap: 8, gridTemplateColumns: "repeat(auto-fill,minmax(210px,1fr))" }}>
            {onDeck.map((r) => {
              const s = STATE_STYLE[r.state];
              const isSel = r.compartment.compartment_no === selected;
              return (
                <button
                  key={r.compartment.compartment_no}
                  onClick={() => setSelected(r.compartment.compartment_no)}
                  style={{
                    textAlign: "left", padding: 10, borderRadius: 8, cursor: "pointer",
                    background: s.bg, color: TEXT, font: "inherit",
                    border: `1px solid ${isSel ? "#3D6BFF" : s.border}`,
                    outline: isSel ? "1px solid #3D6BFF" : "none",
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                    <span style={{ fontFamily: "monospace", fontSize: 12 }}>
                      {r.compartment.compartment_no}
                    </span>
                    <span style={{ color: s.fg, fontSize: 10, fontWeight: 700, letterSpacing: 0.5 }}>
                      {r.state}
                    </span>
                  </div>
                  <div style={{ fontSize: 12.5, marginTop: 3 }}>{r.compartment.name}</div>
                  <div style={{ fontSize: 11, color: DIM, marginTop: 2 }}>
                    {r.compartment.zone} · {r.compartment.category}
                    {r.rules_fired.length > 0 && ` · ${r.rules_fired.join(", ")}`}
                  </div>
                </button>
              );
            })}
          </div>
          {onDeck.length === 0 && (
            <p style={{ color: DIM, fontSize: 12.5 }}>No compartments on this deck in the register.</p>
          )}
        </div>

        {/* the decision trace — the contract with the safety authority */}
        <aside style={{ flex: "0 1 380px", minWidth: 320, border: `1px solid ${LINE}`, borderRadius: 8, padding: 14, background: "#121316" }}>
          <div style={{ fontSize: 10, letterSpacing: 1, textTransform: "uppercase", color: DIM }}>
            Decision trace
          </div>
          {!selectedRow && (
            <p style={{ color: DIM, fontSize: 12.5, marginTop: 8 }}>
              Select a compartment to see why it is in its current state — every rule that
              fired, the path the hazard took, and who may clear it.
            </p>
          )}
          {selectedRow && (
            <>
              <div style={{ marginTop: 6, display: "flex", alignItems: "baseline", gap: 8 }}>
                <span style={{ fontFamily: "monospace" }}>{selectedRow.compartment.compartment_no}</span>
                <span style={{ color: STATE_STYLE[selectedRow.state].fg, fontWeight: 700, fontSize: 12 }}>
                  {selectedRow.state}
                </span>
              </div>
              <div style={{ fontSize: 12.5, color: DIM }}>{selectedRow.compartment.name}</div>

              {decision?.trace.length === 0 && (
                <p style={{ color: DIM, fontSize: 12.5, marginTop: 10 }}>
                  No rule applies here. This is an explicit “nothing restricts this space”,
                  not an absence of information.
                </p>
              )}
              {decision?.trace.map((t, i) => (
                <div key={`${t.rule_code}-${i}`} style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${LINE}` }}>
                  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                    <span style={{
                      fontFamily: "monospace", fontSize: 11, fontWeight: 700,
                      padding: "1px 6px", borderRadius: 4,
                      color: STATE_STYLE[t.state].fg, background: STATE_STYLE[t.state].bg,
                      border: `1px solid ${STATE_STYLE[t.state].border}`,
                    }}>{t.rule_code} · {t.state}</span>
                    <span style={{ fontSize: 11, color: DIM }}>
                      {t.depth === 0 ? "same space" : `${t.depth} hop${t.depth === 1 ? "" : "s"}`}
                    </span>
                  </div>
                  <p style={{ fontSize: 12.5, margin: "6px 0 0" }}>{t.reason}</p>
                  {t.path.length > 1 && (
                    <div style={{ fontFamily: "monospace", fontSize: 11, color: DIM, marginTop: 4 }}>
                      {t.path.join(" → ")}
                    </div>
                  )}
                  <dl style={{ margin: "6px 0 0", fontSize: 11, color: DIM, display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 8px" }}>
                    <dt>Authority</dt><dd style={{ margin: 0, color: "#ccd1da" }}>{t.authority}</dd>
                    <dt>Cleared by</dt><dd style={{ margin: 0, color: "#ccd1da" }}>{t.clearing_authority}</dd>
                    <dt>Earliest clear</dt><dd style={{ margin: 0, color: "#ccd1da" }}>{fmtClear(t.earliest_clear)}</dd>
                    <dt>Rule version</dt><dd style={{ margin: 0, fontFamily: "monospace", fontSize: 10 }}>{t.rule_version}</dd>
                  </dl>
                </div>
              ))}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

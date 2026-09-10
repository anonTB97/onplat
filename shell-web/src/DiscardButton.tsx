// The discard control for an ingested document — armed, never accidental.
//
// Every ingest is guarded by a dry run and a Confirm; discarding the same
// document used to be one bare click. This button restores the symmetry:
// the first click ARMS it ("Discard …?"), the second click discards, and a
// few idle seconds — or Keep — stand it down. The verb is "Discard" and the
// tone is red on purpose: ⟲ belongs to harmless view resets, and an icon
// that means "reset the camera" on one screen must not mean "throw away the
// schedule of record" on the next.

import { useEffect, useState } from "react";
import { C } from "./theme";

export function DiscardButton({
  what,
  title,
  onDiscard,
  refusedBecause,
}: {
  /** What gets thrown away, named: "the ingested schedule". */
  what: string;
  /** What the screens fall back to, for the tooltip. */
  title: string;
  onDiscard: () => void;
  /** Set when this person may not revert: the button is greyed and the
   *  sentence (the server's own refusal, worded ahead of time) is the tooltip. */
  refusedBecause?: string;
}) {
  const [armed, setArmed] = useState(false);

  // An armed discard left behind must not fire minutes later by accident.
  useEffect(() => {
    if (!armed) return undefined;
    const t = setTimeout(() => setArmed(false), 6000);
    return () => clearTimeout(t);
  }, [armed]);

  if (refusedBecause) {
    return (
      <button
        disabled
        title={refusedBecause}
        style={{
          font: "inherit", fontSize: 10.5, cursor: "not-allowed",
          padding: "2px 8px", borderRadius: 5, color: C.faint,
          background: "transparent", border: `1px solid ${C.line}`, opacity: 0.7,
        }}
      >
        Discard {what}…
      </button>
    );
  }
  if (!armed) {
    return (
      <button
        onClick={() => setArmed(true)}
        title={`${title} Nothing is discarded until you confirm.`}
        style={{
          font: "inherit", fontSize: 10.5, cursor: "pointer",
          padding: "2px 8px", borderRadius: 5, color: C.dim,
          background: "transparent", border: `1px solid ${C.line}`,
        }}
      >
        Discard {what}…
      </button>
    );
  }
  return (
    <span style={{ display: "inline-flex", gap: 5, alignItems: "center" }}>
      <span style={{ fontSize: 10.5, color: C.dangerSoft }}>Discard {what}?</span>
      <button
        onClick={() => {
          setArmed(false);
          onDiscard();
        }}
        title="Yes — discard it. The screens return to what the tool can serve without it."
        style={{
          font: "inherit", fontSize: 10.5, fontWeight: 700, cursor: "pointer",
          padding: "2px 9px", borderRadius: 5, color: C.dangerSoft,
          background: "rgba(220,38,38,0.14)", border: "1px solid rgba(220,38,38,0.55)",
        }}
      >
        Discard
      </button>
      <button
        onClick={() => setArmed(false)}
        title="Keep the document; nothing changes."
        style={{
          font: "inherit", fontSize: 10.5, cursor: "pointer",
          padding: "2px 9px", borderRadius: 5, color: C.dim,
          background: "transparent", border: `1px solid ${C.line}`,
        }}
      >
        Keep
      </button>
    </span>
  );
}

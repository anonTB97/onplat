// The module header, defined once: the screen's name, the question it answers,
// a stat row, and at most one muted line of context.
//
// The name leads. Every board used to open with a rhetorical headline as its
// title and its rail name as a ten-pixel kicker, so a reader told "open the
// cascade" could not confirm they had. Now the rail name IS the title, the
// question sits under it as the one line of orientation, and the figures a
// reader came for follow as scannable values. One component so the rhythm —
// sizes, margins, measure — cannot drift per module.

import { C } from "./theme";

export interface Stat {
  /** The figure, already formatted. */
  value: string | number;
  /** What it counts, lowercase, two or three words. */
  label: string;
  /** Semantic colour for figures that are findings; default is bright. */
  tone?: string;
  /** Hover gloss for the evidence behind the number. */
  title?: string;
}

/**
 * Splits "Name · context" into the name (the title) and the context (a quiet
 * tag beside it). Callers pass the rail name and the hull label joined by a
 * middle dot; a kicker with no dot is just a name.
 */
export function splitKicker(kicker: string): { name: string; context: string | null } {
  const at = kicker.indexOf(" · ");
  if (at < 0) return { name: kicker, context: null };
  return { name: kicker.slice(0, at), context: kicker.slice(at + 3) };
}

export function ModuleHeader({
  kicker,
  title,
  stats,
  note,
}: {
  /** "Rail name · hull label" — the name becomes the title. */
  kicker: string;
  /** The question this screen answers, in one line. */
  title: string;
  /** Falsy entries are skipped, so callers can write `count > 0 && {...}`. */
  stats?: (Stat | false | null | undefined)[];
  note?: React.ReactNode;
}) {
  const shown = (stats ?? []).filter((s): s is Stat => Boolean(s));
  const { name, context } = splitKicker(kicker);
  return (
    <header style={{ marginBottom: 14 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <h1 style={{ fontSize: 22, margin: 0 }}>{name}</h1>
        {context && (
          <span style={{ fontFamily: "monospace", fontSize: 11, color: C.dim, letterSpacing: 0.3 }}>{context}</span>
        )}
      </div>
      <div style={{ fontSize: 13, color: C.bright, margin: "3px 0 0", maxWidth: 780 }}>{title}</div>
      {shown.length > 0 && (
        <div style={{ display: "flex", gap: 22, flexWrap: "wrap", alignItems: "baseline", margin: "10px 0 0" }}>
          {shown.map((s) => (
            <div key={s.label} title={s.title} style={{ display: "flex", gap: 7, alignItems: "baseline" }}>
              <span
                style={{
                  fontSize: 16, fontWeight: 700, fontVariantNumeric: "tabular-nums",
                  color: s.tone ?? C.bright,
                }}
              >
                {s.value}
              </span>
              <span style={{ fontSize: 10.5, color: C.dim }}>{s.label}</span>
            </div>
          ))}
        </div>
      )}
      {note && (
        <p style={{ color: C.dim, fontSize: 11.5, margin: "8px 0 0", maxWidth: 780 }}>{note}</p>
      )}
    </header>
  );
}

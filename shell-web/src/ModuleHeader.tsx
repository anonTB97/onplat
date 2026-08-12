// The module header, defined once: kicker, a short title, a stat row, and at
// most one muted line of context.
//
// Every board used to open with a rhetorical headline and a paragraph of
// prose with the actual numbers bolded mid-sentence — literature before data,
// on every screen. The stat row inverts that: the figures a reader came for
// sit first as scannable values, and the narrative survives only as a single
// quiet line (with anything longer living in tooltips). One component so the
// rhythm — sizes, margins, measure — cannot drift per module.

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

export function ModuleHeader({
  kicker,
  title,
  stats,
  note,
}: {
  kicker: string;
  title: string;
  /** Falsy entries are skipped, so callers can write `count > 0 && {...}`. */
  stats?: (Stat | false | null | undefined)[];
  note?: React.ReactNode;
}) {
  const shown = (stats ?? []).filter((s): s is Stat => Boolean(s));
  return (
    <header style={{ marginBottom: 14 }}>
      <div style={{ fontSize: 10, letterSpacing: 1.1, textTransform: "uppercase", color: C.accent }}>
        {kicker}
      </div>
      <h1 style={{ fontSize: 22, margin: "4px 0 0" }}>{title}</h1>
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

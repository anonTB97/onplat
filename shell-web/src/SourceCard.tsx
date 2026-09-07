// One document's card on the Data Sources board — what it is, what landed,
// the door in (a picker, and the whole card as a drop target), and the way
// out (an armed Discard). Shared by the board's cards and the schedule door,
// so a card reads the same whether its document is a CSV or the hull's
// schedule of record with a run history under it.

import { useState, type ReactNode } from "react";
import { DiscardButton } from "./DiscardButton";
import { holdersOf, ROLE_WORDS, useIdentity, type Capability } from "./identity";
import { C } from "./theme";

/** One document's card: what it is, what landed, the door in, and the way out. */
export function SourceCard({
  kind,
  status,
  name,
  lines,
  upload,
  extra,
  importHint,
  onOpenHome,
  onRevert,
  revertTitle,
  commitCapability = "commit_document",
  wide = false,
}: {
  kind: string;
  status: { label: string; tone: string };
  name: string;
  lines: { text: string; tone?: string; gloss?: string }[];
  /** The document's own door: a picker, and the whole card as a drop target. */
  upload?: { label: string; accept: string; title: string; onFile: (f: File) => void };
  /** A door's own control, rendered under the lines — e.g. a derivation toggle. */
  extra?: ReactNode;
  importHint?: string;
  onOpenHome?: () => void;
  onRevert?: () => void;
  /** What the screens fall back to when this document is discarded. */
  revertTitle?: string;
  /** What committing this document needs — a hazard log raises, the rest commit. */
  commitCapability?: Capability;
  /** Span the whole grid: the card carries a table (a quarantine, a run history). */
  wide?: boolean;
}) {
  const [dragOver, setDragOver] = useState(false);
  const { who, can, refusal } = useIdentity();
  const mayCommit = can(commitCapability);
  const mayRevert = can("commit_document");
  const holders = who ? holdersOf(who, commitCapability).map((r) => ROLE_WORDS[r]).join(" or ") : "";
  return (
    <section
      onDragOver={
        upload
          ? (e) => {
              e.preventDefault();
              setDragOver(true);
            }
          : undefined
      }
      onDragLeave={upload ? () => setDragOver(false) : undefined}
      onDrop={
        upload
          ? (e) => {
              e.preventDefault();
              setDragOver(false);
              const f = e.dataTransfer.files[0];
              if (f) upload.onFile(f);
            }
          : undefined
      }
      style={{
        border: `1px ${dragOver ? "dashed" : "solid"} ${dragOver ? C.accent : C.line}`,
        borderRadius: 8,
        background: dragOver ? "rgba(61,107,255,0.05)" : C.panel,
        gridColumn: wide ? "1 / -1" : undefined,
        minWidth: 0,
      }}
    >
      <header style={{ display: "flex", gap: 8, alignItems: "center", padding: "9px 12px", borderBottom: `1px solid ${C.line}` }}>
        <b style={{ fontSize: 12.5 }}>{kind}</b>
        <span
          style={{
            fontSize: 9, fontWeight: 700, letterSpacing: 0.6, padding: "2px 7px", borderRadius: 4,
            color: status.tone, border: `1px solid ${status.tone}55`, background: `${status.tone}14`,
          }}
        >
          {status.label}
        </span>
        <span style={{ marginLeft: "auto", display: "flex", gap: 6, alignItems: "center" }}>
          {upload && (
            <label
              title={upload.title}
              style={{
                display: "inline-flex", alignItems: "center", gap: 5, font: "inherit",
                fontSize: 10.5, cursor: "pointer", padding: "2px 8px", borderRadius: 5,
                color: C.accent, border: `1px solid ${C.accent}55`, background: "transparent",
              }}
            >
              {upload.label}
              <input
                type="file"
                accept={upload.accept}
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = "";
                  if (f) upload.onFile(f);
                }}
              />
            </label>
          )}
          {onRevert && (
            <DiscardButton
              what="this document"
              title={revertTitle ?? "Throw this document away — the screens return to what the tool can honestly serve without it."}
              onDiscard={onRevert}
              refusedBecause={mayRevert ? undefined : refusal("commit_document")}
            />
          )}
        </span>
      </header>
      <div style={{ padding: "9px 12px", display: "flex", flexDirection: "column", gap: 5 }}>
        <div style={{ fontSize: 12, color: C.bright, fontFamily: "monospace", wordBreak: "break-all" }}>{name}</div>
        {lines.map((l) => (
          <div key={l.text} style={{ fontSize: 11.5, color: l.tone ?? C.dim }} title={l.gloss}>
            {l.text}
          </div>
        ))}
        {extra}
        {upload && (
          <div style={{ fontSize: 10, color: C.faint }}>
            …or drop the file anywhere on this card
            {!mayCommit && who && (
              <span style={{ color: C.warn }} title={refusal(commitCapability)}>
                {" · "}anyone may dry-run; committing needs {holders || "a role that holds it"}
              </span>
            )}
          </div>
        )}
        {importHint && onOpenHome && (
          <button
            onClick={onOpenHome}
            title="Open this document's home screen — the same door lives there beside the data it feeds."
            style={{
              alignSelf: "flex-start", marginTop: 3, font: "inherit", fontSize: 10.5, cursor: "pointer",
              padding: "2px 8px", borderRadius: 5, color: C.accent, background: "transparent",
              border: `1px solid ${C.accent}55`,
            }}
          >
            {importHint} →
          </button>
        )}
      </div>
    </section>
  );
}

// The rule table's card on Data Sources — the safety authority's document
// through its door, and the one place they sign it.
//
// The card reads the same endpoint every trace is judged under, so it can
// never disagree with the Sequence Board about whose rules are in force. A
// CSV upload is a dry run first: every row's line, what it fires on today,
// which spaces would change state, the findings — then Confirm through the
// board's shared staging area, gated by commit_document like every door.
// Sign is a separate deed (sign_rule_table, Safety alone): the statement is
// shown and editable, the button names the signer, and the server refuses a
// hash that is not the stored table's. Discard reverts to the seed.

import { useEffect, useState } from "react";
import {
  exportRuleTableCsv,
  getRuleTable,
  importRuleTable,
  revertRuleTable,
  signRuleTable,
  type Identity,
  type RuleTableImport,
  type RuleTableInfo,
} from "./api";
import { fmtStamp } from "./clock";
import { useIdentity } from "./identity";
import {
  inForceLine,
  movedLine,
  signStatement,
  signoffLine,
  signoffTitle,
  statusOf,
  tableRows,
  workTypeLine,
} from "./ruleTable";
import { SourceCard } from "./SourceCard";
import { C, commitBtnStyle, errText, tdStyle, thStyle } from "./theme";

/** What the board stages for Confirm: the same shape as every other door's. */
export interface StagedRuleTable {
  kind: "Rule table";
  label: string;
  sizeBytes: number;
  summary: string;
  commit: () => Promise<string>;
}

const smallBtn = (tone: string, allowed = true): React.CSSProperties => ({
  font: "inherit", fontSize: 10.5, cursor: allowed ? "pointer" : "not-allowed", padding: "2px 8px",
  borderRadius: 5, color: allowed ? tone : C.faint, background: "transparent",
  border: `1px solid ${allowed ? tone : C.line}${allowed ? "55" : ""}`,
});

export function RuleTableCard({
  identity,
  vesselId,
  nonce,
  stagedKind,
  onStage,
  onMutated,
  onMsg,
  onOpenModule,
}: {
  identity: Identity;
  vesselId: string;
  /** Bumped by the board after any commit or revert; the card re-reads. */
  nonce: number;
  /** The kind of the document staged on the board, if any — the fold shows
   *  only while it is this card's. */
  stagedKind: string | null;
  onStage: (s: StagedRuleTable) => void;
  onMutated: () => void;
  onMsg: (msg: string | null) => void;
  onOpenModule: (moduleId: string) => void;
}) {
  const { who, can, refusal } = useIdentity();
  /** The table in force as served. Null while the read is failing. */
  const [info, setInfo] = useState<RuleTableInfo | null>(null);
  const [failed, setFailed] = useState(false);
  /** The dry run under the staged upload — rows, moved spaces, findings. */
  const [fold, setFold] = useState<RuleTableImport | null>(null);
  /** The signature in progress: the statement being edited. Null = not signing. */
  const [draft, setDraft] = useState<string | null>(null);
  const [signing, setSigning] = useState(false);

  useEffect(() => {
    let stale = false;
    setFailed(false);
    getRuleTable(identity, vesselId)
      .then((r) => {
        if (!stale) setInfo(r);
      })
      .catch(() => {
        if (!stale) {
          setInfo(null);
          setFailed(true);
        }
      });
    return () => {
      stale = true;
    };
  }, [identity, vesselId, nonce]);

  // The fold belongs to the staged upload: when the board's staging area
  // moves on (Confirm, Cancel, another card), the fold goes with it.
  useEffect(() => {
    if (stagedKind !== "Rule table") setFold(null);
  }, [stagedKind]);

  // A hull switch, a re-read, a role switch: a half-written statement must
  // not ride along to a different table or a different person.
  useEffect(() => {
    setDraft(null);
  }, [vesselId, info?.table_hash, who?.person.id]);

  const stage = (file: File) => {
    onMsg(null);
    file
      .text()
      .then((csv) =>
        importRuleTable(identity, vesselId, file.name, csv, true).then((r) => {
          setFold(r);
          const p = r.preview;
          const warns = r.findings.filter((f) => f.severity === "warn");
          onStage({
            kind: "Rule table",
            label: file.name,
            sizeBytes: file.size,
            summary:
              `${p.in_force} entr${p.in_force === 1 ? "y" : "ies"} in force from ${p.rows.length} rows · replaces ${p.replaces.label} (${p.replaces.source}) · ${movedLine(p.moved)}` +
              (warns.length > 0 ? ` · ⚠ ${warns.length} finding${warns.length === 1 ? "" : "s"} below` : " · no findings") +
              " — Confirm puts this table in force on every trace and clears any signature",
            commit: () =>
              importRuleTable(identity, vesselId, file.name, csv, false).then(
                (x) => `✓ ${x.label}: ${x.preview.in_force} entries in force — unsigned until the safety authority signs it here`,
              ),
          });
        }),
      )
      .catch((e: unknown) => onMsg(errText(e)));
  };

  const exportCsv = () => {
    onMsg(null);
    exportRuleTableCsv(identity, vesselId)
      .then((csv) => {
        const blob = new Blob([csv], { type: "text/csv" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url;
        link.download = info?.source === "document" ? info.label : "rule-table-seed.csv";
        link.click();
        URL.revokeObjectURL(url);
      })
      .catch((e: unknown) => onMsg(errText(e)));
  };

  const maySign = can("sign_rule_table");
  const signable = info !== null && info.source === "document" && info.signoff === null;
  const signTitle = !maySign
    ? refusal("sign_rule_table")
    : info === null
      ? "rule table unavailable"
      : info.source === "seed"
        ? "The seed is not signed here — upload and commit a table first; the signature is of a committed hash."
        : info.signoff
          ? `Already signed: ${signoffTitle(info.signoff)}. A recommit unsigns it.`
          : "Sign the table in force under your name: the statement and the table's hash go into the ledger, and every trace is judged by rows you signed. Any later commit clears the signature.";

  const sign = () => {
    if (!info || draft === null) return;
    setSigning(true);
    onMsg("⏳ signing the rule table…");
    signRuleTable(identity, vesselId, draft, info.table_hash)
      .then((r) => {
        setSigning(false);
        setDraft(null);
        onMsg(`✓ signed by ${r.signoff.signer_name} — ledger #${r.signoff.ledger_seq}`);
        onMutated();
      })
      .catch((e: unknown) => {
        setSigning(false);
        onMsg(errText(e));
      });
  };

  const signoff = info ? signoffLine(info, fmtStamp) : null;
  const wt = info ? workTypeLine(info.work_types) : null;
  const findings = info?.findings.filter((f) => f.severity === "warn") ?? [];

  return (
    <SourceCard
      kind="Rule table"
      status={info ? statusOf(info) : { label: "UNAVAILABLE", tone: C.danger }}
      name={
        info
          ? info.source === "document"
            ? info.label
            : "the seed — the hot-work-only table the pilot runs until one is committed"
          : failed
            ? "rule table unavailable"
            : "reading the rule table…"
      }
      wide={fold !== null}
      lines={[
        ...(info
          ? [
              {
                text: inForceLine(info),
                gloss:
                  "The rows the engine runs: each binds by work type, register category and effective range, and every trace carries its content-addressed version id. Rows that need a permit object stay on file with their reason and compile to nothing.",
              },
              {
                text: signoff?.text ?? "",
                tone: signoff?.tone === "ok" ? C.ok : C.warn,
                gloss: info.signoff
                  ? signoffTitle(info.signoff)
                  : "The safety authority signs a committed table's hash; the signature is recorded on the document and in the ledger under their person, and any later commit clears it.",
              },
              {
                text: wt?.text ?? "",
                tone: wt?.unbound ? C.warn : C.dim,
                gloss: "What the served schedule carries per work type (from the field map) against what the table's rows name. A work type no row names is judged by the any-work rows only — never by nothing.",
              },
              ...findings.map((f) => ({ text: `⚠ ${f.text}`, tone: C.warn })),
            ]
          : [{ text: failed ? "the read failed, so nothing is shown rather than the seed" : "…", tone: failed ? C.danger : C.dim }]),
      ]}
      extra={
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
            <button
              onClick={exportCsv}
              disabled={!info}
              title="Download the table in force in the handoff's own 22 columns — the twelve the sitting starts from, the nine compile columns, the version id. What the safety authority edits and brings back."
              style={smallBtn(C.accent, !!info)}
            >
              ⭳ Export CSV
            </button>
            <button
              onClick={() => {
                if (!info) return;
                setDraft(draft === null ? signStatement(info, who?.person.name ?? "the signer") : null);
              }}
              disabled={!maySign || !signable || signing}
              title={signTitle}
              style={smallBtn(C.ok, maySign && signable && !signing)}
            >
              {draft === null ? "✎ Sign this table" : "Cancel signing"}
            </button>
            {!maySign && who && (
              <span style={{ fontSize: 10, color: C.warn }} title={refusal("sign_rule_table")}>
                {refusal("sign_rule_table")}
              </span>
            )}
          </div>
          {draft !== null && info && (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, padding: "8px 10px", border: `1px solid ${C.ok}55`, borderRadius: 7, background: "rgba(34,197,94,0.05)" }}>
              <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: C.ok }}>
                Signing {info.label} · hash {info.table_hash.slice(0, 8)}… · {info.rows_in_force} entries
              </div>
              <textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={3}
                title="The statement the ledger carries under your name — edit it to what you actually attest."
                style={{ font: "inherit", fontSize: 11.5, padding: "6px 8px", background: "#0b0c0e", color: C.text, border: `1px solid ${C.line}`, borderRadius: 6, resize: "vertical" }}
              />
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <button
                  onClick={sign}
                  disabled={signing || draft.trim().length === 0}
                  title="Record the signature: the statement, the hash and every version in force go into the ledger under your name. Not reversible — a later commit unsigns, it does not erase."
                  style={{ ...commitBtnStyle, ...(signing || draft.trim().length === 0 ? { opacity: 0.6, cursor: "not-allowed" } : {}) }}
                >
                  Sign as {who?.person.name ?? "…"}
                </button>
                <span style={{ fontSize: 10.5, color: C.dim }}>
                  recorded in the ledger as RULE_TABLE_SIGNED under {who?.person.id ?? "the asserted person"}
                </span>
              </div>
            </div>
          )}
          {fold && stagedKind === "Rule table" && <RuleFold fold={fold} />}
        </div>
      }
      upload={{
        label: "⭱ Upload rule table CSV",
        accept: ".csv,text/csv,text/plain",
        title:
          "The safety authority's rule table (the handoff's twelve columns verbatim and in order, then the nine compile columns, then an optional version id). Refused whole with every reason; the preview reports what each row fires on today and which spaces change state before Confirm. Committing clears any signature.",
        onFile: stage,
      }}
      importHint="Judges every row on the Sequence Board"
      onOpenHome={() => onOpenModule("sequenceBoard")}
      revertTitle="Back to the seed — the hot-work-only table, unsigned. Every trace carries the seed's ids again."
      onRevert={
        info?.source === "document"
          ? () => {
              onMsg("⏳ discarding the rule table…");
              void revertRuleTable(identity, vesselId)
                .then(() => {
                  onMsg("✓ back to the seed — unsigned, every trace carries the seed's ids again");
                  onMutated();
                })
                .catch((e: unknown) => onMsg(errText(e)));
            }
          : undefined
      }
    />
  );
}

/** The dry run under the staged upload: findings, every row, the spaces that move. */
function RuleFold({ fold }: { fold: RuleTableImport }) {
  const p = fold.preview;
  const rows = tableRows(p.rows);
  const th: React.CSSProperties = { ...thStyle, fontSize: 9.5, padding: "4px 8px" };
  const td: React.CSSProperties = { ...tdStyle, fontSize: 10.5, padding: "3px 8px" };
  const wt = workTypeLine(p.work_types);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 4, padding: "8px 10px", border: "1px solid #f59e0b66", borderRadius: 7, background: "rgba(245,158,11,0.05)" }}>
      <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase", color: C.warn }}>
        Dry run · {fold.label} · hash {fold.table_hash.slice(0, 8)}… — previewed, nothing stored
      </div>
      <div style={{ fontSize: 11.5, color: C.bright }}>
        {p.in_force} entr{p.in_force === 1 ? "y" : "ies"} in force from {p.rows.length} rows · replaces{" "}
        <b>{p.replaces.label}</b> ({p.replaces.source}) ·{" "}
        <span style={{ color: p.moved.spaces > 0 ? C.warn : C.ok }}>{movedLine(p.moved)}</span>
      </div>
      <div style={{ fontSize: 11, color: wt.unbound ? C.warn : C.dim }}>{wt.text}</div>
      {fold.findings.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, display: "flex", flexDirection: "column", gap: 2 }}>
          {fold.findings.map((f) => (
            <li key={f.text} style={{ color: f.severity === "warn" ? C.warn : C.dim }}>
              {f.severity === "warn" ? "⚠ " : ""}
              {f.text}
            </li>
          ))}
        </ul>
      )}
      <div style={{ overflowX: "auto" }}>
        <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 760 }}>
          <thead>
            <tr>
              {["Row", "Name", "State", "Reach", "Work", "Hold", "Fires on today", "Version"].map((h) => (
                <th key={h} style={th}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.ref} style={{ opacity: r.compiled ? 1 : 0.6 }} title={r.whyNot ?? undefined}>
                <td style={{ ...td, fontFamily: "monospace", color: C.bright, whiteSpace: "nowrap" }}>{r.ref}</td>
                <td style={td}>{r.name}</td>
                {r.compiled ? (
                  <>
                    <td style={{ ...td, fontWeight: 700, color: r.state === "BLOCK" ? C.danger : r.state === "SUSPEND" ? C.warn : r.state === "WARN" ? "#c4b5fd" : C.ok }}>{r.state}</td>
                    <td style={{ ...td, fontFamily: "monospace" }}>{r.reach}</td>
                    <td style={{ ...td, fontFamily: "monospace" }}>{r.work}</td>
                    <td style={td}>{r.hold}</td>
                    <td style={td}>{r.fires}</td>
                    <td style={{ ...td, fontFamily: "monospace", color: C.dim }}>{r.version}</td>
                  </>
                ) : (
                  <td colSpan={6} style={{ ...td, color: C.dim }}>not compiled — {r.whyNot}</td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

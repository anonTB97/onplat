// The field guide: how to run this tool, written down where the tool lives.
//
// Every other screen assumes the reader already knows the doctrine — marks
// not filters, graded provenance, decisions on the ledger. This page is
// where a new planner, a zone manager on their first Monday, or an operator
// handed the wall display learns it: what the tool is for, how a schedule
// comes in, what the marks mean, and the order a large ingest is actually
// digested in. It is prose about the tool, so it is the one screen allowed
// to be mostly words — everything it claims links to the screen that proves
// it.

import { ModuleHeader } from "./ModuleHeader";
import { C } from "./theme";

function Section({
  n,
  title,
  children,
}: {
  n: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section style={{ border: `1px solid ${C.line}`, borderRadius: 8, background: C.panel, padding: "12px 16px" }}>
      <h2 style={{ fontSize: 14, margin: "0 0 8px" }}>
        <span style={{ color: C.accent, fontFamily: "monospace", marginRight: 8 }}>{n}</span>
        {title}
      </h2>
      <div style={{ fontSize: 12.5, lineHeight: 1.55, color: C.text }}>{children}</div>
    </section>
  );
}

/** A jump into the screen a claim is made about. */
function Go({ to, label, onOpenModule }: { to: string; label: string; onOpenModule: (id: string) => void }) {
  return (
    <button
      onClick={() => onOpenModule(to)}
      title={`Open ${label}`}
      style={{
        font: "inherit", fontSize: 11, cursor: "pointer", padding: "0px 7px 1px", borderRadius: 5,
        color: C.accent, background: "transparent", border: `1px solid ${C.accent}44`,
        verticalAlign: "baseline",
      }}
    >
      {label} →
    </button>
  );
}

const dt: React.CSSProperties = { color: C.bright, fontWeight: 700 };
const mono: React.CSSProperties = { fontFamily: "monospace", fontSize: 11.5 };
const dim: React.CSSProperties = { color: C.dim };

export default function FieldGuide({ onOpenModule }: { onOpenModule: (id: string) => void }) {
  return (
    <div>
      <ModuleHeader
        kicker="Field Guide"
        title="How to run this tool"
        stats={[
          { value: "5", label: "import doors", title: "Schedule (P6 XER), zone chart, budget book, manning book, geometry register (CSV) — each with a dry run, a confirm, and a revert." },
          { value: "5", label: "reports", title: "Shift sheet, zone day sheet, compartment card, conflict log, field-condition register — dated cuts that print and export." },
          { value: "4", label: "location grades", title: "Authored · derived (≈) · WBS zone hint · unlocated. Guessing is allowed because it is graded and reported; guessing silently is forbidden." },
          { value: "1", label: "ledger", title: "Every decision a planner records lands in one tamper-evident, hash-chained ledger." },
        ]}
        note="Decision support — this tool flags risk; the planner decides. It never modifies the schedule of record: P6 stays the plan's home, this is where the plan meets the ship's authorization state."
      />

      <div style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fit,minmax(430px,1fr))", alignItems: "start", maxWidth: 1180 }}>
        <Section n="01" title="What this is, in one paragraph">
          <p style={{ margin: "0 0 8px" }}>
            The yard&apos;s schedule says <i>when</i>; the ship&apos;s authorization state says{" "}
            <i>whether</i>. This tool holds both and refuses to let them disagree silently: every
            scheduled activity is evaluated against the hull&apos;s live hazards over its planned
            window, and work that cannot execute as planned is a named, evidenced finding — not a
            surprise on a deck. Everything on screen is served from one engine, so two screens can
            never disagree about what is held.
          </p>
          <p style={{ margin: 0, ...dim }}>
            Data here is illustrative and notional; the plates are a public document with notional
            pins. The posture is sovereign/IL5: nothing leaves the node.
          </p>
        </Section>

        <Section n="02" title="Bring the schedule in">
          <p style={{ margin: "0 0 8px" }}>
            <Go to="sources" label="Data Sources" onOpenModule={onOpenModule} /> is the front door:
            every card is a document&apos;s door — pick a file or drop it on the card. The schedule
            door takes a Primavera <b>P6 XER export</b> at full production scale (the ceiling is 256
            MB); the zone chart and budget book take CSV. Each door also lives on its home screen
            (<Go to="sequenceBoard" label="Sequence Board" onOpenModule={onOpenModule} />,{" "}
            <Go to="deckExplorer" label="Deck Explorer" onOpenModule={onOpenModule} />,{" "}
            <Go to="workOrders" label="Work Orders" onOpenModule={onOpenModule} />).
          </p>
          <p style={{ margin: "0 0 8px" }}>
            <span style={dt}>Nothing lands blind.</span> Every upload stages a server-side{" "}
            <b>dry run</b> — activity and edge counts, the location-mapping report, the hours
            reconciliation — behind one Confirm/Cancel bar. Imports are{" "}
            <b>all-or-nothing</b>: one rejected line refuses the file with every reason listed at
            once. And every door has a <b>revert</b>: taking a document back out is one click, and
            the screens return to what the tool can honestly serve without it.
          </p>
          <p style={{ margin: 0, ...dim }}>
            A realistic hull ships in the repo as documents: <span style={mono}>reference/cvn73/</span>{" "}
            — a 476-space compartment register on twelve decks, a zone chart of 3-D blocks, a
            coupling register, a geometry register and a morning&apos;s field-condition log — and{" "}
            <span style={mono}>reference/p6-sample/CVN73-PIA26-full.xer</span>, about 5,700
            activities across all six zones, statused to a data date, with every grading path
            represented. The demo boots on them (<span style={mono}>WADL_DEMO_DOCS</span>); the
            scheme is written up in <span style={mono}>docs/zone-scheme.md</span>.
          </p>
        </Section>

        <Section n="03" title="Read the grades — where work is, and how sure we are">
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12 }}>
            <tbody>
              {[
                ["3-148-2-E", "plain chip", "Authored: the schedule's own compartment field said where. High trust."],
                ["≈ 3-185-0-L", "amber, dashed", "Derived: a compartment number read out of the task's own name (the placard stencilled at a space's door). The parser's guess — graded, listed at import, marked everywhere it appears."],
                ["not located · Z5 per WBS", "amber text", "A zone HINT from where the task sits in the WBS tree. Places work at zone grain on zone boards, and nothing finer — never on a deck plan."],
                ["not located", "amber text", "The schedule did not say. Visible on the register, undrawable on the ship, and unassessable by the engine — unknown is never presented as fine."],
                ["unknown space", "red", "Located to a compartment this hull's register does not carry — mapped, and to nowhere the hull knows. The crosswalk gap to chase first."],
              ].map(([mark, look, meaning]) => (
                <tr key={mark}>
                  <td style={{ padding: "4px 10px 4px 0", whiteSpace: "nowrap", ...mono, color: C.bright }}>{mark}</td>
                  <td style={{ padding: "4px 10px 4px 0", whiteSpace: "nowrap", color: C.dim, fontSize: 10.5 }}>{look}</td>
                  <td style={{ padding: "4px 0", color: C.text }}>{meaning}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <p style={{ margin: "8px 0 0", ...dim }}>
            The rule behind the marks: guessing is allowed <i>because</i> it is graded and
            reported. Guessing silently is forbidden.
          </p>
        </Section>

        <Section n="04" title="Digest a large ingest, in order">
          <ol style={{ margin: 0, paddingLeft: 20, display: "flex", flexDirection: "column", gap: 5 }}>
            <li>
              <Go to="sources" label="Data Sources" onOpenModule={onOpenModule} /> — what is this
              hull actually running on? Ingested or generated, authored or inferred, and whether
              the documents agree with each other.
            </li>
            <li>
              <Go to="sequenceBoard" label="Sequence Board" onOpenModule={onOpenModule} /> →{" "}
              <b>Load digest</b> — the whole availability as a zone × week (or month) heat map.
              Find the loud cells; the red counts are refusals. This is the first read, before any
              Gantt.
            </li>
            <li>
              <b>Zone lanes</b> — wheel-zoom into the loud window. The gutter answers a zone
              manager&apos;s three questions: what runs in my zone this week, what of it is
              refused, and what is coming from the neighbouring lanes. Red arrows are negative
              lags — overlaps written into the schedule&apos;s own logic.
            </li>
            <li>
              <b>Space lanes</b> or the register&apos;s space filter — the sequence inside one
              compartment, at the grain a crew is handed.
            </li>
            <li>
              <Go to="deckExplorer" label="Deck Explorer" onOpenModule={onOpenModule} /> — the
              space itself: click any chip anywhere and land on the plates with the hold&apos;s
              evidence and options open.
            </li>
            <li>
              <Go to="leverage" label="Conflicts & Risk" onOpenModule={onOpenModule} /> — the
              findings, ranked by man-hours at risk. Acknowledge what is answered for; the issue
              keeps deriving as long as its facts hold.
            </li>
            <li>
              <Go to="cascade" label="Deconfliction Cascade" onOpenModule={onOpenModule} /> — before
              sending anyone: pick an action and read its consequence on the whole hull, as the map
              or the 3D walkthrough (tilt it from plan to exploded; the dashed purple lines are the
              hazard&apos;s actual routes).
            </li>
            <li>
              Decide on the space&apos;s options panel — and{" "}
              <Go to="ledger" label="Decisions Ledger" onOpenModule={onOpenModule} /> remembers, in
              a hash-chained record verified on every read.
            </li>
          </ol>
        </Section>

        <Section n="05" title="Run the week">
          <p style={{ margin: "0 0 8px" }}>
            <span style={dt}>Monday:</span> Load digest at week grain for the coming month, then
            your zone&apos;s lane. <span style={dt}>Every shift:</span>{" "}
            <Go to="dailyOps" label="Daily Ops" onOpenModule={onOpenModule} /> — the day&apos;s
            slice per shift, printable as the pass-down board.{" "}
            <span style={dt}>Continuously:</span> the time control up top is one instant for the
            whole app — scrub it and every screen answers for the same moment.
          </p>
          <p style={{ margin: 0 }}>
            <span style={dt}>The one discipline to keep:</span> the instant <i>marks</i> rows in or
            out of their window — it never filters them. An omission is indistinguishable from
            missing data, so nothing on these boards is ever quietly hidden: filters you choose are
            highlighted, and counts always say what they are not showing.
          </p>
        </Section>

        <Section n="06" title="Controls, everywhere the same">
          <p style={{ margin: "0 0 8px", fontSize: 12 }}>
            <span style={dt}>Three words the boards use constantly:</span>{" "}
            <b style={{ color: C.bright }}>MH</b> is man-hours — every workload number here.{" "}
            <b style={{ color: C.bright }}>Edges</b> (the arrows, and the Logic CSV) are the
            schedule&apos;s dependency links: which activity waits on which, and by how much.{" "}
            <b style={{ color: C.bright }}>Stranded</b> hours are finished or finishable work that
            still cannot proceed — installed pipe that cannot be tested because a space upstream
            is held. Stranding is what the biggest red numbers on Conflicts &amp; Risk are made of.
          </p>
          <table style={{ borderCollapse: "collapse", fontSize: 12 }}>
            <tbody>
              {[
                ["wheel", "zooms every time axis and deck plan, around the cursor"],
                ["drag", "pans a zoomed canvas"],
                ["column header ×3", "sort ascending → descending → back to schedule order"],
                ["click a row or bar", "the activity inspector: details, refusal evidence, the engine's suggested alternative, and the space's options — in place"],
                ["← →", "step a 3D walkthrough; the tilt slider re-angles it from plan to exploded"],
                ["chips & filters", "narrow — they are your question; the time control only marks"],
                ["the URL", "carries hull, screen, instant and space — send a colleague exactly what you see"],
              ].map(([k, v]) => (
                <tr key={k}>
                  <td style={{ padding: "3px 14px 3px 0", whiteSpace: "nowrap", ...mono, color: C.bright }}>{k}</td>
                  <td style={{ padding: "3px 0", color: C.text }}>{v}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Section>
      </div>
    </div>
  );
}

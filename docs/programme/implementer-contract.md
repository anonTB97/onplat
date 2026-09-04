# Implementer contract

Applies to every agent that builds a slice of the pilot programme. The
designs are in this directory; `programme.md` fixes the order, the migration
numbers and the shared contracts.

**Where.** `/home/user/shipyardaionboard` on branch `claude/kickoff-from-docs-arhiib`.
Work directly on this tree; one agent builds at a time. Start with
`git status --short` and `git log --oneline -3`; if the tree is dirty from a
previous agent, do not discard it: read the diff and continue from it.

**Gates.** All green before a commit; run them, do not assume.

```
cargo fmt --all
RUSTFLAGS="-D warnings" cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace --all-features
cargo run -q --locked -p xtask -- gen-leak-tests && cargo run -q --locked -p xtask -- gen-ssp   # if a route changed
DATABASE_URL=postgres://postgres@127.0.0.1:55433/wadl cargo test -p wadl-store --features postgres --test pg_rls   # if migrations or pg_repo.rs changed
cd shell-web && npm run -s typecheck && npx vitest run && npm run -s build
```

Pedantic clippy is on: keep functions under the `too_many_lines` limit by
extracting helpers; never index a slice or a serde `Value` (use `.get`);
avoid similar names; no statements after items.

**Conventions.** No new runtime dependency without a written reason in the
commit message. New API code goes in new modules under `crates/wadl-api/src/`,
not into `handlers.rs`. Both stores (`memory.rs` and `pg_repo.rs`) implement
every new `Repositories` method. Every document commit or revert and every
decision writes the ledger. Every read takes `as_of`. A failed read renders
"unavailable" in the shell, never an empty list. Every figure carries its
provenance. Labels use yard words. A new shell module is registered in
`App.tsx`'s `MODULES` list and gets a Field Guide paragraph.

**Commit.** Commit and push at EVERY green checkpoint, not only at the end:
the sitting can be cut off at any moment by the session's usage limit and
the container is reclaimed with everything uncommitted. A checkpoint is a
state where `cargo build --workspace --all-targets --all-features` and the
shell typecheck pass; tests may still be red at a checkpoint if the message
says so ("checkpoint: door module compiles; tests next"). The final commit of
a slice has every gate green. Author every commit as

```
git -c user.name="Claude" -c user.email="noreply@anthropic.com" commit -F <msgfile>
```

The message: a headline in the codebase's voice (what changed and why it
matters to the yard), a body with the design decisions and any dependency
reason, then exactly these two trailer lines:

```
Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01YRBej8TEXhBQGoSv6HkkhA
```

No model identifier anywhere else (code, docs, comments).

**Push.** `git push -u origin claude/kickoff-from-docs-arhiib`, retrying with
2s/4s/8s/16s backoff on network errors. Never another branch. Never a pull
request.

**Record.** Add or update the slice's row in `docs/execution-plan.md`
("landed `<short-hash>`", one sentence per delivered behaviour, a "Deferred:"
clause for anything cut) in the same commit or a follow-up.

**Verify in the browser** when the slice has a screen. Release API:

```
cargo build -q --release -p wadl-api --bin serve   # if Rust changed
setsid env WADL_PORT=8080 WADL_DEMO_DOCS=reference/cvn73 WADL_SCHEDULE_XER=reference/p6-sample/CVN73-PIA26-full.xer ./target/release/serve > /tmp/serve.log 2>&1 &
(cd shell-web && setsid nohup npx vite --port 5173 --strictPort > /tmp/vite.log 2>&1 &)
```

Playwright: `import { chromium } from "/home/user/shipyardaionboard/shell-web/node_modules/playwright-core/index.mjs"`,
`executablePath: "/opt/pw-browsers/chromium"`. Hash routes are
`#/{vesselUuid}/{moduleId}`; the reference hull is
`00000000-0000-0000-0000-000000000073`; go via `about:blank` between URLs.
Identity headers: `x-org-id: 00000000-0000-0000-0000-000000000001`,
`x-assigned-vessels: <uuid>`. Stop the API with `kill $(pgrep -x serve)`
(`pkill -f` matches itself). Screenshot your screen and look at it.

**Report** (data for the orchestrator, not prose for a human): what landed,
commit hashes, what was deferred and why, the last lines of every gate,
contracts and names the next slice must know, open risks.

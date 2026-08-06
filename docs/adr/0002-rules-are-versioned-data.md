# ADR 0002 — Rules are versioned data, never code

Status: accepted (milestone 1)

## Context

Thresholds, hold times and hop limits change over the life of a hull, and a
decision made in 2027 must still be explainable in 2031 after the rule has
changed twice. If a threshold lives in application code, the only record of the
rule that produced a past decision is a git history nobody will consult during a
board of inquiry.

## Decision

A rule is a row (`rule`), and the unit of truth is a *version* of it
(`rule_version`) with an effective range, a structured `trigger_expr`/
`clearing_expr` (JSON predicates, not code), thresholds in `params`, and its
governing standard edition. Every recorded decision stores the
`rule_version_id` it was made under. Editing a rule creates a new version; the
old one is retained.

No threshold, hold time, or hop limit is hard-coded. In milestone 1 the engine's
outcomes are seeded behind the `HazardKind::seed_*` functions, explicitly marked
as placeholder rule data, and every `TraceStep` already carries an
`Option<RuleVersionId>` slot so persistence never needs reshaping when the real
rule lookup lands in milestone 3.

## Consequences

Rule authoring, versioning, and binding-to-work are data operations, testable
and auditable without a deploy. The steering pack's twenty scenarios become
golden acceptance tests over stable rule versions.

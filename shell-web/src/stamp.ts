// The release stamp the bottom marking band wears: what the served binary
// says it is, so a screenshot and a support bundle name the same commit.

import type { Health } from "./api";

/** `abc1234 · schema 0018 · postgresql`, or the honest fallback. */
export function stampOf(h: Health | null | undefined): string {
  if (!h || !h.version) return "version unavailable";
  const backend = h.store?.backend ?? "store unknown";
  return `${h.version.git} · schema ${h.version.schema} · ${backend}`;
}

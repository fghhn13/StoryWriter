// Everything the canvas draws, in one JSON document (spec §7). Read-only: building the view never
// writes (stale is computed, not marked; `rerun` marks).
import { ENDPOINT_STATUSES, type Project, validateProject } from "@sw/core";
import { gapBetween } from "@sw/checks";
import { findStale, timeline } from "@sw/ops";

const OPEN = new Set(["open", "stale"]);

export function buildView(p: Project) {
  const stale = findStale(p);
  const staleIds = new Set(stale.map((s) => s.check.value.id));
  const checks = p.checks.map((c) => ({ ...c.value, file: c.file, isStale: staleIds.has(c.value.id) || c.value.status === "stale" }));
  const maxOpen = (target: string) => Math.max(0, ...checks.filter((c) => c.target === target && OPEN.has(c.status)).map((c) => c.score));

  // per snapshot: the worst thread-check score that names it as an affected node
  const threadNodeScore = new Map<string, number>();
  for (const c of checks) {
    if (c.axis !== "E" || !OPEN.has(c.status)) continue;
    const nodes = ((c as Record<string, unknown>).thread as { nodes?: { node: string; score: number }[] } | undefined)?.nodes ?? [];
    for (const n of nodes) threadNodeScore.set(n.node, Math.max(threadNodeScore.get(n.node) ?? 0, n.score));
  }

  const line = timeline(p);
  const gaps = line.slice(1).map((b, i) => {
    const g = gapBetween(line[i]!, b, p.config);
    return { from: line[i]!.id, to: b.id, score: g.score, suggest: g.suggestAddPoint, changes: g.changes };
  });
  const bridgeBetween = (a: string, b: string) => p.bridges.some((x) => x.value.from === a && x.value.to === b);

  return {
    root: p.root,
    name: p.config.name,
    lanes: p.config.lanes,
    thresholds: p.config.thresholds,
    sampling: p.config.sampling,
    voice: !!p.config.voice_sample,
    profiles: p.profiles.map((x) => ({ ...x.value, file: x.file })),
    snapshots: p.snapshots.map((x) => ({
      ...x.value,
      file: x.file,
      endpoint: ENDPOINT_STATUSES.includes(x.value.status),
      score: threadNodeScore.get(x.value.id) ?? 0,
    })),
    branches: p.branchSnapshots.map((x) => ({ ...x.value, file: x.file })),
    bridges: p.bridges.map((x) => ({ ...x.value, file: x.file, score: maxOpen(x.value.id), threadScore: threadNodeScore.get(x.value.id) ?? 0 })),
    threads: p.threads.map((x) => {
      const c = checks.find((y) => y.target === x.value.id && y.axis === "E");
      const d = (c as Record<string, unknown> | undefined)?.thread as { affected?: string[]; unpaid?: boolean } | undefined;
      return { ...x.value, file: x.file, score: c && OPEN.has(c.status) ? c.score : 0, affected: d?.affected ?? [], unpaid: d?.unpaid ?? !x.value.payoff_at, checked: !!c };
    }),
    checks,
    acceptances: p.acceptances.map((x) => ({ ...x.value, file: x.file })),
    gaps,
    missingBridges: gaps.filter((g) => !bridgeBetween(g.from, g.to)).map((g) => ({ from: g.from, to: g.to })),
    stale: stale.map((s) => ({ id: s.check.value.id, changed: s.changed })),
    issues: validateProject(p),
  };
}

export type View = ReturnType<typeof buildView>;

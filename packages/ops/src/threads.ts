// U7 插伏笔 + axis E (spec §4.4, §5-E, §6-U7).
import { DIRS, type Project, type Thread, freeFileName, laneOfProfile, profileById, renderMarkdownFile, writeProjectFile } from "@sw/core";
import { type CheckResult, type ThreadNode, checkAxisE } from "@sw/checks";
import type { LlmContext } from "@sw/llm";
import { castOf, findSnapshot, renderSnapshot } from "./brief";
import { hashAll, timeline } from "./deps";
import { saveCheck } from "./store";

export function findThread(p: Project, id: string): Thread {
  const th = p.threads.find((x) => x.value.id === id)?.value;
  if (!th) throw new Error(`找不到线：${id}`);
  return th;
}

/** Where a point sits in time. A bridge point ("b-x" or "b-x#3") sits inside the bridge: between its ends. */
function pointTime(p: Project, ref: string): { t: number; bridge?: string } {
  const id = ref.split("#")[0]!;
  const s = p.snapshots.find((x) => x.value.id === id)?.value;
  if (s) return { t: s.t };
  const b = p.bridges.find((x) => x.value.id === id)?.value;
  if (!b) throw new Error(`埋点 / 收点不存在：${ref}`);
  const from = findSnapshot(p, b.from);
  const to = findSnapshot(p, b.to);
  return { t: (from.t + to.t) / 2, bridge: b.id };
}

/**
 * Nodes after the planting point, up to the payoff (inclusive) or the end of the timeline:
 * snapshots with planted < t ≤ payoff, bridges that start at or after the planting point.
 * A bridge holding the planting point itself is not re-read (D-045).
 */
export function threadNodes(p: Project, th: Thread): ThreadNode[] {
  const planted = pointTime(p, th.planted_at);
  const payoff = th.payoff_at ? pointTime(p, th.payoff_at) : undefined;
  const end = payoff?.t ?? Infinity;
  const nodes: ThreadNode[] = [];
  for (const s of timeline(p)) {
    if (s.t > planted.t && s.t <= end) {
      nodes.push({ id: s.id, kind: "snapshot", t: s.t, content: renderSnapshot(s), isPayoff: th.payoff_at === s.id });
    }
  }
  for (const { value: b } of p.bridges) {
    if (!b.text || b.id === planted.bridge) continue;
    const from = p.snapshots.find((s) => s.value.id === b.from)?.value;
    const to = p.snapshots.find((s) => s.value.id === b.to)?.value;
    if (!from || !to) continue;
    const mid = (from.t + to.t) / 2;
    if (from.t >= planted.t && mid <= end) {
      nodes.push({ id: b.id, kind: "bridge", t: mid, content: b.text, isPayoff: th.payoff_at?.split("#")[0] === b.id });
    }
  }
  return nodes.sort((a, b) => a.t - b.t || (a.kind === "bridge" ? -1 : 1));
}

export interface ThreadCheck {
  result: CheckResult;
  saved: { id: string; file: string };
  nodes: ThreadNode[];
}

export async function checkThread(p: Project, ctx: LlmContext, id: string, opts: { n?: number; onProgress?: (m: string) => void } = {}): Promise<ThreadCheck> {
  const th = findThread(p, id);
  const nodes = threadNodes(p, th);
  const n = opts.n ?? p.config.sampling;
  const snaps = nodes.filter((x) => x.kind === "snapshot").map((x) => findSnapshot(p, x.id));
  const bridgeEnds = nodes
    .filter((x) => x.kind === "bridge")
    .flatMap((x) => {
      const b = p.bridges.find((y) => y.value.id === x.id)!.value;
      return [findSnapshot(p, b.from), findSnapshot(p, b.to)];
    });
  const cast = castOf(p, ...snaps, ...bridgeEnds);
  for (const k of th.known_by) {
    const pr = profileById(p, k);
    if (pr && !cast.some((c) => c.profile.id === pr.id)) cast.push({ lane: laneOfProfile(p, pr.id), profile: pr });
  }
  opts.onProgress?.(`轴 E · ${id}：${nodes.length} 个节点 × ${n} 次采样`);
  const result = await checkAxisE(ctx, {
    thread: { id: th.id, description: th.description, visibility: th.visibility, known_by: th.known_by, planted_at: th.planted_at, payoff_at: th.payoff_at },
    nodes,
    characters: cast.map((c) => `- [${c.profile.id}] ${c.profile.name}`).join("\n") || "（无）",
    n,
    warn: p.config.thresholds.E.warn,
  });
  const keys = [
    `thread:${th.id}`,
    ...nodes.map((x) => (x.kind === "snapshot" ? `snapshot:${x.id}` : `text:${x.id}`)),
    ...cast.map((c) => `profile:${c.profile.id}`),
  ];
  const saved = saveCheck(p, th.id, result, hashAll(p, keys), "thread");
  return { result, saved, nodes };
}

export interface NewThread {
  id: string;
  description: string;
  planted_at: string;
  payoff_at?: string;
  visibility: Thread["visibility"];
  known_by?: string[];
}

/** Write threads/<id>.md (U7). Validation of the points happens in validateProject. */
export function addThread(p: Project, t: NewThread): string {
  if (p.threads.some((x) => x.value.id === t.id)) throw new Error(`线 id 已存在：${t.id}`);
  pointTime(p, t.planted_at);
  if (t.payoff_at) pointTime(p, t.payoff_at);
  const fm: Record<string, unknown> = { id: t.id, planted_at: t.planted_at, visibility: t.visibility, status: "open" };
  if (t.payoff_at) fm.payoff_at = t.payoff_at;
  if (t.known_by?.length) fm.known_by = t.known_by;
  const file = freeFileName(p.root, DIRS.threads, t.id);
  writeProjectFile(p.root, file, renderMarkdownFile(fm, t.description));
  return file;
}

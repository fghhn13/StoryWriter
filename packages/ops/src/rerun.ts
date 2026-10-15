// U8 重算: one command reruns every stale check, after showing how many calls it will make
// (spec §6-U8). Checks are rerun per target: a bridge reruns the axes that went stale, a thread
// reruns axis E.
import { type Project, loadProject } from "@sw/core";
import { estimateCalls } from "@sw/checks";
import type { LlmContext } from "@sw/llm";
import { type BridgeAxis, checkBridge } from "./bridge";
import { castOf, findSnapshot, hash } from "./brief";
import { findStale, markStale } from "./deps";
import { findBridge } from "./store";
import { checkThread, findThread, threadNodes } from "./threads";

export interface RerunItem {
  kind: "bridge" | "thread";
  target: string;
  axes: string[];
  checks: string[];
  n: number;
  calls: number;
}

export interface RerunPlan {
  items: RerunItem[];
  calls: number;
  /** stale checks whose target no longer exists; they can only be deleted */
  orphans: string[];
}

export function planRerun(p: Project, opts: { n?: number } = {}): RerunPlan {
  const stale = findStale(p);
  const items = new Map<string, RerunItem>();
  const orphans: string[] = [];
  for (const { check } of stale) {
    const c = check.value;
    const exists = c.target_kind === "bridge" ? p.bridges.some((b) => b.value.id === c.target) : p.threads.some((t) => t.value.id === c.target);
    if (!exists || c.target_kind === "snapshot") {
      orphans.push(c.id);
      continue;
    }
    const key = `${c.target_kind}:${c.target}`;
    const it = items.get(key) ?? { kind: c.target_kind as "bridge" | "thread", target: c.target, axes: [], checks: [], n: 0, calls: 0 };
    if (!it.axes.includes(c.axis)) it.axes.push(c.axis);
    it.checks.push(c.id);
    it.n = Math.max(it.n, opts.n ?? c.samples?.n ?? p.config.sampling);
    items.set(key, it);
  }
  for (const it of items.values()) {
    it.axes.sort();
    if (it.kind === "thread") {
      it.calls = threadNodes(p, findThread(p, it.target)).length * it.n;
    } else {
      const b = findBridge(p, it.target).value;
      const chars = castOf(p, findSnapshot(p, b.from)).length;
      const text = it.axes.filter((a): a is "A" | "B" | "C" => a === "A" || a === "B" || a === "C");
      // axis D re-extracts only if the text changed
      const extract = b.derived_snapshot?.text_hash === hash(b.text) ? 0 : 1;
      it.calls = estimateCalls(chars, text, it.n) + (it.axes.includes("D") ? it.n + extract : 0);
    }
  }
  const list = [...items.values()];
  return { items: list, calls: list.reduce((s, i) => s + i.calls, 0), orphans };
}

export async function rerunStale(p: Project, ctx: LlmContext, plan: RerunPlan, onProgress?: (m: string) => void): Promise<{ rerun: string[]; stillStale: string[] }> {
  markStale(p);
  const rerun: string[] = [];
  for (const it of plan.items) {
    const fresh = loadProject(p.root);
    onProgress?.(`重跑 ${it.kind === "bridge" ? "桥" : "线"} ${it.target}：轴 ${it.axes.join("、")}`);
    if (it.kind === "bridge") {
      const r = await checkBridge(fresh, ctx, it.target, { axes: it.axes as BridgeAxis[], n: it.n, onProgress });
      rerun.push(...r.saved.map((s) => s.id));
    } else {
      const r = await checkThread(fresh, ctx, it.target, { n: it.n, onProgress });
      rerun.push(r.saved.id);
    }
  }
  const stillStale = findStale(loadProject(p.root)).map((s) => s.check.value.id);
  return { rerun, stillStale };
}

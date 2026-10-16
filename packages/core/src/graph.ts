// Graph mode (D-057–D-059): snapshots are nodes, bridges are directed edges between any two nodes.
// Story time is the order along a route, so a node's t is derived: its longest-path depth.
import type { Bridge, Snapshot } from "./schema";

export interface Edge {
  id: string;
  from: string;
  to: string;
}

export interface GraphInfo {
  /** longest-path depth from any root; nodes on a cycle are absent */
  depth: Map<string, number>;
  /** node ids that sit on a cycle (an error: routes need an order) */
  cyclic: string[];
}

export function analyzeGraph(nodes: readonly string[], edges: readonly Edge[]): GraphInfo {
  const known = new Set(nodes);
  const out = new Map<string, string[]>(nodes.map((n) => [n, []]));
  const indeg = new Map<string, number>(nodes.map((n) => [n, 0]));
  for (const e of edges) {
    if (!known.has(e.from) || !known.has(e.to)) continue;
    out.get(e.from)!.push(e.to);
    indeg.set(e.to, indeg.get(e.to)! + 1);
  }
  // Kahn's algorithm: whatever never reaches in-degree 0 is on (or behind) a cycle
  const depth = new Map<string, number>();
  const queue = nodes.filter((n) => indeg.get(n) === 0);
  for (const n of queue) depth.set(n, 0);
  while (queue.length) {
    const n = queue.shift()!;
    for (const m of out.get(n)!) {
      depth.set(m, Math.max(depth.get(m) ?? 0, depth.get(n)! + 1));
      indeg.set(m, indeg.get(m)! - 1);
      if (indeg.get(m) === 0) queue.push(m);
    }
  }
  const cyclic = nodes.filter((n) => indeg.get(n)! > 0);
  for (const n of cyclic) depth.delete(n);
  return { depth, cyclic };
}

/** All nodes with a path to `node` (not including it), nearest first (BFS over reversed edges). */
export function ancestors(node: string, edges: readonly Edge[]): string[] {
  const into = new Map<string, string[]>();
  for (const e of edges) into.set(e.to, [...(into.get(e.to) ?? []), e.from]);
  const seen = new Set<string>([node]);
  const order: string[] = [];
  let frontier = [node];
  while (frontier.length) {
    const next: string[] = [];
    for (const n of frontier) {
      for (const m of into.get(n) ?? []) {
        if (seen.has(m)) continue;
        seen.add(m);
        order.push(m);
        next.push(m);
      }
    }
    frontier = next;
  }
  return order;
}

export function descendants(node: string, edges: readonly Edge[]): string[] {
  return ancestors(node, edges.map((e) => ({ id: e.id, from: e.to, to: e.from })));
}

/** The edges of a route given as a node sequence; throws if two consecutive nodes aren't connected. */
export function routeEdges<E extends Edge>(nodes: readonly string[], edges: readonly E[]): E[] {
  const out: E[] = [];
  for (let i = 1; i < nodes.length; i++) {
    const e = edges.find((x) => x.from === nodes[i - 1] && x.to === nodes[i]);
    if (!e) throw new Error(`路线断开：${nodes[i - 1]} 和 ${nodes[i]} 之间没有边`);
    out.push(e);
  }
  return out;
}

/** Overwrite each snapshot's t with its derived depth (in memory only). */
export function applyGraphTime(snapshots: { value: Snapshot }[], bridges: { value: Bridge }[]): GraphInfo {
  const info = analyzeGraph(
    snapshots.map((s) => s.value.id),
    bridges.map((b) => b.value),
  );
  for (const s of snapshots) s.value.t = info.depth.get(s.value.id) ?? 0;
  return info;
}

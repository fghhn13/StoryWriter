// World-space geometry for the board: node boxes, edge curves, hit tests.

export const NODE_W = 212;
export const NODE_H = 78;
export const PORT_R = 7;

export interface Pt {
  x: number;
  y: number;
}

export interface Camera {
  /** world point shown at the canvas origin */
  x: number;
  y: number;
  zoom: number;
}

export const toScreen = (c: Camera, p: Pt): Pt => ({ x: (p.x - c.x) * c.zoom, y: (p.y - c.y) * c.zoom });
export const toWorld = (c: Camera, p: Pt): Pt => ({ x: p.x / c.zoom + c.x, y: p.y / c.zoom + c.y });

export function inNode(pos: Pt, p: Pt): boolean {
  return p.x >= pos.x && p.x <= pos.x + NODE_W && p.y >= pos.y && p.y <= pos.y + NODE_H;
}

/** The out-port sits on the node's right edge, vertically centred. */
export const portOf = (pos: Pt): Pt => ({ x: pos.x + NODE_W, y: pos.y + NODE_H / 2 });
export const inPortOf = (pos: Pt): Pt => ({ x: pos.x, y: pos.y + NODE_H / 2 });

export function nearPort(pos: Pt, p: Pt, zoom: number): boolean {
  const q = portOf(pos);
  return Math.hypot(p.x - q.x, p.y - q.y) <= (PORT_R + 4) / zoom;
}

/** Cubic curve from a's out-port to b's in-port; control arms grow with distance. */
export function edgeCurve(a: Pt, b: Pt): [Pt, Pt, Pt, Pt] {
  const p0 = portOf(a);
  const p3 = inPortOf(b);
  const arm = Math.max(70, Math.abs(p3.x - p0.x) * 0.45, Math.abs(p3.y - p0.y) * 0.25);
  return [p0, { x: p0.x + arm, y: p0.y }, { x: p3.x - arm, y: p3.y }, p3];
}

export function bezier([p0, p1, p2, p3]: [Pt, Pt, Pt, Pt], t: number): Pt {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

export function nearCurve(curve: [Pt, Pt, Pt, Pt], p: Pt, tolerance: number): boolean {
  let prev = curve[0];
  for (let i = 1; i <= 32; i++) {
    const q = bezier(curve, i / 32);
    if (distToSegment(p, prev, q) <= tolerance) return true;
    prev = q;
  }
  return false;
}

function distToSegment(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len)) : 0;
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/** Shortest directed path a → b (BFS), or undefined. Used to auto-fill a route between clicks. */
export function shortestPath(from: string, to: string, edges: { from: string; to: string }[]): string[] | undefined {
  const prev = new Map<string, string>();
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const n = queue.shift()!;
    if (n === to) {
      const path = [to];
      while (path[0] !== from) path.unshift(prev.get(path[0]!)!);
      return path;
    }
    for (const e of edges) {
      if (e.from !== n || seen.has(e.to)) continue;
      seen.add(e.to);
      prev.set(e.to, n);
      queue.push(e.to);
    }
  }
  return undefined;
}

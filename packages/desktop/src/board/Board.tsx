// The infinite canvas (D-066): everything on the board is drawn with Canvas2D; only panels are DOM.
// Pan: drag empty space (or middle mouse). Zoom: wheel / pinch. Double-click empty: new node.
// Drag a node's right-hand port onto another node: new edge.
import { useCallback, useEffect, useImperativeHandle, useRef, type Ref } from "react";
import { type GraphView, type Level, type Selection, edgeLevel } from "../types";
import {
  type Camera,
  NODE_H,
  NODE_W,
  PORT_R,
  type Pt,
  bezier,
  edgeCurve,
  inNode,
  nearCurve,
  nearPort,
  portOf,
  toScreen,
  toWorld,
} from "./geometry";

export type BoardMode = "select" | "route";

export interface BoardApi {
  fit(): void;
  /** world point at the centre of the visible area (for "Add node") */
  center(): Pt;
}

export interface BoardProps {
  view: GraphView;
  selection: Selection;
  mode: BoardMode;
  /** route being highlighted (saved route or the draft being clicked together) */
  highlight: string[];
  apiRef: Ref<BoardApi>;
  onSelect(s: Selection): void;
  onMove(positions: Record<string, Pt>): void;
  onCreateNode(at: Pt): void;
  onConnect(from: string, to: string): void;
  onRouteClick(node: string): void;
}

type Drag =
  | { kind: "pan"; start: Pt; cam: Camera; moved: boolean }
  | { kind: "node"; id: string; offset: Pt; moved: boolean }
  | { kind: "connect"; from: string; at: Pt }
  | null;

const LEVEL_VAR: Record<Level, string> = { none: "--edge-none", ok: "--edge-ok", warn: "--edge-warn", high: "--edge-high" };

function palette() {
  const s = getComputedStyle(document.documentElement);
  const v = (name: string) => s.getPropertyValue(name).trim();
  return {
    bg: v("--board-bg"),
    dot: v("--board-dot"),
    node: v("--node-bg"),
    nodeBorder: v("--node-border"),
    text: v("--text"),
    muted: v("--muted"),
    accent: v("--accent"),
    route: v("--route"),
    level: (l: Level) => v(LEVEL_VAR[l]),
    labelBg: v("--label-bg"),
  };
}

function ellipsize(ctx: CanvasRenderingContext2D, text: string, max: number): string {
  if (ctx.measureText(text).width <= max) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (ctx.measureText(text.slice(0, mid) + "…").width <= max) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo) + "…";
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

const FONT = `"Segoe UI", "Microsoft YaHei UI", "PingFang SC", system-ui, sans-serif`;

export function Board(props: BoardProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cam = useRef<Camera>(loadCamera(props.view.root));
  const drag = useRef<Drag>(null);
  /** positions being dragged, until the server echoes them back */
  const local = useRef(new Map<string, Pt>());
  const hover = useRef<{ node?: string; edge?: string; port?: string }>({});
  const frame = useRef(0);
  const latest = useRef(props);
  latest.current = props;

  const posOf = useCallback((id: string): Pt | undefined => local.current.get(id) ?? latest.current.view.nodes.find((n) => n.id === id)?.pos, []);

  const draw = useCallback(() => {
    frame.current = 0;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d")!;
    const { view, selection, highlight, mode } = latest.current;
    const c = cam.current;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const pal = palette();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = pal.bg;
    ctx.fillRect(0, 0, w, h);

    // dot grid; spacing doubles when dots would get too dense
    let step = 40;
    while (step * c.zoom < 18) step *= 2;
    ctx.fillStyle = pal.dot;
    const x0 = Math.floor(c.x / step) * step;
    const y0 = Math.floor(c.y / step) * step;
    for (let x = x0; x < c.x + w / c.zoom; x += step) {
      for (let y = y0; y < c.y + h / c.zoom; y += step) {
        const s = toScreen(c, { x, y });
        ctx.fillRect(s.x - 0.75, s.y - 0.75, 1.5, 1.5);
      }
    }

    ctx.setTransform(dpr * c.zoom, 0, 0, dpr * c.zoom, -c.x * c.zoom * dpr, -c.y * c.zoom * dpr);
    const routeEdges = new Set<string>();
    for (let i = 1; i < highlight.length; i++) {
      const e = view.edges.find((x) => x.from === highlight[i - 1] && x.to === highlight[i]);
      if (e) routeEdges.add(e.id);
    }
    const routeNodes = new Set(highlight);
    const dimming = highlight.length > 0;

    // edges
    for (const e of view.edges) {
      const a = posOf(e.from);
      const b = posOf(e.to);
      if (!a || !b) continue;
      const curve = edgeCurve(a, b);
      const level = edgeLevel(view, e.info);
      const onRoute = routeEdges.has(e.id);
      const selected = selection?.kind === "edge" && selection.id === e.id;
      ctx.globalAlpha = dimming && !onRoute ? 0.25 : 1;
      if (onRoute) {
        ctx.strokeStyle = pal.route;
        ctx.lineWidth = 9;
        ctx.globalAlpha = 0.28;
        strokeCurve(ctx, curve);
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = selected ? pal.accent : pal.level(level);
      ctx.lineWidth = selected || hover.current.edge === e.id ? 3.5 : 2.2;
      ctx.setLineDash(e.info.checked && !e.info.stale ? [] : [7, 6]);
      strokeCurve(ctx, curve);
      ctx.setLineDash([]);
      arrow(ctx, curve, ctx.strokeStyle as string);

      // score pill at the curve's midpoint
      const mid = bezier(curve, 0.5);
      const label = !e.info.checked ? "unchecked" : `${e.info.score}${e.info.stale ? " · stale" : ""}`;
      ctx.font = `600 12px ${FONT}`;
      const lw = ctx.measureText(label).width + 16;
      roundRect(ctx, mid.x - lw / 2, mid.y - 11, lw, 22, 11);
      ctx.fillStyle = pal.labelBg;
      ctx.fill();
      ctx.strokeStyle = e.info.checked ? pal.level(level) : pal.nodeBorder;
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = e.info.checked ? pal.text : pal.muted;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(label, mid.x, mid.y + 0.5);
      if (e.info.hasText) {
        // a small "¶" mark: this edge has prose
        ctx.fillStyle = pal.muted;
        ctx.font = `12px ${FONT}`;
        ctx.fillText("¶", mid.x + lw / 2 + 9, mid.y);
      }
      ctx.globalAlpha = 1;
    }

    // a connection being dragged
    const d = drag.current;
    if (d?.kind === "connect") {
      const a = posOf(d.from)!;
      const p0 = portOf(a);
      ctx.strokeStyle = pal.accent;
      ctx.lineWidth = 2;
      ctx.setLineDash([5, 5]);
      ctx.beginPath();
      ctx.moveTo(p0.x, p0.y);
      ctx.bezierCurveTo(p0.x + 80, p0.y, d.at.x - 80, d.at.y, d.at.x, d.at.y);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // nodes
    const names = new Map(view.constraints.filter((o) => o.kind === "character").map((o) => [o.owner, o.name]));
    for (const n of view.nodes) {
      const p = posOf(n.id)!;
      const selected = selection?.kind === "node" && selection.id === n.id;
      const inRoute = routeNodes.has(n.id);
      ctx.globalAlpha = dimming && !inRoute ? 0.35 : 1;
      ctx.shadowColor = "rgba(0,0,0,0.18)";
      ctx.shadowBlur = 10;
      ctx.shadowOffsetY = 2;
      roundRect(ctx, p.x, p.y, NODE_W, NODE_H, 10);
      ctx.fillStyle = pal.node;
      ctx.fill();
      ctx.shadowColor = "transparent";
      ctx.lineWidth = selected ? 2.5 : inRoute ? 2.5 : 1.2;
      ctx.strokeStyle = selected ? pal.accent : inRoute ? pal.route : pal.nodeBorder;
      ctx.stroke();

      ctx.textAlign = "left";
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = pal.text;
      ctx.font = `600 14px ${FONT}`;
      ctx.fillText(ellipsize(ctx, n.title, NODE_W - 28), p.x + 14, p.y + 26);
      ctx.font = `12px ${FONT}`;
      ctx.fillStyle = pal.muted;
      const chars = Object.keys(n.char_states).map((k) => names.get(k) ?? k);
      ctx.fillText(ellipsize(ctx, chars.length ? chars.join(" · ") : "no characters yet", NODE_W - 28), p.x + 14, p.y + 46);
      const facts = n.world_facts.length;
      ctx.fillText(ellipsize(ctx, `${facts} world fact${facts === 1 ? "" : "s"}${n.author_notes ? " · notes" : ""}`, NODE_W - 28), p.x + 14, p.y + 64);
      if (inRoute && highlight.length) {
        // order badge on route nodes
        const k = highlight.indexOf(n.id) + 1;
        ctx.fillStyle = pal.route;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 11, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = pal.labelBg;
        ctx.font = `700 11px ${FONT}`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(String(k), p.x, p.y + 0.5);
      }
      // out-port
      if (mode === "select") {
        const q = portOf(p);
        ctx.beginPath();
        ctx.arc(q.x, q.y, PORT_R, 0, Math.PI * 2);
        ctx.fillStyle = hover.current.port === n.id ? pal.accent : pal.node;
        ctx.fill();
        ctx.strokeStyle = hover.current.port === n.id ? pal.accent : pal.nodeBorder;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
  }, [posOf]);

  const redraw = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(draw);
  }, [draw]);

  useEffect(() => {
    // positions the server now knows about no longer need the local override
    for (const n of props.view.nodes) {
      const l = local.current.get(n.id);
      if (l && Math.round(l.x) === n.pos.x && Math.round(l.y) === n.pos.y) local.current.delete(n.id);
    }
    redraw();
  }, [props.view, props.selection, props.highlight, props.mode, redraw]);

  useEffect(() => {
    const ro = new ResizeObserver(redraw);
    if (canvasRef.current) ro.observe(canvasRef.current);
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    mq.addEventListener("change", redraw);
    return () => {
      ro.disconnect();
      mq.removeEventListener("change", redraw);
    };
  }, [redraw]);

  useImperativeHandle(props.apiRef, () => ({
    fit() {
      const canvas = canvasRef.current;
      const nodes = latest.current.view.nodes;
      if (!canvas || !nodes.length) {
        cam.current = { x: -80, y: -80, zoom: 1 };
        return redraw();
      }
      const xs = nodes.map((n) => posOf(n.id)!);
      const minX = Math.min(...xs.map((p) => p.x)) - 60;
      const minY = Math.min(...xs.map((p) => p.y)) - 60;
      const maxX = Math.max(...xs.map((p) => p.x + NODE_W)) + 60;
      const maxY = Math.max(...xs.map((p) => p.y + NODE_H)) + 60;
      const zoom = Math.min(1.4, Math.max(0.2, Math.min(canvas.clientWidth / (maxX - minX), canvas.clientHeight / (maxY - minY))));
      cam.current = { zoom, x: minX - (canvas.clientWidth / zoom - (maxX - minX)) / 2, y: minY - (canvas.clientHeight / zoom - (maxY - minY)) / 2 };
      saveCamera(latest.current.view.root, cam.current);
      redraw();
    },
    center() {
      const canvas = canvasRef.current!;
      return toWorld(cam.current, { x: canvas.clientWidth / 2 - NODE_W / 2, y: canvas.clientHeight / 2 - NODE_H / 2 });
    },
  }));

  // ---------- input ----------

  const pointer = (e: { clientX: number; clientY: number }): Pt => {
    const r = canvasRef.current!.getBoundingClientRect();
    return toWorld(cam.current, { x: e.clientX - r.left, y: e.clientY - r.top });
  };

  const hit = (p: Pt) => {
    const { view, mode } = latest.current;
    // topmost first: nodes are drawn after edges
    for (let i = view.nodes.length - 1; i >= 0; i--) {
      const n = view.nodes[i]!;
      const pos = posOf(n.id)!;
      if (mode === "select" && nearPort(pos, p, cam.current.zoom)) return { port: n.id };
      if (inNode(pos, p)) return { node: n.id };
    }
    for (const e of view.edges) {
      const a = posOf(e.from);
      const b = posOf(e.to);
      if (a && b && nearCurve(edgeCurve(a, b), p, 7 / cam.current.zoom)) return { edge: e.id };
    }
    return {};
  };

  const onPointerDown = (e: React.PointerEvent) => {
    canvasRef.current!.setPointerCapture(e.pointerId);
    const p = pointer(e);
    const h = e.button === 1 ? {} : hit(p);
    if (h.port) drag.current = { kind: "connect", from: h.port, at: p };
    else if (h.node) {
      if (latest.current.mode === "route") {
        latest.current.onRouteClick(h.node);
        return;
      }
      const pos = posOf(h.node)!;
      drag.current = { kind: "node", id: h.node, offset: { x: p.x - pos.x, y: p.y - pos.y }, moved: false };
      latest.current.onSelect({ kind: "node", id: h.node });
    } else if (h.edge && latest.current.mode === "select") {
      latest.current.onSelect({ kind: "edge", id: h.edge });
    } else {
      drag.current = { kind: "pan", start: { x: e.clientX, y: e.clientY }, cam: { ...cam.current }, moved: false };
    }
    redraw();
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    const p = pointer(e);
    if (!d) {
      const h = hit(p);
      const before = hover.current;
      hover.current = h;
      canvasRef.current!.style.cursor = h.port ? "crosshair" : h.node ? (latest.current.mode === "route" ? "pointer" : "grab") : h.edge ? "pointer" : "default";
      if (before.node !== h.node || before.edge !== h.edge || before.port !== h.port) redraw();
      return;
    }
    if (d.kind === "pan") {
      const dx = e.clientX - d.start.x;
      const dy = e.clientY - d.start.y;
      if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
      cam.current = { ...d.cam, x: d.cam.x - dx / d.cam.zoom, y: d.cam.y - dy / d.cam.zoom };
      canvasRef.current!.style.cursor = "grabbing";
    } else if (d.kind === "node") {
      d.moved = true;
      local.current.set(d.id, { x: p.x - d.offset.x, y: p.y - d.offset.y });
      canvasRef.current!.style.cursor = "grabbing";
    } else {
      d.at = p;
    }
    redraw();
  };

  const onPointerUp = (e: React.PointerEvent) => {
    const d = drag.current;
    drag.current = null;
    if (!d) return;
    if (d.kind === "pan") {
      saveCamera(latest.current.view.root, cam.current);
      if (!d.moved && latest.current.mode === "select") latest.current.onSelect(null);
    } else if (d.kind === "node" && d.moved) {
      const pos = local.current.get(d.id)!;
      latest.current.onMove({ [d.id]: { x: Math.round(pos.x), y: Math.round(pos.y) } });
    } else if (d.kind === "connect") {
      const h = hit(pointer(e));
      const target = h.node ?? h.port;
      if (target && target !== d.from) latest.current.onConnect(d.from, target);
    }
    redraw();
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (latest.current.mode !== "select") return;
    const p = pointer(e);
    const h = hit(p);
    if (!h.node && !h.edge && !h.port) latest.current.onCreateNode({ x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 });
  };

  useEffect(() => {
    const canvas = canvasRef.current!;
    // non-passive so the page itself never scrolls or zooms
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const screen = { x: e.clientX - r.left, y: e.clientY - r.top };
      const c = cam.current;
      if (e.ctrlKey || Math.abs(e.deltaY) >= 40 || e.deltaMode !== 0) {
        // mouse wheel or pinch: zoom around the cursor
        const before = toWorld(c, screen);
        const zoom = Math.min(2.5, Math.max(0.15, c.zoom * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))));
        cam.current = { zoom, x: before.x - screen.x / zoom, y: before.y - screen.y / zoom };
      } else {
        // trackpad two-finger scroll: pan
        cam.current = { ...c, x: c.x + e.deltaX / c.zoom, y: c.y + e.deltaY / c.zoom };
      }
      saveCamera(latest.current.view.root, cam.current);
      redraw();
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [redraw]);

  return (
    <canvas
      ref={canvasRef}
      className="board"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={() => {
        if (!drag.current && (hover.current.node || hover.current.edge || hover.current.port)) {
          hover.current = {};
          redraw();
        }
      }}
      onDoubleClick={onDoubleClick}
    />
  );
}

function strokeCurve(ctx: CanvasRenderingContext2D, [p0, p1, p2, p3]: [Pt, Pt, Pt, Pt]) {
  ctx.beginPath();
  ctx.moveTo(p0.x, p0.y);
  ctx.bezierCurveTo(p1.x, p1.y, p2.x, p2.y, p3.x, p3.y);
  ctx.stroke();
}

function arrow(ctx: CanvasRenderingContext2D, curve: [Pt, Pt, Pt, Pt], color: string) {
  const tip = curve[3];
  const back = bezier(curve, 0.96);
  const ang = Math.atan2(tip.y - back.y, tip.x - back.x);
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(tip.x, tip.y);
  ctx.lineTo(tip.x - 11 * Math.cos(ang - 0.42), tip.y - 11 * Math.sin(ang - 0.42));
  ctx.lineTo(tip.x - 11 * Math.cos(ang + 0.42), tip.y - 11 * Math.sin(ang + 0.42));
  ctx.closePath();
  ctx.fill();
}

const camKey = (root: string) => `sw.camera.${root}`;
function loadCamera(root: string): Camera {
  try {
    const c = JSON.parse(localStorage.getItem(camKey(root)) ?? "null") as Camera | null;
    if (c && Number.isFinite(c.x) && Number.isFinite(c.y) && c.zoom > 0) return c;
  } catch {
    /* no saved camera */
  }
  return { x: -80, y: -80, zoom: 1 };
}
function saveCamera(root: string, c: Camera) {
  try {
    localStorage.setItem(camKey(root), JSON.stringify(c));
  } catch {
    /* storage unavailable: the camera just isn't remembered */
  }
}

// The canvas (spec §7): x = story time, rows = lanes. Snapshots span the lanes they involve, bridges
// connect adjacent snapshots, gaps are tinted by axis F, threads run under their lanes.
import { useMemo, useState } from "react";
import { type Selection, type Snapshot, type View, level } from "./types";

const UNIT = 260; // px per unit of t
const PAD = 90;
const NODE_W = 132;
const HEAD = 34; // time axis
const BRIDGE_ROW = 44;
const ROW = 70;
const CAND_ROW = 64;

const LEVEL_COLOR = { high: "#d9480f", warn: "#e8a10c", ok: "#2f9e44" } as const;
const STATUS_ICON: Record<string, string> = { seed: "○", sketch: "◌", approved: "●", locked: "🔒" };

interface Props {
  view: View;
  selection: Selection;
  onSelect: (s: Selection) => void;
  onAddPoint: (from: string, to: string) => void;
  onNewBridge: (from: string, to: string) => void;
  onReorder: (order: string[]) => void;
  showPruned: boolean;
}

export function Canvas({ view, selection, onSelect, onAddPoint, onNewBridge, onReorder, showPruned }: Props) {
  const lanes = view.lanes;
  const [drag, setDrag] = useState<string | null>(null);
  const candidates = view.branches.filter((b) => showPruned || !b.pruned);

  const { x, width, tmin } = useMemo(() => {
    const ts = [...view.snapshots, ...candidates].map((s) => s.t);
    const tmin = ts.length ? Math.min(...ts) : 0;
    const tmax = ts.length ? Math.max(...ts) : 1;
    const x = (t: number) => PAD + (t - tmin) * UNIT;
    // no end snapshot: the right side stays open (spec §7)
    return { x, width: x(tmax) + PAD + UNIT * 0.8, tmin };
  }, [view, candidates]);

  const rowOf = new Map(lanes.map((l, i) => [l.id, i]));
  const laneTop = (i: number) => HEAD + BRIDGE_ROW + i * ROW;
  const lanesBottom = laneTop(lanes.length);
  const height = lanesBottom + (candidates.length ? CAND_ROW * Math.max(1, maxStack(candidates)) + 20 : 20);
  const snapById = new Map(view.snapshots.map((s) => [s.id, s]));

  const span = (s: Snapshot) => {
    const rows = (s.lanes.length ? s.lanes : lanes.map((l) => l.id)).map((l) => rowOf.get(l)).filter((r): r is number => r !== undefined);
    const lo = rows.length ? Math.min(...rows) : 0;
    const hi = rows.length ? Math.max(...rows) : lanes.length - 1;
    return { y: laneTop(lo) + 8, h: laneTop(hi + 1) - laneTop(lo) - 16 };
  };
  const pointT = (ref: string) => {
    const id = ref.split("#")[0]!;
    const s = snapById.get(id);
    if (s) return s.t;
    const b = view.bridges.find((y) => y.id === id);
    const f = b && snapById.get(b.from);
    const t = b && snapById.get(b.to);
    return f && t ? (f.t + t.t) / 2 : tmin;
  };
  const affected = new Set(view.threads.flatMap((t) => t.affected));
  const isSel = (kind: string, id: string) => !!selection && selection.kind === kind && "id" in selection && selection.id === id;

  return (
    <div className="canvas-wrap">
      <div className="lane-labels" style={{ paddingTop: HEAD + BRIDGE_ROW }}>
        {lanes.map((l) => (
          <div
            key={l.id}
            className={`lane-label ${l.kind} ${drag === l.id ? "dragging" : ""}`}
            style={{ height: ROW }}
            draggable
            onDragStart={() => setDrag(l.id)}
            onDragEnd={() => setDrag(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (!drag || drag === l.id) return;
              const order = lanes.map((x) => x.id).filter((id) => id !== drag);
              order.splice(order.indexOf(l.id), 0, drag);
              onReorder(order);
            }}
            onClick={() => l.kind === "character" && onSelect({ kind: "profile", id: l.profile ?? l.id })}
            title="拖动调整顺序；点人物看档案"
          >
            <span className="grip">⋮⋮</span>
            {l.name ?? l.id}
          </div>
        ))}
        {candidates.length > 0 && <div className="lane-label cand" style={{ height: CAND_ROW }}>候选</div>}
      </div>

      <div className="plot">
        <svg width={width} height={height}>
          {/* lane rows */}
          {lanes.map((l, i) => (
            <rect key={l.id} x={0} y={laneTop(i)} width={width} height={ROW} className={i % 2 ? "row odd" : "row"} />
          ))}

          {/* gaps between adjacent approved snapshots (axis F) */}
          {view.gaps.map((g) => {
            const a = snapById.get(g.from)!;
            const b = snapById.get(g.to)!;
            const x1 = x(a.t) + NODE_W / 2;
            const x2 = x(b.t) - NODE_W / 2;
            const sel = selection?.kind === "gap" && selection.from === g.from && selection.to === g.to;
            return (
              <g key={`gap-${g.from}`} className="gap" onClick={() => onSelect({ kind: "gap", from: g.from, to: g.to })}>
                <rect
                  x={x1}
                  y={HEAD + BRIDGE_ROW}
                  width={Math.max(0, x2 - x1)}
                  height={lanesBottom - HEAD - BRIDGE_ROW}
                  fill={LEVEL_COLOR[level(view, "F", g.score)]}
                  opacity={0.04 + (g.score / 100) * 0.22}
                  stroke={sel ? "#1c7ed6" : "none"}
                />
                <text x={(x1 + x2) / 2} y={lanesBottom - 8} textAnchor="middle" className="gap-label">
                  间距 {g.score}
                </text>
                {g.suggest && (
                  <g
                    className="btn-svg"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddPoint(g.from, g.to);
                    }}
                  >
                    <rect x={(x1 + x2) / 2 - 30} y={lanesBottom - 44} width={60} height={22} rx={11} />
                    <text x={(x1 + x2) / 2} y={lanesBottom - 29} textAnchor="middle">
                      ＋加点
                    </text>
                  </g>
                )}
              </g>
            );
          })}

          {/* time axis */}
          {[...new Set([...view.snapshots, ...candidates].map((s) => s.t))].map((t) => (
            <g key={`t-${t}`}>
              <line x1={x(t)} x2={x(t)} y1={HEAD - 6} y2={lanesBottom} className="tick" />
              <text x={x(t)} y={HEAD - 12} textAnchor="middle" className="tick-label">
                t={t}
              </text>
            </g>
          ))}
          <text x={width - 20} y={HEAD - 12} textAnchor="end" className="tick-label open-end">
            → 开放
          </text>

          {/* bridges */}
          {view.bridges.map((b) => {
            const a = snapById.get(b.from);
            const c = snapById.get(b.to);
            if (!a || !c) return null;
            const x1 = x(a.t) + 10;
            const x2 = x(c.t) - 10;
            const y = HEAD + BRIDGE_ROW / 2;
            const score = Math.max(b.score, b.threadScore);
            const hasChecks = view.checks.some((k) => k.target === b.id) || b.threadScore > 0;
            const color = b.status === "empty" || !hasChecks ? "#adb5bd" : LEVEL_COLOR[level(view, b.score >= b.threadScore ? "A" : "E", score)];
            const unconfirmed = b.outline_origin === "llm" || b.text_origin === "llm";
            const label = `${b.id} · ${b.status}${hasChecks ? ` · ${score}` : ""}${unconfirmed ? " · 模型" : ""}`;
            const tagW = Math.min(170, Math.max(40, x2 - x1 - 16));
            return (
              <g key={b.id} className={`bridge ${isSel("bridge", b.id) ? "selected" : ""} ${affected.has(b.id) ? "affected" : ""}`} onClick={() => onSelect({ kind: "bridge", id: b.id })}>
                <line x1={x1} x2={x2} y1={y} y2={y} stroke={color} strokeWidth={isSel("bridge", b.id) ? 7 : 5} strokeLinecap="round" />
                <rect x={(x1 + x2) / 2 - tagW / 2} y={y - 11} width={tagW} height={22} rx={6} className="bridge-tag" />
                <text x={(x1 + x2) / 2} y={y + 4} textAnchor="middle" className="bridge-label">
                  {clip(label, Math.floor(tagW / 7))}
                </text>
                <title>{label}</title>
              </g>
            );
          })}
          {view.missingBridges.map((m) => {
            const a = snapById.get(m.from)!;
            const c = snapById.get(m.to)!;
            const y = HEAD + BRIDGE_ROW / 2;
            return (
              <g key={`mb-${m.from}`} className="bridge missing" onClick={() => onNewBridge(m.from, m.to)}>
                <line x1={x(a.t) + 10} x2={x(c.t) - 10} y1={y} y2={y} strokeDasharray="6 6" />
                <text x={(x(a.t) + x(c.t)) / 2} y={y + 4} textAnchor="middle">
                  ＋ 搭桥
                </text>
              </g>
            );
          })}

          {/* snapshots */}
          {view.snapshots.map((s) => {
            const { y, h } = span(s);
            const lv = level(view, "E", s.score ?? 0);
            return (
              <g key={s.id} className={`snap ${s.status} ${isSel("snapshot", s.id) ? "selected" : ""} ${s.origin === "llm-candidate" ? "unconfirmed" : ""}`} onClick={() => onSelect({ kind: "snapshot", id: s.id })}>
                {affected.has(s.id) && <rect x={x(s.t) - NODE_W / 2 - 5} y={y - 5} width={NODE_W + 10} height={h + 10} rx={12} className="affected-ring" />}
                <rect x={x(s.t) - NODE_W / 2} y={y} width={NODE_W} height={h} rx={9} className="snap-box" style={{ fill: s.score ? tint(LEVEL_COLOR[lv]) : undefined }} />
                <text x={x(s.t)} y={y + 20} textAnchor="middle" className="snap-title">
                  {STATUS_ICON[s.status]} {clip(s.title, 9)}
                </text>
                <text x={x(s.t)} y={y + 37} textAnchor="middle" className="snap-sub">
                  {clip(s.id, 18)}
                </text>
                <title>{`${s.id}「${s.title}」`}</title>
                {Object.entries(s.char_states).map(([lane, st]) => {
                  const r = rowOf.get(lane);
                  const brief = [st.location, st.feels].filter(Boolean).join(" · ");
                  if (r === undefined || !brief || laneTop(r) + ROW / 2 < y + 44) return null;
                  return (
                    <text key={lane} x={x(s.t)} y={laneTop(r) + ROW / 2 + 4} textAnchor="middle" className="snap-lane">
                      {clip(brief, 10)}
                    </text>
                  );
                })}
                {s.origin === "llm-candidate" && (
                  <text x={x(s.t)} y={y + h - 8} textAnchor="middle" className="llm-tag">
                    模型生成·未确认
                  </text>
                )}
              </g>
            );
          })}

          {/* threads, under the lanes of who knows (or the world lane) */}
          {view.threads.map((th, i) => {
            const lane = (th.visibility === "character" ? th.known_by : []).map((k) => lanes.find((l) => (l.profile ?? l.id) === k)?.id).find(Boolean) ?? lanes.find((l) => l.kind === "world")?.id ?? lanes[0]?.id;
            const row = rowOf.get(lane ?? "") ?? 0;
            const y = laneTop(row + 1) - 6 - (i % 4) * 5;
            const x1 = x(pointT(th.planted_at));
            const x2 = th.payoff_at ? x(pointT(th.payoff_at)) : width - 10;
            const color = th.checked ? LEVEL_COLOR[level(view, "E", th.score)] : "#868e96";
            return (
              <g key={th.id} className={`thread ${isSel("thread", th.id) ? "selected" : ""}`} onClick={() => onSelect({ kind: "thread", id: th.id })}>
                <line x1={x1} x2={x2} y1={y} y2={y} stroke={color} strokeWidth={isSel("thread", th.id) ? 4 : 2} strokeDasharray={th.payoff_at ? undefined : "2 4"} />
                <circle cx={x1} cy={y} r={4} fill={color} />
                {th.payoff_at && <circle cx={x2} cy={y} r={4} fill="white" stroke={color} strokeWidth={2} />}
                <text x={x1 + NODE_W / 2 + 6} y={y - 4} className="thread-label">
                  {th.id}
                  {th.unpaid ? "（未收）" : ""}
                </text>
              </g>
            );
          })}

          {/* candidates under the lanes */}
          {stack(candidates).map(({ s, level: k }) => {
            const y = lanesBottom + 10 + k * CAND_ROW;
            return (
              <g key={s.id} className={`snap cand ${s.pruned ? "pruned" : ""} ${isSel("snapshot", s.id) ? "selected" : ""}`} onClick={() => onSelect({ kind: "snapshot", id: s.id })}>
                <rect x={x(s.t) - NODE_W / 2} y={y} width={NODE_W} height={CAND_ROW - 12} rx={9} className="snap-box" />
                <text x={x(s.t)} y={y + 20} textAnchor="middle" className="snap-title">
                  ◌ {clip(s.title, 9)}
                </text>
                <text x={x(s.t)} y={y + 38} textAnchor="middle" className="snap-sub">
                  {s.pruned ? "落选" : "候选·未确认"}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const tint = (hex: string) => `${hex}22`;

function stack(xs: Snapshot[]) {
  const byT = new Map<number, number>();
  return [...xs].sort((a, b) => a.id.localeCompare(b.id)).map((s) => {
    const k = byT.get(s.t) ?? 0;
    byT.set(s.t, k + 1);
    return { s, level: k };
  });
}
function maxStack(xs: Snapshot[]) {
  const byT = new Map<number, number>();
  for (const s of xs) byT.set(s.t, (byT.get(s.t) ?? 0) + 1);
  return Math.max(0, ...byT.values());
}

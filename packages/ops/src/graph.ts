// Graph-mode operations (D-057–D-063): free nodes and edges, layout and routes in canvas.yaml,
// edge checks (axis T always, A/B/C/D when the edge has prose), route scores and the route outline.
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import {
  type Bridge,
  CharState,
  DIRS,
  PROJECT_FILE,
  type Project,
  type Snapshot,
  analyzeGraph,
  assertInsideProject,
  freeFileName,
  loadProject,
  readText,
  renderMarkdownFile,
  renderYamlFile,
  routeEdges,
  stateFor,
  toPosix,
  updateObjectFile,
  updateYamlFile,
  worldRules,
  writeProjectFile,
} from "@sw/core";
import { type CheckResult, checkAxisT, unknownScope } from "@sw/checks";
import type { LlmContext } from "@sw/llm";
import { z } from "zod";
import { checkBridge } from "./bridge";
import { castOf, findSnapshot, renderSnapshot } from "./brief";
import { bridgeCheckKeys, findStale, hashAll } from "./deps";
import { saveBridge } from "./edit";
import { findBridge, saveCheck } from "./store";

export const CANVAS_FILE = "canvas.yaml";
export const EXPORTS_DIR = "exports";

// ---------- layout & routes (D-063) ----------

export interface Route {
  id: string;
  name: string;
  nodes: string[];
}
export interface CanvasLayout {
  nodes: Record<string, { x: number; y: number }>;
  routes: Route[];
}

const Layout = z.object({
  nodes: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).default({}),
  routes: z.array(z.object({ id: z.string(), name: z.string(), nodes: z.array(z.string()) })).default([]),
});

export function loadCanvas(p: Project): CanvasLayout {
  const f = path.join(p.root, CANVAS_FILE);
  if (!fs.existsSync(f)) return { nodes: {}, routes: [] };
  const parsed = Layout.safeParse(parse(readText(f)) ?? {});
  if (!parsed.success) throw new Error(`canvas.yaml 写错了：${parsed.error.issues[0]?.message}`);
  return parsed.data;
}

export function saveCanvas(p: Project, c: CanvasLayout): void {
  writeProjectFile(p.root, CANVAS_FILE, renderYamlFile(c), { overwrite: true });
}

export function moveNodes(p: Project, positions: Record<string, { x: number; y: number }>): void {
  const c = loadCanvas(p);
  for (const [id, xy] of Object.entries(positions)) c.nodes[id] = { x: Math.round(xy.x), y: Math.round(xy.y) };
  saveCanvas(p, c);
}

// ---------- project.yaml helpers ----------

function rawProject(p: Project): Record<string, unknown> {
  return (parse(readText(path.join(p.root, PROJECT_FILE))) ?? {}) as Record<string, unknown>;
}

/** Make sure a lane exists for the world and for each character a node uses (validation needs them). */
export function ensureLanes(p: Project, profileIds: string[]): void {
  const raw = rawProject(p);
  const lanes = (Array.isArray(raw.lanes) ? raw.lanes : []) as { id: string; kind: string; profile?: string; name?: string }[];
  let changed = false;
  if (!lanes.some((l) => l.kind === "world")) {
    lanes.unshift({ id: "world", kind: "world", name: "World" });
    changed = true;
  }
  for (const id of profileIds) {
    if (lanes.some((l) => l.kind === "character" && (l.profile ?? l.id) === id)) continue;
    const pr = p.profiles.find((x) => x.value.id === id)?.value;
    lanes.push({ id, kind: "character", ...(pr ? { name: pr.name } : {}) });
    changed = true;
  }
  if (changed) updateYamlFile(p.root, PROJECT_FILE, { lanes });
}

export function enableGraphMode(p: Project): void {
  if (p.config.mode !== "graph") updateYamlFile(p.root, PROJECT_FILE, { mode: "graph" });
  ensureLanes(p, []);
}

// ---------- nodes ----------

const worldLane = (p: Project) => p.config.lanes.find((l) => l.kind === "world")?.id ?? "world";

function nextId(prefix: string, taken: Set<string>): string {
  for (let n = 1; ; n++) if (!taken.has(`${prefix}${n}`)) return `${prefix}${n}`;
}

export function createNode(p: Project, input: { id?: string; title: string; x: number; y: number }): { id: string; file: string } {
  const taken = new Set([...p.snapshots, ...p.branchSnapshots].map((s) => s.value.id));
  const id = input.id?.trim() || nextId("n", taken);
  if (taken.has(id)) throw new Error(`节点 id 已存在：${id}`);
  if (!input.title.trim()) throw new Error("节点需要标题");
  ensureLanes(p, []);
  const file = freeFileName(p.root, DIRS.snapshots, id);
  // nodes made on the canvas are the author's own (D-065: no model generation in graph mode)
  writeProjectFile(p.root, file, renderMarkdownFile({ id, title: input.title.trim(), lanes: [worldLane(p)], status: "approved", origin: "author" }, ""));
  moveNodes(p, { [id]: { x: input.x, y: input.y } });
  return { id, file };
}

export interface NodePatch {
  title?: string;
  world_facts?: string[];
  char_states?: Record<string, unknown>;
  notes?: string;
}

export function updateNode(p: Project, id: string, patch: NodePatch): string {
  const s = p.snapshots.find((x) => x.value.id === id);
  if (!s) throw new Error(`找不到节点：${id}`);
  const out: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    if (!patch.title.trim()) throw new Error("节点需要标题");
    out.title = patch.title.trim();
  }
  if (patch.world_facts) out.world_facts = patch.world_facts.map((f) => f.trim()).filter(Boolean);
  if (patch.char_states) {
    const states: Record<string, unknown> = {};
    for (const [ch, st] of Object.entries(patch.char_states)) {
      if (!p.profiles.some((x) => x.value.id === ch)) throw new Error(`没有这个人物档案：${ch}（先在约束栏里建档案）`);
      const parsed = CharState.safeParse(st);
      if (!parsed.success) throw new Error(`${ch} 的状态字段不对：${parsed.error.issues[0]?.message}`);
      // keep the file tidy: drop empty lists and blanks
      const clean = Object.fromEntries(
        Object.entries(parsed.data).filter(([, v]) => (Array.isArray(v) ? v.length : typeof v === "object" ? Object.keys(v ?? {}).length : !!v)),
      );
      states[ch] = clean;
    }
    ensureLanes(p, Object.keys(states));
    out.char_states = Object.keys(states).length ? states : undefined;
    out.lanes = [worldLane(p), ...Object.keys(states)];
  }
  updateObjectFile(p.root, s.file, out, patch.notes);
  return s.file;
}

function removeFile(p: Project, rel: string) {
  const abs = assertInsideProject(p.root, rel);
  if (fs.existsSync(abs)) fs.rmSync(abs, { recursive: true, force: true });
}

export function deleteNode(p: Project, id: string): void {
  const s = p.snapshots.find((x) => x.value.id === id);
  if (!s) throw new Error(`找不到节点：${id}`);
  for (const b of p.bridges.filter((x) => x.value.from === id || x.value.to === id)) deleteEdge(loadProject(p.root), b.value.id);
  removeFile(p, s.file);
  removeFile(p, toPosix(path.join(DIRS.checks, id)));
  const c = loadCanvas(p);
  delete c.nodes[id];
  c.routes = c.routes.filter((r) => !r.nodes.includes(id));
  saveCanvas(p, c);
}

// ---------- edges ----------

export function createEdge(p: Project, from: string, to: string, summary?: string): { id: string; file: string } {
  if (from === to) throw new Error("边不能连回自己");
  for (const n of [from, to]) if (!p.snapshots.some((s) => s.value.id === n)) throw new Error(`找不到节点：${n}`);
  if (p.bridges.some((b) => b.value.from === from && b.value.to === to)) throw new Error(`${from} → ${to} 已经有一条边`);
  // routes need an order: refuse an edge that closes a loop (D-058)
  const edges = [...p.bridges.map((b) => b.value), { id: "_new", from, to }];
  if (analyzeGraph(p.snapshots.map((s) => s.value.id), edges).cyclic.length) throw new Error(`连 ${from} → ${to} 会形成环：故事时间只能往前走`);
  const taken = new Set(p.bridges.map((b) => b.value.id));
  let id = `e-${from}-${to}`.replace(/[^\w\-一-鿿]+/g, "-");
  for (let n = 2; taken.has(id); n++) id = `e-${from}-${to}-${n}`;
  const file = freeFileName(p.root, DIRS.bridges, id);
  const data: Record<string, unknown> = { id, from, to, status: "empty" };
  if (summary?.trim()) data.summary = summary.trim();
  writeProjectFile(p.root, file, renderMarkdownFile(data, ""));
  return { id, file };
}

export function updateEdge(p: Project, id: string, patch: { summary?: string; outline?: string[]; text?: string }): void {
  const b = findBridge(p, id);
  if (patch.summary !== undefined) updateObjectFile(p.root, b.file, { summary: patch.summary.trim() || undefined });
  if (patch.outline !== undefined || patch.text !== undefined) {
    saveBridge(loadProject(p.root), id, { outline: patch.outline, text: patch.text });
  }
}

export function deleteEdge(p: Project, id: string): void {
  const b = findBridge(p, id);
  removeFile(p, b.file);
  removeFile(p, toPosix(path.join(DIRS.checks, id)));
  removeFile(p, toPosix(path.join(DIRS.bridges, ".versions", id)));
  // acceptances made on this edge go with it (D-059)
  for (const a of p.acceptances.filter((x) => x.value.on === id)) removeFile(p, a.file);
}

// ---------- checks ----------

export interface EdgeCheckResult {
  results: CheckResult[];
  saved: { id: string; file: string }[];
}

/** Axis T always; A/B/C/D too when the edge has prose (D-061). */
export async function checkEdge(p: Project, ctx: LlmContext, id: string, opts: { n?: number; onProgress?: (m: string) => void } = {}): Promise<EdgeCheckResult> {
  const say = opts.onProgress ?? (() => {});
  const n = opts.n ?? p.config.sampling;
  const b = findBridge(p, id);
  const from = findSnapshot(p, b.value.from);
  const to = findSnapshot(p, b.value.to);
  const cast = castOf(p, from, to);
  const ids = cast.map((c) => c.profile.id);
  say(`轴 T · ${from.title} → ${to.title}（${n} 次采样）`);
  const t = await checkAxisT(ctx, {
    from,
    to,
    fromText: renderSnapshot(from),
    toText: renderSnapshot(to),
    summary: b.value.summary ?? "",
    profiles: cast.map((c) => c.profile),
    states: ids.map((c) => stateFor(p, c, from)),
    world: worldRules(p.config.world_rules),
    scope: unknownScope(p, ids),
    n,
  });
  const saved = [saveCheck(p, id, t, hashAll(p, bridgeCheckKeys(p, b.value, ids, "T")))];
  const results = [t];
  if (b.value.text.trim()) {
    const r = await checkBridge(loadProject(p.root), ctx, id, { n, onProgress: say });
    results.push(...r.run.results);
    saved.push(...r.saved);
  }
  const fresh = findBridge(loadProject(p.root), id);
  updateObjectFile(p.root, fresh.file, { checks: [...new Set([...fresh.value.checks, ...saved.map((s) => s.id)])] });
  return { results, saved };
}

const OPEN = new Set(["open", "stale"]);

export interface EdgeInfo {
  id: string;
  from: string;
  to: string;
  /** worst open/stale check score on the edge; 0 when nothing is open */
  score: number;
  axes: Partial<Record<string, number>>;
  checked: boolean;
  stale: boolean;
  hasText: boolean;
}

export function edgeInfo(p: Project, b: Bridge, staleIds = new Set(findStale(p).map((s) => s.check.value.id))): EdgeInfo {
  const mine = p.checks.map((c) => c.value).filter((c) => c.target === b.id && c.target_kind === "bridge");
  const open = mine.filter((c) => OPEN.has(c.status));
  const axes: Partial<Record<string, number>> = {};
  for (const c of open) axes[c.axis] = Math.max(axes[c.axis] ?? 0, c.score);
  const hasText = !!b.text.trim();
  return {
    id: b.id,
    from: b.from,
    to: b.to,
    score: Math.max(0, ...open.map((c) => c.score)),
    axes,
    // T is the minimum; prose edges also need their text checks
    checked: mine.some((c) => c.axis === "T") && (!hasText || mine.some((c) => c.axis === "A" || c.axis === "D")),
    stale: mine.some((c) => staleIds.has(c.id) || c.status === "stale"),
    hasText,
  };
}

export interface RouteInfo extends Route {
  edges: EdgeInfo[];
  /** worst edge (D-061); undefined until every edge has been checked */
  score: number;
  weakest?: string;
  complete: boolean;
  broken?: string;
}

export function routeInfo(p: Project, r: Route): RouteInfo {
  let edges: Bridge[];
  try {
    edges = routeEdges(r.nodes, p.bridges.map((b) => b.value));
  } catch (e) {
    return { ...r, edges: [], score: 0, complete: false, broken: (e as Error).message };
  }
  const staleIds = new Set(findStale(p).map((s) => s.check.value.id));
  const infos = edges.map((b) => edgeInfo(p, b, staleIds));
  const weakest = infos.reduce<EdgeInfo | undefined>((w, e) => (!w || e.score > w.score ? e : w), undefined);
  return { ...r, edges: infos, score: weakest?.score ?? 0, weakest: weakest && weakest.score > 0 ? weakest.id : undefined, complete: infos.every((e) => e.checked && !e.stale) };
}

export function saveRoute(p: Project, input: { id?: string; name: string; nodes: string[] }): Route {
  if (input.nodes.length < 2) throw new Error("路线至少要两个节点");
  routeEdges(input.nodes, p.bridges.map((b) => b.value));
  const c = loadCanvas(p);
  const id = input.id ?? nextId("r", new Set(c.routes.map((r) => r.id)));
  const route = { id, name: input.name.trim() || id, nodes: input.nodes };
  c.routes = [...c.routes.filter((r) => r.id !== id), route];
  saveCanvas(p, c);
  return route;
}

export function deleteRoute(p: Project, id: string): void {
  const c = loadCanvas(p);
  c.routes = c.routes.filter((r) => r.id !== id);
  saveCanvas(p, c);
}

export function findRoute(p: Project, id: string): Route {
  const r = loadCanvas(p).routes.find((x) => x.id === id);
  if (!r) throw new Error(`找不到路线：${id}`);
  return r;
}

/** Check every edge on the route that is unchecked or stale (or all, with force). */
export async function checkRoute(p: Project, ctx: LlmContext, route: Route, opts: { force?: boolean; n?: number; onProgress?: (m: string) => void } = {}): Promise<RouteInfo> {
  const before = routeInfo(p, route);
  if (before.broken) throw new Error(before.broken);
  for (const e of before.edges) {
    if (!opts.force && e.checked && !e.stale) continue;
    opts.onProgress?.(`检查边 ${e.id}`);
    await checkEdge(loadProject(p.root), ctx, e.id, { n: opts.n, onProgress: opts.onProgress });
  }
  return routeInfo(loadProject(p.root), route);
}

// ---------- route outline (D-062) ----------

function stateLines(s: Snapshot, names: Map<string, string>): string[] {
  const out: string[] = [];
  if (s.world_facts.length) out.push(`- 世界：${s.world_facts.join("；")}`);
  for (const [c, st] of Object.entries(s.char_states)) {
    const parts = [
      st.knows.length ? `知道 ${st.knows.join("；")}` : "",
      st.wants.length ? `想要 ${st.wants.join("；")}` : "",
      st.feels ? `情绪 ${st.feels}` : "",
      st.location ? `在 ${st.location}` : "",
      Object.keys(st.relationships).length ? `关系 ${Object.entries(st.relationships).map(([k, v]) => `${names.get(k) ?? k}：${v}`).join("；")}` : "",
    ].filter(Boolean);
    out.push(`- ${names.get(c) ?? c}：${parts.join(" · ") || "（未写）"}`);
  }
  return out;
}

export function routeOutline(p: Project, route: Route): { text: string; file: string; info: RouteInfo } {
  const info = routeInfo(p, route);
  if (info.broken) throw new Error(info.broken);
  const names = new Map(p.profiles.map((x) => [x.value.id, x.value.name]));
  const snap = (id: string) => findSnapshot(p, id);
  const edgeById = new Map(p.bridges.map((b) => [b.value.id, b.value]));
  const lines = [
    `# ${route.name} · 大纲`,
    "",
    `- 路线偏差：${info.score}${info.weakest ? `（最弱一环：${info.weakest}）` : ""}${info.complete ? "" : " · 有边未检查或已过期，分数不完整"}`,
    `- 节点：${route.nodes.map((n) => snap(n).title).join(" → ")}`,
    "",
  ];
  route.nodes.forEach((n, i) => {
    const s = snap(n);
    lines.push(`## ${i + 1}. ${s.title}`, "", ...stateLines(s, names));
    if (s.author_notes) lines.push("", `> ${s.author_notes.replace(/\n/g, "\n> ")}`);
    lines.push("");
    const e = info.edges[i];
    if (!e) return;
    const b = edgeById.get(e.id)!;
    const axes = Object.entries(e.axes).map(([a, v]) => `${a} ${v}`).join(" · ");
    lines.push(`### → ${snap(b.to).title}　偏差 ${e.score}${axes ? `（${axes}）` : ""}${e.checked ? "" : " · 未检查"}${e.stale ? " · 已过期" : ""}`, "");
    lines.push(b.summary ? `情节：${b.summary}` : "情节：（未写概述）");
    if (b.outline.length) lines.push("", ...b.outline.map((x, k) => `${k + 1}. ${x}`));
    lines.push("", b.text.trim() ? `正文：已写（${b.text.trim().length} 字）` : "正文：未写", "");
  });
  const text = lines.join("\n").trimEnd() + "\n";
  const file = toPosix(path.join(EXPORTS_DIR, `${route.id}.outline.md`));
  writeProjectFile(p.root, file, text, { overwrite: true });
  return { text, file, info };
}

// ---------- rerun (graph) ----------

/** Rerun every stale check: edges through checkEdge, the constraint check through its own runner. */
export async function rerunGraph(
  p: Project,
  ctx: LlmContext,
  runConstraints: (p: Project) => Promise<unknown>,
  onProgress?: (m: string) => void,
): Promise<{ edges: string[]; constraints: boolean }> {
  const stale = findStale(p).map((s) => s.check.value);
  const edges = [...new Set(stale.filter((c) => c.target_kind === "bridge" && p.bridges.some((b) => b.value.id === c.target)).map((c) => c.target))];
  const constraints = stale.some((c) => c.axis === "K");
  if (constraints) await runConstraints(loadProject(p.root));
  for (const id of edges) {
    onProgress?.(`重跑边 ${id}`);
    await checkEdge(loadProject(p.root), ctx, id, { onProgress });
  }
  return { edges, constraints };
}

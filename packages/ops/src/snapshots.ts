// Snapshot operations: approve / graft candidates (U3), adopt a derived snapshot as the new target
// (U6 改快照, spec §5-D), and draft a start snapshot from hard facts (U2).
import path from "node:path";
import {
  CharState,
  DIRS,
  type Located,
  type Project,
  type Snapshot,
  freeFileName,
  moveProjectFile,
  renderMarkdownFile,
  saveVersion,
  toPosix,
  updateObjectFile,
  writeProjectFile,
} from "@sw/core";
import { type LlmContext, callStructured } from "@sw/llm";
import { z } from "zod";
import { type Cast, castOf, characterBriefs, genPrinciples, hash, opsTemplate } from "./brief";
import { findBridge } from "./store";

function locate(p: Project, id: string): { snap: Located<Snapshot>; inBranches: boolean } {
  const main = p.snapshots.find((s) => s.value.id === id);
  if (main) return { snap: main, inBranches: false };
  const br = p.branchSnapshots.find((s) => s.value.id === id);
  if (br) return { snap: br, inBranches: true };
  throw new Error(`找不到快照：${id}`);
}

/** Bridges whose span now contains a point at time t: they are no longer between adjacent snapshots. */
function spanningBridges(p: Project, t: number): string[] {
  const at = new Map(p.snapshots.map((s) => [s.value.id, s.value.t]));
  return p.bridges
    .filter((b) => (at.get(b.value.from) ?? Infinity) < t && t < (at.get(b.value.to) ?? -Infinity))
    .map((b) => b.value.id);
}

export interface ApproveResult {
  file: string;
  pruned: string[];
  warnings: string[];
}

/** Move a snapshot from branches/ onto the timeline (status `status`); siblings of a candidate are pruned. */
function promote(p: Project, id: string, status: "approved" | "sketch"): ApproveResult {
  const { snap, inBranches } = locate(p, id);
  let file = snap.file;
  if (inBranches) {
    file = freeFileName(p.root, DIRS.snapshots, path.basename(snap.file, ".md"));
    moveProjectFile(p.root, snap.file, file);
  }
  updateObjectFile(p.root, file, { status, pruned: undefined });
  const pruned: string[] = [];
  const group = snap.value.candidate?.group;
  if (group && status === "approved") {
    for (const s of p.branchSnapshots) {
      if (s.value.id !== id && s.value.candidate?.group === group && !s.value.pruned) {
        updateObjectFile(p.root, s.file, { pruned: true });
        pruned.push(s.value.id);
      }
    }
  }
  const warnings = spanningBridges(p, snap.value.t).map(
    (b) => `桥 ${b} 跨过了 t=${snap.value.t}：它不再连接相邻快照，需要拆成两座桥或删掉`,
  );
  return { file: toPosix(file), pruned, warnings };
}

export function approveSnapshot(p: Project, id: string): ApproveResult {
  return promote(p, id, "approved");
}

/** Bring a pruned candidate back onto the timeline as a sketch (spec §6-U3 嫁接). */
export function graftSnapshot(p: Project, id: string): ApproveResult {
  const { inBranches } = locate(p, id);
  if (!inBranches) throw new Error(`${id} 不在 branches/ 里，不需要嫁接`);
  return promote(p, id, "sketch");
}

export interface AdoptResult {
  target: string;
  file: string;
  version: { v: number; path: string };
  warnings: string[];
}

/** "The bridge is better than I planned": the derived snapshot becomes the target's state. */
export function adoptDerived(p: Project, bridgeId: string): AdoptResult {
  const b = findBridge(p, bridgeId).value;
  const d = b.derived_snapshot;
  if (!d) throw new Error(`桥 ${bridgeId} 还没有到达状态：先运行 sw bridge check ${bridgeId} 或 sw extract ${bridgeId}`);
  const warnings: string[] = [];
  if (d.text_hash && d.text_hash !== hash(b.text)) warnings.push("到达状态是从旧正文提取的，正文之后改过");
  const target = p.snapshots.find((s) => s.value.id === b.to);
  if (!target) throw new Error(`找不到终点快照：${b.to}`);
  const version = saveVersion(p.root, DIRS.snapshots, target.value.id, target.file);
  // characters the bridge never mentions keep their planned state
  const char_states = { ...target.value.char_states, ...d.char_states };
  const kept = Object.keys(target.value.char_states).filter((c) => !(c in d.char_states));
  if (kept.length) warnings.push(`到达状态里没有 ${kept.join("、")}，保留原目标状态`);
  updateObjectFile(p.root, target.file, {
    world_facts: d.world_facts,
    char_states,
    origin: "derived",
    adopted_from: { bridge: bridgeId, at: new Date().toISOString(), previous: version.path },
  });
  return { target: target.value.id, file: target.file, version, warnings };
}

const StartOutput = z.object({
  title: z.string().min(1),
  world_facts: z.array(z.string()).default([]),
  char_states: z.record(z.string(), CharState).default({}),
});

export interface StartDraftResult {
  id: string;
  file: string;
}

/** U2: a start-snapshot draft from hard facts + the author's opening (origin llm-candidate, status sketch). */
export async function draftStartSnapshot(
  p: Project,
  ctx: LlmContext,
  input: { id: string; t?: number; title?: string; opening: string; characters?: string[] },
): Promise<StartDraftResult> {
  if (p.snapshots.some((s) => s.value.id === input.id)) throw new Error(`快照 id 已存在：${input.id}`);
  const characterLanes = p.config.lanes.filter((l) => l.kind === "character");
  const lanes = input.characters?.length
    ? input.characters.map((c) => characterLanes.find((l) => l.id === c || (l.profile ?? l.id) === c)?.id ?? c)
    : characterLanes.map((l) => l.id);
  const pseudo = { lanes, char_states: {} } as unknown as Snapshot;
  const cast: Cast[] = castOf(p, pseudo);
  if (!cast.length) throw new Error("没有找到人物：在 project.yaml 的 lanes 里加人物泳道，或用 --chars 指定");
  const brief = characterBriefs(p, cast, input.t ?? 0);
  const out = await callStructured(ctx, {
    task: `start:${input.id}`,
    template: opsTemplate("start-draft"),
    schema: StartOutput,
    summary: `起点草稿 ${input.id} · 人物 ${cast.map((c) => c.profile.id).join(",")} · 开场设定 ${input.opening.length} 字`,
    vars: { principles: genPrinciples(), opening: input.opening, characters: brief.text },
  });
  const laneIds = new Set(cast.map((c) => c.lane));
  const world = p.config.lanes.filter((l) => l.kind === "world").map((l) => l.id);
  const fm = {
    id: input.id,
    title: input.title ?? out.title,
    t: input.t ?? 0,
    lanes: [...world, ...cast.map((c) => c.lane)],
    world_facts: out.world_facts,
    char_states: Object.fromEntries(Object.entries(out.char_states).filter(([k]) => laneIds.has(k))),
    status: "sketch",
    origin: "llm-candidate",
  };
  const file = freeFileName(p.root, DIRS.snapshots, input.id);
  writeProjectFile(p.root, file, renderMarkdownFile(fm, `开场设定（作者）：${input.opening}`));
  return { id: input.id, file };
}

// U3 加点: 2–4 candidate snapshots between two adjacent approved ones, differing on the dimensions
// the author names. Candidates live in branches/ as sketches until one is approved (spec §6-U3).
import { CharState, DIRS, ENDPOINT_STATUSES, type Project, freeFileName, renderMarkdownFile, writeProjectFile } from "@sw/core";
import { renderUnknowns } from "@sw/checks";
import { type LlmContext, callStructured } from "@sw/llm";
import { z } from "zod";
import { castOf, characterBriefs, findSnapshot, genPrinciples, hash, opsTemplate, renderSnapshot } from "./brief";

const CandidateOutput = z.object({
  candidates: z
    .array(
      z.object({
        title: z.string().min(1),
        dims: z.record(z.string(), z.string()),
        world_facts: z.array(z.string()).default([]),
        char_states: z.record(z.string(), CharState).default({}),
        touches_unknowns: z.array(z.string()).default([]),
        rationale: z.string().default(""),
      }),
    )
    .min(1),
});

export interface Candidate {
  id: string;
  file: string;
  title: string;
  t: number;
  dims: Record<string, string>;
  touches: string[];
}

export interface CandidatesResult {
  group: string;
  candidates: Candidate[];
  /** dimensions on which two candidates gave the same value (normalised) */
  indistinct: { dim: string; ids: string[] }[];
  notes: string[];
}

const norm = (s: string) => s.replace(/[\s。．.！!？?；;，,、“”"「」]/g, "");

/** For each dimension, groups of candidates whose values are the same after normalisation. */
export function indistinctDims(cands: { id: string; dims: Record<string, string> }[], dims: string[]) {
  const out: { dim: string; ids: string[] }[] = [];
  for (const d of dims) {
    const seen = new Map<string, string[]>();
    for (const c of cands) {
      const v = norm(c.dims[d] ?? "");
      seen.set(v, [...(seen.get(v) ?? []), c.id]);
    }
    for (const [v, ids] of seen) if (ids.length > 1 || !v) out.push({ dim: d, ids });
  }
  return out;
}

export async function generateCandidates(
  p: Project,
  ctx: LlmContext,
  input: { from: string; to: string; dims: string[]; k?: number },
): Promise<CandidatesResult> {
  const k = input.k ?? 3;
  if (k < 2 || k > 4) throw new Error("候选数量只能是 2 到 4 个（规格 §6-U3）");
  if (!input.dims.length) throw new Error("至少给一个区分维度，例如 --dims 谁推动,冲突在哪");
  const from = findSnapshot(p, input.from);
  const to = findSnapshot(p, input.to);
  for (const s of [from, to]) {
    if (!ENDPOINT_STATUSES.includes(s.status)) throw new Error(`快照 ${s.id} 状态为 ${s.status}，只能在 approved / locked 快照之间加点`);
  }
  if (from.t >= to.t) throw new Error(`${from.id}（t=${from.t}）必须早于 ${to.id}（t=${to.t}）`);
  const between = p.snapshots.filter((s) => ENDPOINT_STATUSES.includes(s.value.status) && s.value.t > from.t && s.value.t < to.t);
  if (between.length) throw new Error(`${from.id} 与 ${to.id} 不相邻：中间还有 ${between.map((s) => s.value.id).join("、")}`);

  const cast = castOf(p, from, to);
  const brief = characterBriefs(p, cast, from.t);
  const out = await callStructured(ctx, {
    task: `candidates:${from.id}~${to.id}`,
    template: opsTemplate("candidates"),
    schema: CandidateOutput,
    summary: `候选 ${from.id} → ${to.id} · ${k} 个 · 维度 ${input.dims.join("、")}`,
    vars: {
      principles: genPrinciples(),
      from: renderSnapshot(from),
      to: renderSnapshot(to),
      characters: brief.text,
      unknowns: renderUnknowns(brief.scope),
      k: String(k),
      dims: input.dims.map((d) => `- ${d}`).join("\n"),
    },
  });

  const notes: string[] = [];
  if (out.candidates.length !== k) notes.push(`要了 ${k} 个候选，模型给了 ${out.candidates.length} 个`);
  const group = `${from.id}~${to.id}-${hash(`${input.dims.join("|")}|${new Date().toISOString()}`).slice(0, 6)}`;
  const t = (from.t + to.t) / 2;
  const lanes = [...new Set([...from.lanes, ...to.lanes])];
  const laneSet = new Set(lanes);
  const scopeKeys = new Set(brief.scope.map((s) => s.key));
  const candidates: Candidate[] = out.candidates.map((c, i) => {
    const id = `${group}-c${i + 1}`;
    const dims = Object.fromEntries(input.dims.map((d) => [d, c.dims[d] ?? ""]));
    const touches = c.touches_unknowns.filter((u) => scopeKeys.has(u));
    const char_states = Object.fromEntries(Object.entries(c.char_states).filter(([lane]) => laneSet.has(lane)));
    const fm = {
      id,
      title: c.title,
      t,
      lanes,
      world_facts: c.world_facts,
      char_states,
      status: "sketch",
      origin: "llm-candidate",
      candidate: { group, from: from.id, to: to.id, dims, touches_unknowns: touches },
    };
    const touchNote = touches.length ? `\n\n会触碰的留白：\n${touches.map((u) => `- ${u}`).join("\n")}` : "";
    const file = freeFileName(p.root, DIRS.branches, id);
    writeProjectFile(p.root, file, renderMarkdownFile(fm, `${c.rationale}${touchNote}`));
    return { id, file, title: c.title, t, dims, touches };
  });
  const missingDims = candidates.flatMap((c) => input.dims.filter((d) => !c.dims[d]).map((d) => `${c.id} 缺少维度「${d}」`));
  notes.push(...missingDims);
  return { group, candidates, indistinct: indistinctDims(candidates, input.dims), notes };
}

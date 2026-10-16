// What generation prompts see (spec §3.4 最小注入, §6-U5): the two snapshots and, per character,
// rules, boundaries, public facts, unknowns and the state at the bridge's start.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  type CharState,
  type Profile,
  type Project,
  type Snapshot,
  anchorEntries,
  contentHash,
  profileById,
  publicEntries,
  readText,
  renderState,
  stateAt,
} from "@sw/core";
import { type ScopedUnknown, listEntries, renderUnknowns, unknownScope } from "@sw/checks";
import { type Template, loadTemplate } from "@sw/llm";

const PROMPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prompts");
export const opsTemplate = (id: string): Template => loadTemplate(path.join(PROMPTS, `${id}.md`));
export const genPrinciples = (): string => readText(path.join(PROMPTS, "principles.md")).trim();

export const hash = (s: string): string => contentHash(s);

export function findSnapshot(p: Project, id: string, opts: { branches?: boolean } = {}): Snapshot {
  const pool = opts.branches ? [...p.snapshots, ...p.branchSnapshots] : p.snapshots;
  const s = pool.find((x) => x.value.id === id)?.value;
  if (!s) throw new Error(`找不到快照：${id}`);
  return s;
}

export interface Cast {
  lane: string;
  profile: Profile;
}

/** Character lanes of the given snapshots, resolved to profiles (lanes without a profile are skipped). */
export function castOf(p: Project, ...snaps: Snapshot[]): Cast[] {
  const lanes = new Map(p.config.lanes.map((l) => [l.id, l]));
  const out: Cast[] = [];
  for (const id of new Set(snaps.flatMap((s) => [...s.lanes, ...Object.keys(s.char_states)]))) {
    const l = lanes.get(id);
    if (l?.kind === "world") continue;
    const pr = profileById(p, l?.profile ?? id);
    if (pr && !out.some((c) => c.profile.id === pr.id)) out.push({ lane: id, profile: pr });
  }
  return out;
}

function renderCharState(st: CharState): string {
  const lines = [`知道：${st.knows.join("；") || "（未列出）"}`, `想要：${st.wants.join("；") || "（未列出）"}`];
  if (st.feels) lines.push(`情绪：${st.feels}`);
  if (st.location) lines.push(`位置：${st.location}`);
  const rel = Object.entries(st.relationships ?? {});
  if (rel.length) lines.push(`关系：${rel.map(([k, v]) => `${k}——${v}`).join("；")}`);
  if (st.resources?.length) lines.push(`资源：${st.resources.join("；")}`);
  return lines.join("\n");
}

export function renderSnapshot(s: Pick<Snapshot, "world_facts" | "char_states"> & Partial<Snapshot>): string {
  const out: string[] = [];
  if (s.id) out.push(`${s.id}「${s.title ?? ""}」${s.t !== undefined ? `（t=${s.t}${s.t_label ? `，${s.t_label}` : ""}）` : ""}`);
  out.push("世界事实：", s.world_facts.length ? s.world_facts.map((f) => `- ${f}`).join("\n") : "（无）");
  for (const [c, st] of Object.entries(s.char_states)) out.push(`人物 [${c}]：`, renderCharState(st));
  if (s.author_notes) out.push(`作者备注：${s.author_notes}`);
  return out.join("\n");
}

export interface Brief {
  text: string;
  /** what went in, for bridge.injected (spec §4.3) and the call log */
  injected: Record<string, unknown>;
  scope: ScopedUnknown[];
}

/**
 * Character briefs for a generation step at time t. Secret hard facts (the character doesn't know
 * them) are withheld so the model can't write them into the story (D-033).
 */
export function characterBriefs(p: Project, cast: Cast[], t: number): Brief {
  const scope = unknownScope(p, cast.map((c) => c.profile.id));
  const injected: Record<string, unknown> = {};
  const blocks = cast.map(({ lane, profile: pr }) => {
    const heuristics = anchorEntries(pr.heuristics);
    const boundaries = anchorEntries(pr.boundaries);
    const traits = anchorEntries(pr.traits);
    const facts = publicEntries(anchorEntries(pr.hard_facts));
    const st = stateAt(p, pr.id, t);
    const mine = scope.filter((s) => s.key.startsWith(`${pr.id}.`));
    injected[pr.id] = {
      heuristics: heuristics.map((e) => e.id),
      boundaries: boundaries.map((e) => e.id),
      traits: traits.map((e) => e.id),
      hard_facts: facts.map((e) => e.id),
      secret_withheld: pr.hard_facts.length - publicEntries(pr.hard_facts).length,
      unknowns: mine.map((s) => s.key),
      state_from: st.snapshot?.id ?? null,
      deltas: st.deltas.map((d) => d.id),
    };
    return [
      `### ${pr.name} [${lane}]`,
      `角色核心：${pr.core ?? "（未写）"}`,
      `决策规则：\n${heuristics.length ? listEntries(heuristics) : "（档案没有决策规则）"}`,
      `核心人格：\n${listEntries(traits)}`,
      `硬边界（不得违反）：\n${listEntries(boundaries)}`,
      `已定事实：\n${listEntries(facts)}`,
      `留白（不得回答、不得暗示）：\n${renderUnknowns(mine)}`,
      `此刻状态：\n${renderState(st)}`,
      st.turns.length ? `已被作者接受的转折：\n${st.turns.map((a) => `- （t=${a.t}）${a.delta}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  const project = scope.filter((s) => s.key.startsWith("project."));
  if (project.length) blocks.push(`### 项目级留白（不得回答、不得暗示）\n${renderUnknowns(project)}`);
  return { text: blocks.join("\n\n") || "（无）", injected, scope };
}

/** The project's voice sample (QUESTIONS 8: one per project), or undefined when there is none. */
export function voiceSample(p: Project): { path: string; text: string } | undefined {
  const rel = p.config.voice_sample;
  if (!rel) return undefined;
  const abs = path.resolve(p.root, rel);
  if (!fs.existsSync(abs)) throw new Error(`project.yaml 的 voice_sample 指向的文件不存在：${abs}`);
  return { path: rel, text: readText(abs).trim() };
}

export const NO_VOICE_NOTE = "没有声音样本：正文风格不可控（在 project.yaml 写 voice_sample 指向一段你自己的文字）";

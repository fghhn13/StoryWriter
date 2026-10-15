// M1 entry point: a scene text + involved profiles + a start snapshot → axes A, B, C.
import {
  type Project,
  type Snapshot,
  anchorEntries,
  involvedCharacters,
  normalizeEntries,
  profileById,
  stateAt,
} from "@sw/core";
import type { LlmContext } from "@sw/llm";
import { checkAxisA } from "./axis-a";
import { checkAxisB } from "./axis-b";
import { type ScopedUnknown, checkAxisC, renderUnknowns } from "./axis-c";
import type { CheckResult } from "./common";

export type TextAxis = "A" | "B" | "C";

export interface RunInput {
  text: string;
  /** start snapshot id; its t indexes every character state (spec §3.7) */
  from: string;
  /** profile ids (or names/aliases); default: snapshot lanes + characters named in the text */
  characters?: string[];
  axes?: TextAxis[];
  /** samples per check; default project.sampling */
  n?: number;
  onProgress?: (msg: string) => void;
}

export interface RunResult {
  from: Snapshot;
  characters: string[];
  results: CheckResult[];
}

export function unknownScope(p: Project, characters: string[]): ScopedUnknown[] {
  const scope: ScopedUnknown[] = [];
  for (const id of characters) {
    const pr = profileById(p, id);
    // 〔Agent 建议〕-style unknowns are suggestions, not the author's (D-006)
    for (const e of anchorEntries(pr?.unknowns ?? [])) scope.push({ key: `${pr!.id}.${e.id}`, owner: pr!.name, entry: e });
  }
  for (const e of normalizeEntries("unknowns", p.config.unknowns)) scope.push({ key: `project.${e.id}`, owner: "项目", entry: e });
  return scope;
}

function priorArrivals(p: Project, t: number): string[] {
  const snaps = new Map(p.snapshots.map((s) => [s.value.id, s.value]));
  return p.bridges
    .map((b) => b.value)
    .filter((b) => b.status === "locked" && b.derived_snapshot && (snaps.get(b.to)?.t ?? Infinity) <= t)
    .map((b) => {
      const d = b.derived_snapshot!;
      const chars = Object.entries(d.char_states).map(([c, s]) => `${c} 知道：${s.knows.join("；") || "—"}；想要：${s.wants.join("；") || "—"}`);
      return `#### 桥 ${b.id}（${b.from} → ${b.to}）\n世界：${d.world_facts.join("；") || "—"}\n${chars.join("\n")}`;
    });
}

export async function runTextChecks(p: Project, ctx: LlmContext, input: RunInput): Promise<RunResult> {
  const from = p.snapshots.find((s) => s.value.id === input.from)?.value;
  if (!from) throw new Error(`找不到起点快照：${input.from}`);
  const profiles = input.characters
    ? input.characters.map((c) => {
        const pr = profileById(p, c);
        if (!pr) throw new Error(`找不到人物档案：${c}`);
        return pr;
      })
    : involvedCharacters(p, input.text, from);
  if (!profiles.length) throw new Error("没有找到涉及的人物；用 --chars 指定");
  const ids = profiles.map((pr) => pr.id);
  const n = input.n ?? p.config.sampling;
  const axes = input.axes ?? ["A", "B", "C"];
  const states = ids.map((id) => stateAt(p, id, from.t));
  const scope = unknownScope(p, ids);
  const say = input.onProgress ?? (() => {});

  // axes run one after another so the relay sees at most `concurrency` calls at once
  const results: CheckResult[] = [];
  if (axes.includes("A")) {
    for (const [i, pr] of profiles.entries()) {
      say(`轴 A · ${pr.name}（${n} 次采样）`);
      results.push(await checkAxisA(ctx, { profile: pr, state: states[i]!, text: input.text, n }));
    }
  }
  if (axes.includes("B")) {
    say(`轴 B · 连续性（${n} 次采样）`);
    results.push(
      await checkAxisB(ctx, {
        text: input.text,
        worldFacts: from.world_facts,
        profiles,
        states,
        prior: priorArrivals(p, from.t),
        unknowns: renderUnknowns(scope),
        n,
      }),
    );
  }
  if (axes.includes("C")) {
    say(`轴 C · 留白（${n} 次采样）`);
    results.push(await checkAxisC(ctx, { text: input.text, scope, n }));
  }
  return { from, characters: ids, results };
}

/** Calls a run will make, for the cost prompt (spec §6-U8). Repair turns may add up to the same again. */
export function estimateCalls(characters: number, axes: TextAxis[], n: number): number {
  return n * ((axes.includes("A") ? characters : 0) + (axes.includes("B") ? 1 : 0) + (axes.includes("C") ? 1 : 0));
}

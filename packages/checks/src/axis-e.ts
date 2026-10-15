// Axis E · 伏笔偏差 (spec §5-E). The thread is a new fact; every node after the planting point is
// re-read against it (axis B's rules: contradiction by category), plus a visibility check and,
// at the payoff node, whether the thread is paid off. One call per node, sampled (D-045).
import { type LlmContext, sampleStructured, spreadConfidence } from "@sw/llm";
import { z } from "zod";
import { CATEGORY_WEIGHT } from "./axis-b";
import { type CheckResult, type Evidence, principles, quoteInText, saturate, template } from "./common";

const Category = z.enum(["knowledge", "spacetime", "object", "relationship"]);
export const AxisEOutput = z.object({
  conflicts: z
    .array(z.object({ quote: z.string(), category: Category, reason: z.string().default("") }))
    .default([]),
  leaks: z.array(z.object({ character: z.string(), quote: z.string(), reason: z.string().default("") })).default([]),
  pays_off: z.boolean().nullable().optional(),
  payoff_quote: z.string().nullable().optional(),
});
export type AxisEOutput = z.infer<typeof AxisEOutput>;

/** a visibility leak weighs like a knowledge leak */
export const LEAK_WEIGHT = 3;

export function scoreAxisENode(out: AxisEOutput, content: string): number {
  const w =
    out.conflicts.filter((c) => quoteInText(c.quote, content)).reduce((s, c) => s + CATEGORY_WEIGHT[c.category], 0) +
    out.leaks.filter((l) => quoteInText(l.quote, content)).length * LEAK_WEIGHT;
  return saturate(w);
}

export interface ThreadNode {
  /** snapshot id or bridge id */
  id: string;
  kind: "snapshot" | "bridge";
  t: number;
  /** what the model reads: a rendered snapshot or the bridge text */
  content: string;
  isPayoff: boolean;
}

export interface ThreadInput {
  id: string;
  description: string;
  visibility: "reader_only" | "character" | "hidden";
  known_by: string[];
  planted_at: string;
  payoff_at?: string | null;
}

export interface NodeResult {
  node: string;
  kind: ThreadNode["kind"];
  t: number;
  score: number;
  scores: number[];
  conflicts: AxisEOutput["conflicts"];
  leaks: AxisEOutput["leaks"];
  pays_off?: boolean | null;
}

const VISIBILITY: Record<ThreadInput["visibility"], (known: string[]) => string> = {
  reader_only: () => "读者知道，任何人物都不知道。人物的言行如果显示他知道这件事，就是泄漏。",
  character: (known) => `只有这些人物知道：${known.join("、") || "（未列出）"}。其他人物的言行如果显示他知道，就是泄漏。`,
  hidden: () => "已经埋下，但读者此时还不该察觉。文本如果把它点明到读者能直接看出来，就是泄漏（character 填 \"reader\"）。",
};

export async function checkAxisE(
  ctx: LlmContext,
  input: { thread: ThreadInput; nodes: ThreadNode[]; characters: string; n: number; warn: number },
): Promise<CheckResult> {
  const th = input.thread;
  const results: NodeResult[] = [];
  const evidence: Evidence[] = [];
  let failed = 0;
  for (const node of input.nodes) {
    const res = await sampleStructured(
      ctx,
      {
        task: `axis-e:${th.id}@${node.id}`,
        template: template("axis-e"),
        schema: AxisEOutput,
        summary: `轴E ${th.id} @ ${node.kind} ${node.id}（t=${node.t}）${node.isPayoff ? " 收点" : ""}`,
        vars: {
          principles: principles(),
          thread: th.description,
          visibility: VISIBILITY[th.visibility](th.known_by),
          characters: input.characters,
          node_kind: node.kind === "snapshot" ? "快照（某一时刻的状态）" : "桥（一段情节正文）",
          node: node.content,
          payoff: node.isPayoff ? "这里是这条线的收点：判断这段内容有没有兑现这条线（pays_off）。" : "这里不是收点：pays_off 填 null。",
        },
      },
      input.n,
      (v) => scoreAxisENode(v, node.content),
    );
    failed += res.failed.length;
    const out = res.representative.value;
    results.push({ node: node.id, kind: node.kind, t: node.t, score: res.median, scores: res.scores, conflicts: out.conflicts, leaks: out.leaks, pays_off: out.pays_off });
    for (const c of out.conflicts) {
      evidence.push({
        quote: c.quote,
        rule: node.id,
        direction: "opposite",
        expected: `与线「${th.id}」矛盾`,
        note: `${node.kind === "snapshot" ? "快照" : "桥"} ${node.id}（t=${node.t}）·${c.category}：${c.reason}`,
        weight: CATEGORY_WEIGHT[c.category],
        verified: quoteInText(c.quote, node.content),
      });
    }
    for (const l of out.leaks) {
      evidence.push({
        quote: l.quote,
        rule: node.id,
        direction: "opposite",
        expected: `可见性：${VISIBILITY[th.visibility](th.known_by)}`,
        note: `泄漏（${l.character}）：${l.reason}`,
        weight: LEAK_WEIGHT,
        verified: quoteInText(l.quote, node.content),
      });
    }
  }

  const payoffNode = results.find((r) => input.nodes.find((n) => n.id === r.node)?.isPayoff);
  // unpaid is shown on its own and never scored (spec §5-E)
  const unpaid = !th.payoff_at || !payoffNode || payoffNode.pays_off !== true;
  const affected = results.filter((r) => r.score >= input.warn).map((r) => r.node);
  const notes: string[] = [];
  if (!input.nodes.length) notes.push("埋点之后没有快照或桥，没有可检查的节点");
  if (unpaid) notes.push(th.payoff_at ? `收点 ${th.payoff_at} 没有兑现这条线（未收）` : "这条线还没有收点（未收）");
  if (affected.length) notes.push(`受影响节点：${affected.join("、")}`);
  const unverified = evidence.filter((e) => !e.verified).length;
  if (unverified) notes.push(`${unverified} 条引文在原文里找不到，已排除出打分`);
  if (failed) notes.push(`${failed} 个样本输出无效，已丢弃`);
  const score = Math.max(0, ...results.map((r) => r.score));
  const allScores = results.map((r) => r.score);

  return {
    axis: "E",
    score,
    confidence: results.length ? +Math.min(...results.map((r) => spreadConfidence(r.scores))).toFixed(2) : 1,
    samples: { n: input.n, scores: allScores, failed },
    prediction: `线「${th.id}」作为新增事实，埋点之后的内容都应与之相容`,
    observed: results.map((r) => `[${r.node}] ${r.score}`).join("\n"),
    evidence,
    notes,
    details: { nodes: results, affected, unpaid },
  };
}

// Axis A · 人物偏差 (spec §5-A). Anchors: heuristics, boundaries, traits; never llm-origin entries.
import { type Profile, type StateAt, anchorEntries, renderState } from "@sw/core";
import { type LlmContext, sampleStructured } from "@sw/llm";
import { z } from "zod";
import { type CheckResult, type Evidence, FixSchema, listEntries, principles, quoteInText, saturate, template, toFix } from "./common";

export const AxisAOutput = z.object({
  heuristic_answers: z.array(z.object({ rule: z.string(), answer: z.string() })).default([]),
  behaviors: z.array(z.object({ id: z.string(), quote: z.string(), action: z.string().default("") })).default([]),
  judgments: z
    .array(
      z.object({
        behavior: z.string(),
        rule: z.string(),
        direction: z.enum(["same", "opposite", "irrelevant"]),
        severity: z.number().int().min(1).max(3).nullable().optional(),
        reason: z.string().default(""),
      }),
    )
    .default([]),
  boundary_hits: z.array(z.object({ rule: z.string(), quote: z.string(), reason: z.string().default("") })).default([]),
  cheapest_fix: FixSchema,
});
export type AxisAOutput = z.infer<typeof AxisAOutput>;

export const NO_HEURISTICS_CAP = 0.3;
export const NO_HEURISTICS_NOTE = "此人物无决策规则，人物偏差不可信（置信度上限 0.3）";

/** Score from structure (spec §3.2): opposite weight per behaviour (max severity), boundary hit ⇒ ≥80. */
export function scoreAxisA(out: AxisAOutput, text: string): number {
  const quotes = new Map(out.behaviors.map((b) => [b.id, b.quote]));
  const perBehavior = new Map<string, number>();
  for (const j of out.judgments) {
    if (j.direction !== "opposite" || !quoteInText(quotes.get(j.behavior), text)) continue;
    perBehavior.set(j.behavior, Math.max(perBehavior.get(j.behavior) ?? 0, j.severity ?? 2));
  }
  let score = saturate([...perBehavior.values()].reduce((a, b) => a + b, 0));
  if (out.boundary_hits.some((h) => quoteInText(h.quote, text))) score = Math.max(score, 80);
  return score;
}

export async function checkAxisA(
  ctx: LlmContext,
  input: { profile: Profile; state: StateAt; text: string; n: number },
): Promise<CheckResult> {
  const { profile: pr, state, text } = input;
  const heuristics = anchorEntries(pr.heuristics);
  const traits = anchorEntries(pr.traits);
  const boundaries = anchorEntries(pr.boundaries);
  const rules = new Map([...heuristics, ...traits, ...boundaries].map((e) => [e.id, e.text]));

  const res = await sampleStructured(
    ctx,
    {
      task: `axis-a:${pr.id}`,
      template: template("axis-a"),
      schema: AxisAOutput,
      summary: `轴A ${pr.id}：规则${heuristics.length} 人格${traits.length} 边界${boundaries.length} 留白${pr.unknowns.length} 起点${state.snapshot?.id ?? "-"} 文本${text.length}字`,
      vars: {
        principles: principles(),
        name: pr.name,
        core: pr.core ?? "（未写）",
        heuristics: heuristics.length ? listEntries(heuristics) : "（档案没有决策规则。只能对照核心人格判断。）",
        traits: listEntries(traits),
        boundaries: listEntries(boundaries),
        unknowns: listEntries(pr.unknowns),
        state: renderState(state),
        turns: state.turns.length ? state.turns.map((a) => `- （t=${a.t}）${a.delta}——作者理由：${a.justification}`).join("\n") : "（无）",
        text,
      },
    },
    input.n,
    (v) => scoreAxisA(v, text),
  );

  const out = res.representative.value;
  const answers = new Map(out.heuristic_answers.map((h) => [h.rule, h.answer]));
  const behaviors = new Map(out.behaviors.map((b) => [b.id, b]));
  const evidence: Evidence[] = [
    ...out.boundary_hits.map((h) => ({
      quote: h.quote,
      rule: h.rule,
      rule_text: rules.get(h.rule),
      direction: "opposite" as const,
      expected: `硬边界：${rules.get(h.rule) ?? h.rule}`,
      note: h.reason,
      weight: 3,
      verified: quoteInText(h.quote, text),
    })),
    ...out.judgments
      .filter((j) => j.direction !== "irrelevant")
      .map((j) => {
        const b = behaviors.get(j.behavior);
        return {
          quote: b?.quote ?? "",
          rule: j.rule,
          rule_text: rules.get(j.rule),
          direction: j.direction,
          expected: answers.get(j.rule) ?? (rules.has(j.rule) ? `按人格应当：${rules.get(j.rule)}` : undefined),
          note: j.reason,
          weight: j.direction === "opposite" ? (j.severity ?? 2) : undefined,
          verified: quoteInText(b?.quote, text),
        };
      }),
  ];

  const notes: string[] = [];
  let confidence = res.confidence;
  if (!heuristics.length) {
    confidence = Math.min(confidence, NO_HEURISTICS_CAP);
    notes.push(NO_HEURISTICS_NOTE);
  }
  if (pr.heuristics.length > heuristics.length) notes.push(`有 ${pr.heuristics.length - heuristics.length} 条决策规则来自推演，未作为锚点`);
  const unverified = evidence.filter((e) => !e.verified).length;
  if (unverified) notes.push(`${unverified} 条证据的引文在原文里找不到，已排除出打分`);
  if (res.failed.length) notes.push(`${res.failed.length} 个样本输出无效，已丢弃`);

  return {
    axis: "A",
    character: pr.id,
    score: res.median,
    confidence: +confidence.toFixed(2),
    samples: { n: input.n, scores: res.scores, failed: res.failed.length },
    prediction: out.heuristic_answers.map((h) => `[${h.rule}] ${h.answer}`).join("\n"),
    observed: out.behaviors.map((b) => `[${b.id}] ${b.quote}`).join("\n"),
    evidence,
    suggestion: toFix(out.cheapest_fix, text),
    notes,
    details: out,
  };
}

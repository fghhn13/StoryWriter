// Axis B · 连续性偏差 (spec §5-B). One call covers every involved character.
import { type Profile, type StateAt, renderState } from "@sw/core";
import { type LlmContext, sampleStructured } from "@sw/llm";
import { z } from "zod";
import { type CheckResult, type Evidence, FixSchema, listEntries, principles, quoteInText, saturate, template, toFix } from "./common";

const Category = z.enum(["knowledge", "spacetime", "object", "relationship"]);
export const AxisBOutput = z.object({
  premises: z
    .array(
      z.object({
        id: z.string(),
        quote: z.string(),
        premise: z.string(),
        category: Category,
        character: z.string().nullable().optional(),
        status: z.enum(["true", "false", "unmentioned"]),
        state_field: z.string().nullable().optional(),
        reason: z.string().default(""),
      }),
    )
    .default([]),
  cheapest_fix: FixSchema,
});
export type AxisBOutput = z.infer<typeof AxisBOutput>;

// knowledge leaks weigh most, then time/place, then objects and relationships (spec §5-B.3)
export const CATEGORY_WEIGHT: Record<z.infer<typeof Category>, number> = { knowledge: 3, spacetime: 2, object: 1, relationship: 1 };
const CATEGORY_LABEL: Record<z.infer<typeof Category>, string> = { knowledge: "知识", spacetime: "时空", object: "物品", relationship: "关系" };

export function scoreAxisB(out: AxisBOutput, text: string): number {
  const w = out.premises
    .filter((p) => p.status === "false" && quoteInText(p.quote, text))
    .reduce((s, p) => s + CATEGORY_WEIGHT[p.category], 0);
  return saturate(w);
}

export interface AxisBInput {
  text: string;
  worldFacts: string[];
  profiles: Profile[];
  states: StateAt[];
  /** derived snapshots of earlier locked bridges, rendered as text */
  prior: string[];
  unknowns: string;
  n: number;
}

export async function checkAxisB(ctx: LlmContext, input: AxisBInput): Promise<CheckResult> {
  const { text } = input;
  const res = await sampleStructured(
    ctx,
    {
      task: "axis-b",
      template: template("axis-b"),
      schema: AxisBOutput,
      summary: `轴B：人物 ${input.profiles.map((p) => p.id).join(",")} 世界事实${input.worldFacts.length} 先前段落${input.prior.length} 文本${text.length}字`,
      vars: {
        principles: principles(),
        world_facts: input.worldFacts.length ? input.worldFacts.map((f) => `- ${f}`).join("\n") : "（无）",
        hard_facts: input.profiles.map((p) => `#### ${p.name}（${p.id}）\n${listEntries(p.hard_facts)}`).join("\n\n") || "（无）",
        states: input.states.map((s) => `#### ${s.character}\n${renderState(s)}`).join("\n\n") || "（无）",
        prior: input.prior.length ? input.prior.join("\n\n") : "（无）",
        unknowns: input.unknowns,
        text,
      },
    },
    input.n,
    (v) => scoreAxisB(v, text),
  );

  const out = res.representative.value;
  const evidence: Evidence[] = out.premises
    .filter((p) => p.status === "false")
    .map((p) => ({
      quote: p.quote,
      rule: p.state_field ?? undefined,
      direction: "opposite" as const,
      expected: `前提「${p.premise}」与状态 ${p.state_field ?? "?"} 矛盾`,
      note: `${CATEGORY_LABEL[p.category]}：${p.reason}`,
      weight: CATEGORY_WEIGHT[p.category],
      verified: quoteInText(p.quote, text),
    }));
  const unmentioned = out.premises.filter((p) => p.status === "unmentioned");
  const notes: string[] = [];
  const unverified = evidence.filter((e) => !e.verified).length;
  if (unverified) notes.push(`${unverified} 条矛盾的引文在原文里找不到，已排除出打分`);
  if (res.failed.length) notes.push(`${res.failed.length} 个样本输出无效，已丢弃`);

  return {
    axis: "B",
    score: res.median,
    confidence: +res.confidence.toFixed(2),
    samples: { n: input.n, scores: res.scores, failed: res.failed.length },
    prediction: "文本所需的前提都应在起点状态中为真",
    observed: out.premises.filter((p) => p.status === "false").map((p) => `[${p.id}] ${p.premise}`).join("\n"),
    evidence,
    suggestion: toFix(out.cheapest_fix, text),
    notes,
    // unmentioned premises go to axis C and the harvest list (spec §5-B.4, §6-U9)
    details: { ...out, unmentioned: unmentioned.map((p) => ({ quote: p.quote, premise: p.premise, character: p.character })) },
  };
}

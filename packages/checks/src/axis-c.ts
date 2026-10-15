// Axis C · 留白侵入 (spec §5-C).
import type { Entry } from "@sw/core";
import { type LlmContext, sampleStructured } from "@sw/llm";
import { z } from "zod";
import { type CheckResult, type Evidence, FixSchema, principles, quoteInText, template, toFix } from "./common";

export const AxisCOutput = z.object({
  unknowns: z
    .array(
      z.object({
        rule: z.string(),
        answer_level: z.enum(["explicit", "strong_hint", "none"]),
        quote: z.string().nullable().optional(),
        load_bearing: z.boolean().default(false),
        reason: z.string().default(""),
      }),
    )
    .default([]),
  cheapest_fix: FixSchema,
});
export type AxisCOutput = z.infer<typeof AxisCOutput>;

/** An unknown in scope, with an id unique across characters ("ancore.u1", "project.u2"). */
export interface ScopedUnknown {
  key: string;
  owner: string;
  entry: Entry;
}

const LEVEL_SCORE = { explicit: 100, strong_hint: 50, none: 0 } as const;

/**
 * Per unknown: explicit 100, strong hint 50; halved when not load-bearing; a permanent unknown
 * answered explicitly is 100 regardless. The check's score is the worst unknown (D-022).
 */
export function scoreUnknown(u: AxisCOutput["unknowns"][number], scoped: ScopedUnknown | undefined, text: string): number {
  if (u.answer_level === "none" || !quoteInText(u.quote, text)) return 0;
  if (scoped?.entry.permanent && u.answer_level === "explicit") return 100;
  return LEVEL_SCORE[u.answer_level] * (u.load_bearing ? 1 : 0.5);
}

export function scoreAxisC(out: AxisCOutput, scope: ScopedUnknown[], text: string): number {
  const byKey = new Map(scope.map((s) => [s.key, s]));
  return Math.max(0, ...out.unknowns.filter((u) => byKey.has(u.rule)).map((u) => scoreUnknown(u, byKey.get(u.rule), text)));
}

export function renderUnknowns(scope: ScopedUnknown[]): string {
  if (!scope.length) return "（无）";
  return scope.map((s) => `- [${s.key}]（${s.owner}）${s.entry.text}${s.entry.permanent ? "〔永久留白〕" : ""}`).join("\n");
}

export async function checkAxisC(ctx: LlmContext, input: { text: string; scope: ScopedUnknown[]; n: number }): Promise<CheckResult> {
  const { text, scope } = input;
  if (!scope.length) {
    return { axis: "C", score: 0, confidence: 1, samples: { n: 0, scores: [], failed: 0 }, prediction: "", observed: "", evidence: [], notes: ["没有留白，跳过"], details: null };
  }
  const res = await sampleStructured(
    ctx,
    {
      task: "axis-c",
      template: template("axis-c"),
      schema: AxisCOutput,
      summary: `轴C：留白${scope.length}条（${[...new Set(scope.map((s) => s.owner))].join(",")}） 文本${text.length}字`,
      vars: { principles: principles(), unknowns: renderUnknowns(scope), text },
    },
    input.n,
    (v) => scoreAxisC(v, scope, text),
  );

  const out = res.representative.value;
  const byKey = new Map(scope.map((s) => [s.key, s]));
  const filled = out.unknowns.filter((u) => u.answer_level !== "none");
  const evidence: Evidence[] = filled.map((u) => ({
    quote: u.quote ?? "",
    rule: u.rule,
    rule_text: byKey.get(u.rule)?.entry.text,
    direction: "opposite" as const,
    expected: "这条留白应保持未答",
    note: `${u.answer_level === "explicit" ? "明示" : "强暗示"}${u.load_bearing ? "，承重" : "，不承重（可删）"}：${u.reason}`,
    weight: scoreUnknown(u, byKey.get(u.rule), text),
    verified: quoteInText(u.quote, text),
  }));
  const notes: string[] = [];
  const missing = scope.filter((s) => !out.unknowns.some((u) => u.rule === s.key));
  if (missing.length) notes.push(`模型漏判了 ${missing.length} 条留白：${missing.map((m) => m.key).join("、")}`);
  const unverified = evidence.filter((e) => !e.verified).length;
  if (unverified) notes.push(`${unverified} 条引文在原文里找不到，已排除出打分`);
  if (res.failed.length) notes.push(`${res.failed.length} 个样本输出无效，已丢弃`);

  return {
    axis: "C",
    score: res.median,
    confidence: +res.confidence.toFixed(2),
    samples: { n: input.n, scores: res.scores, failed: res.failed.length },
    prediction: "所有留白保持未答",
    observed: filled.map((u) => `[${u.rule}] ${u.quote}`).join("\n"),
    evidence,
    suggestion: toFix(out.cheapest_fix, text),
    notes,
    details: out,
  };
}

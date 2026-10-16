// Axis T · 转变合理性 (D-060): does "start state → end state" hold up under the characters' own
// rules, before any prose exists? Reads the two states, the edge summary, profiles, world rules.
import { type Entry, type Profile, type Snapshot, type StateAt, anchorEntries, renderState } from "@sw/core";
import { type LlmContext, sampleStructured } from "@sw/llm";
import { z } from "zod";
import { type ScopedUnknown, renderUnknowns } from "./axis-c";
import { type CheckResult, type Evidence, principles, quoteInText, saturate, template } from "./common";

export const AxisTOutput = z.object({
  changes: z
    .array(
      z.object({
        id: z.string(),
        character: z.string().nullable().optional(),
        field: z.string(),
        from: z.string().nullable().optional(),
        to: z.string().nullable().optional(),
        verdict: z.enum(["plausible", "stretch", "implausible"]),
        rule: z.string().nullable().optional(),
        reason: z.string().default(""),
        needs: z.string().nullable().optional(),
      }),
    )
    .default([]),
  boundary_hits: z.array(z.object({ rule: z.string(), quote: z.string(), reason: z.string().default("") })).default([]),
  unknown_hits: z
    .array(z.object({ rule: z.string(), quote: z.string(), level: z.enum(["explicit", "strong_hint"]), reason: z.string().default("") }))
    .default([]),
  cheapest_fix: z.object({ where: z.string(), change: z.string() }).nullable().optional(),
});
export type AxisTOutput = z.infer<typeof AxisTOutput>;

export const VERDICT_WEIGHT = { plausible: 0, stretch: 1, implausible: 3 } as const;

/**
 * Score from structure (D-060): stretch 1 / implausible 3, saturated; a boundary hit ⇒ ≥80;
 * a filled unknown counts as on axis C, load-bearing (explicit 100, hint 50).
 * Quotes must be found in the states or the summary.
 */
export function scoreAxisT(out: AxisTOutput, source: string, scope: ScopedUnknown[]): number {
  let score = saturate(out.changes.reduce((s, c) => s + VERDICT_WEIGHT[c.verdict], 0));
  if (out.boundary_hits.some((h) => quoteInText(h.quote, source))) score = Math.max(score, 80);
  const byKey = new Map(scope.map((s) => [s.key, s]));
  for (const u of out.unknown_hits) {
    const s = byKey.get(u.rule);
    if (!s || !quoteInText(u.quote, source)) continue;
    // an end state is the author's plan, so a filled unknown there is load-bearing by definition
    score = Math.max(score, u.level === "explicit" ? 100 : 50);
  }
  return score;
}

const ns = (owner: string, entries: readonly Entry[]) => entries.map((e) => ({ ...e, id: `${owner}.${e.id}` }));
const list = (entries: readonly Entry[]) => (entries.length ? entries.map((e) => `- [${e.id}] ${e.text}${e.secret ? "〔人物本人不知道〕" : ""}`).join("\n") : "（无）");

export function renderCast(profiles: Profile[], states: StateAt[]): string {
  return (
    profiles
      .map((pr, i) => {
        const st = states[i];
        return [
          `### ${pr.name}（${pr.id}）`,
          `角色核心：${pr.core ?? "（未写）"}`,
          `决策规则：\n${anchorEntries(pr.heuristics).length ? list(ns(pr.id, anchorEntries(pr.heuristics))) : "（档案没有决策规则，只能对照人格判断）"}`,
          `核心人格：\n${list(ns(pr.id, anchorEntries(pr.traits)))}`,
          `硬边界：\n${list(ns(pr.id, anchorEntries(pr.boundaries)))}`,
          `已定事实：\n${list(ns(pr.id, anchorEntries(pr.hard_facts)))}`,
          st?.turns.length ? `已被作者接受的转折：\n${st.turns.map((a) => `- ${a.delta}`).join("\n")}` : "",
          st?.deltas.length ? `之前已接受的变化：\n${renderState(st).split("\n").filter((l) => l.startsWith("（已接受")).join("\n")}` : "",
        ]
          .filter(Boolean)
          .join("\n");
      })
      .join("\n\n") || "（无）"
  );
}

export interface AxisTInput {
  from: Snapshot;
  to: Snapshot;
  /** rendered states (renderSnapshot), the text quotes are checked against */
  fromText: string;
  toText: string;
  summary: string;
  profiles: Profile[];
  states: StateAt[];
  world: Entry[];
  scope: ScopedUnknown[];
  n: number;
}

export async function checkAxisT(ctx: LlmContext, input: AxisTInput): Promise<CheckResult> {
  const source = `${input.fromText}\n${input.toText}\n${input.summary}`;
  const res = await sampleStructured(
    ctx,
    {
      task: `axis-t:${input.from.id}->${input.to.id}`,
      template: template("axis-t"),
      schema: AxisTOutput,
      summary: `轴T：${input.from.id} → ${input.to.id} · 人物 ${input.profiles.map((p) => p.id).join(",")} · 世界规则${input.world.length} · 概述${input.summary ? "有" : "无"}`,
      vars: {
        principles: principles(),
        from: input.fromText,
        to: input.toText,
        summary: input.summary || "（作者还没写。只根据两端状态和人物规则判断。）",
        world: input.world.length ? input.world.map((w) => `- [world.${w.id}] ${w.text}`).join("\n") : "（无）",
        characters: renderCast(input.profiles, input.states),
        unknowns: renderUnknowns(input.scope),
      },
    },
    input.n,
    (v) => scoreAxisT(v, source, input.scope),
  );

  const out = res.representative.value;
  const byKey = new Map(input.scope.map((s) => [s.key, s]));
  const evidence: Evidence[] = [
    ...out.boundary_hits.map((h) => ({
      quote: h.quote,
      rule: h.rule,
      direction: "opposite" as const,
      expected: "硬边界不得触犯",
      note: h.reason,
      weight: 3,
      verified: quoteInText(h.quote, source),
    })),
    ...out.unknown_hits.map((u) => ({
      quote: u.quote,
      rule: u.rule,
      rule_text: byKey.get(u.rule)?.entry.text,
      direction: "opposite" as const,
      expected: "这条留白应保持未答",
      note: `${u.level === "explicit" ? "明示" : "强暗示"}：${u.reason}`,
      weight: 2,
      verified: quoteInText(u.quote, source),
    })),
    ...out.changes
      .filter((c) => c.verdict !== "plausible")
      .map((c) => ({
        quote: c.to ?? c.from ?? "",
        rule: c.rule ?? undefined,
        direction: "opposite" as const,
        expected: c.needs ? `需要：${c.needs}` : undefined,
        note: `${c.verdict === "implausible" ? "说不通" : "牵强"}（${c.character ?? "世界"} · ${c.field}${c.from ? `：「${c.from}」→` : "："}「${c.to ?? ""}」）${c.reason}`,
        weight: VERDICT_WEIGHT[c.verdict],
        verified: quoteInText(c.to ?? c.from, source),
      })),
  ];
  const notes: string[] = [];
  if (!input.summary) notes.push("这条边还没有情节概述：只按两端状态判断，缺原因的变化会显得牵强");
  for (const pr of input.profiles) if (!anchorEntries(pr.heuristics).length) notes.push(`${pr.name} 没有决策规则：对 TA 的判断只依据人格，可信度较低`);
  const unverified = evidence.filter((e) => !e.verified).length;
  if (unverified) notes.push(`${unverified} 条引文在状态和概述里找不到，已排除出打分`);
  if (res.failed.length) notes.push(`${res.failed.length} 个样本输出无效，已丢弃`);
  const fix = out.cheapest_fix;

  return {
    axis: "T",
    score: res.median,
    confidence: +res.confidence.toFixed(2),
    samples: { n: input.n, scores: res.scores, failed: res.failed.length },
    prediction: out.changes.filter((c) => c.needs).map((c) => `[${c.id}] 需要：${c.needs}`).join("\n"),
    observed: out.changes.map((c) => `[${c.id}] ${c.character ?? "世界"}.${c.field}：${c.from ?? "—"} → ${c.to ?? "—"}（${c.verdict}）`).join("\n"),
    evidence,
    suggestion: fix ? { quote: fix.where, rewrite: fix.change, verified: true } : undefined,
    notes,
    details: out,
  };
}

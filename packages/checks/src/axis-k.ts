// Axis K · 约束冲突 (D-064): the constraint set checked against itself, whenever it changes.
import { type Entry, type Project, normalizeEntries, worldRules } from "@sw/core";
import { type LlmContext, sampleStructured } from "@sw/llm";
import { z } from "zod";
import { type CheckResult, type Evidence, principles, saturate, template } from "./common";

export const AxisKOutput = z.object({
  issues: z
    .array(
      z.object({
        kind: z.enum(["contradiction", "tension", "fills_unknown", "duplicate"]),
        a: z.string(),
        b: z.string(),
        reason: z.string().default(""),
        suggestion: z.string().nullable().optional(),
      }),
    )
    .default([]),
});
export type AxisKOutput = z.infer<typeof AxisKOutput>;

export const KIND_WEIGHT = { contradiction: 3, fills_unknown: 2, tension: 1, duplicate: 0 } as const;
const KIND_LABEL = { contradiction: "矛盾", fills_unknown: "约束填了留白", tension: "张力", duplicate: "重复" } as const;
const FIELD_LABEL: Record<string, string> = {
  traits: "人格",
  heuristics: "决策规则",
  boundaries: "硬边界",
  hard_facts: "已定事实",
  unknowns: "留白",
  world_rules: "世界规则",
};

export interface Constraint {
  /** "<owner>.<entry id>": "tina.h1", "world.w2", "project.u1" */
  key: string;
  owner: string;
  ownerName: string;
  field: string;
  entry: Entry;
}

/** Every constraint the author has set, with ids unique across owners. Model-inferred entries are left out. */
export function allConstraints(p: Project): Constraint[] {
  const out: Constraint[] = [];
  for (const { value: pr } of p.profiles) {
    for (const field of ["traits", "heuristics", "boundaries", "hard_facts", "unknowns"] as const) {
      for (const e of pr[field]) if (e.origin !== "llm") out.push({ key: `${pr.id}.${e.id}`, owner: pr.id, ownerName: pr.name, field, entry: e });
    }
  }
  for (const e of worldRules(p.config.world_rules)) out.push({ key: `world.${e.id}`, owner: "world", ownerName: "世界", field: "world_rules", entry: e });
  for (const e of normalizeEntries("unknowns", p.config.unknowns)) out.push({ key: `project.${e.id}`, owner: "project", ownerName: "项目", field: "unknowns", entry: e });
  return out;
}

export function renderConstraints(cs: Constraint[]): string {
  const groups = new Map<string, Constraint[]>();
  for (const c of cs) groups.set(c.owner, [...(groups.get(c.owner) ?? []), c]);
  return [...groups.values()]
    .map((g) => `### ${g[0]!.ownerName}（${g[0]!.owner}）\n${g.map((c) => `- [${c.key}]（${FIELD_LABEL[c.field] ?? c.field}）${c.entry.text}${c.entry.secret ? "〔人物本人不知道〕" : ""}`).join("\n")}`)
    .join("\n\n");
}

/** Only issues naming two real constraints count; the model can't invent ids into the score. */
export function scoreAxisK(out: AxisKOutput, keys: Set<string>): number {
  return saturate(out.issues.filter((i) => keys.has(i.a) && keys.has(i.b)).reduce((s, i) => s + KIND_WEIGHT[i.kind], 0));
}

export async function checkAxisK(ctx: LlmContext, input: { constraints: Constraint[]; changed: string[]; n: number }): Promise<CheckResult> {
  const { constraints } = input;
  const keys = new Set(constraints.map((c) => c.key));
  const byKey = new Map(constraints.map((c) => [c.key, c]));
  if (constraints.length < 2) {
    return { axis: "K", score: 0, confidence: 1, samples: { n: 0, scores: [], failed: 0 }, prediction: "", observed: "", evidence: [], notes: ["约束不到两条，无需检查"], details: { issues: [] } };
  }
  const changed = input.changed.filter((k) => keys.has(k));
  const res = await sampleStructured(
    ctx,
    {
      task: "axis-k",
      template: template("axis-k"),
      schema: AxisKOutput,
      summary: `轴K：约束 ${constraints.length} 条，刚改 ${changed.join(",") || "—"}`,
      vars: {
        principles: principles(),
        constraints: renderConstraints(constraints),
        changed: changed.length ? changed.map((k) => `- [${k}] ${byKey.get(k)!.entry.text}`).join("\n") : "（没有指定，全部一起看）",
      },
    },
    input.n,
    (v) => scoreAxisK(v, keys),
  );
  const out = res.representative.value;
  const evidence: Evidence[] = out.issues.map((i) => ({
    quote: byKey.get(i.a)?.entry.text ?? i.a,
    rule: `${i.a} ↔ ${i.b}`,
    rule_text: byKey.get(i.b)?.entry.text,
    direction: i.kind === "duplicate" ? ("irrelevant" as const) : ("opposite" as const),
    expected: i.suggestion ?? undefined,
    note: `${KIND_LABEL[i.kind]}：${i.reason}`,
    weight: KIND_WEIGHT[i.kind],
    verified: keys.has(i.a) && keys.has(i.b),
  }));
  const notes: string[] = [];
  const bad = evidence.filter((e) => !e.verified).length;
  if (bad) notes.push(`${bad} 条问题引用了不存在的约束 id，已排除出打分`);
  if (res.failed.length) notes.push(`${res.failed.length} 个样本输出无效，已丢弃`);
  return {
    axis: "K",
    score: res.median,
    confidence: +res.confidence.toFixed(2),
    samples: { n: input.n, scores: res.scores, failed: res.failed.length },
    prediction: "约束之间应当一致",
    observed: out.issues.map((i) => `${KIND_LABEL[i.kind]} ${i.a} ↔ ${i.b}`).join("\n"),
    evidence,
    notes,
    details: out,
  };
}

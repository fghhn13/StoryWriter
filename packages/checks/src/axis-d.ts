// Axis D · 到达偏差 (spec §5-D). Compares the derived snapshot (extracted from the bridge text
// without seeing the target, see @sw/ops extract) with the target snapshot, item by item.
import type { Snapshot } from "@sw/core";
import { type LlmContext, sampleStructured } from "@sw/llm";
import { z } from "zod";
import { type CheckResult, type Evidence, principles, saturate, template } from "./common";
import { type StateItem, type StateLike, renderItems, stateItems } from "./state-items";

export const AxisDOutput = z.object({
  items: z
    .array(
      z.object({
        key: z.string(),
        status: z.enum(["matched", "missing", "conflict"]),
        derived: z.array(z.string()).default([]),
        reason: z.string().default(""),
      }),
    )
    .default([]),
  cheapest_fix: z
    .object({ where: z.enum(["bridge", "target"]), what: z.string() })
    .nullable()
    .optional(),
});
export type AxisDOutput = z.infer<typeof AxisDOutput>;

// conflict > missing > extra (spec §5-D.3). Extras go to the harvest list and barely count (D-036).
export const D_WEIGHT = { conflict: 3, missing: 2, extra: 0.2 } as const;
export const D_EXTRA_CAP = 1;
export const DERIVED_PREFIX = "d:";

export interface DiffRow {
  key: string;
  target?: StateItem;
  derived: StateItem[];
  status: "matched" | "missing" | "conflict" | "extra" | "unjudged";
  reason: string;
}

/** Turn one sample into a full diff table: every target item once, then unmatched derived items. */
export function diffRows(out: AxisDOutput, target: StateItem[], derived: StateItem[]): DiffRow[] {
  const byKey = new Map(derived.map((d) => [d.key, d]));
  const judged = new Map(out.items.map((i) => [i.key, i]));
  const used = new Set<string>();
  const rows: DiffRow[] = target.map((t) => {
    const j = judged.get(t.key);
    if (!j) return { key: t.key, target: t, derived: [], status: "unjudged", reason: "模型漏判" };
    const ds = j.derived.flatMap((k) => byKey.get(k) ?? []);
    if (j.status !== "missing") ds.forEach((d) => used.add(d.key));
    return { key: t.key, target: t, derived: j.status === "missing" ? [] : ds, status: j.status, reason: j.reason };
  });
  for (const d of derived) if (!used.has(d.key)) rows.push({ key: d.key, derived: [d], status: "extra", reason: "目标快照里没有" });
  return rows;
}

export function scoreAxisD(out: AxisDOutput, target: StateItem[], derived: StateItem[]): number {
  const rows = diffRows(out, target, derived);
  const n = (s: DiffRow["status"]) => rows.filter((r) => r.status === s).length;
  const w = n("conflict") * D_WEIGHT.conflict + n("missing") * D_WEIGHT.missing + Math.min(D_EXTRA_CAP, n("extra") * D_WEIGHT.extra);
  return saturate(w);
}

export interface AxisDInput {
  target: Snapshot;
  derived: StateLike;
  n: number;
}

export async function checkAxisD(ctx: LlmContext, input: AxisDInput): Promise<CheckResult> {
  const target = stateItems(input.target);
  const derived = stateItems(input.derived, DERIVED_PREFIX);
  const res = await sampleStructured(
    ctx,
    {
      task: "axis-d",
      template: template("axis-d"),
      schema: AxisDOutput,
      summary: `轴D：目标 ${input.target.id} ${target.length} 项 · 到达 ${derived.length} 项`,
      vars: { principles: principles(), target: renderItems(target), derived: renderItems(derived) },
    },
    input.n,
    (v) => scoreAxisD(v, target, derived),
  );

  const out = res.representative.value;
  const rows = diffRows(out, target, derived);
  const STATUS = { conflict: "冲突", missing: "缺失", extra: "多出" } as const;
  const evidence: Evidence[] = rows
    .filter((r): r is DiffRow & { status: keyof typeof STATUS } => r.status in STATUS)
    .map((r) => ({
      quote: r.derived.map((d) => d.text).join("；") || "（到达状态里没有）",
      rule: r.target?.key ?? r.key,
      rule_text: r.target?.text,
      direction: r.status === "extra" ? ("irrelevant" as const) : ("opposite" as const),
      expected: r.target ? `目标：${r.target.text}` : undefined,
      note: `${STATUS[r.status]}${r.reason ? `：${r.reason}` : ""}`,
      weight: D_WEIGHT[r.status],
      verified: true,
    }));
  const notes: string[] = [];
  const unjudged = rows.filter((r) => r.status === "unjudged");
  if (unjudged.length) notes.push(`模型漏判了 ${unjudged.length} 个目标字段：${unjudged.map((r) => r.key).join("、")}（不计分）`);
  const extras = rows.filter((r) => r.status === "extra").length;
  if (extras) notes.push(`到达状态多出 ${extras} 项，已列入收获清单`);
  if (res.failed.length) notes.push(`${res.failed.length} 个样本输出无效，已丢弃`);
  const fix = out.cheapest_fix;

  return {
    axis: "D",
    score: res.median,
    confidence: +res.confidence.toFixed(2),
    samples: { n: input.n, scores: res.scores, failed: res.failed.length },
    prediction: target.map((t) => `[${t.key}] ${t.text}`).join("\n"),
    observed: derived.map((d) => `[${d.key}] ${d.text}`).join("\n"),
    evidence,
    suggestion: fix ? { quote: fix.where === "bridge" ? "（桥正文）" : `（目标快照 ${input.target.id}）`, rewrite: fix.what, verified: true } : undefined,
    notes,
    details: { rows, output: out },
  };
}

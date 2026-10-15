// Multi-sampling (spec §3.3): >=3 samples, median score, confidence from sample spread.
import type { z } from "zod";
import { type LlmContext, type StructuredCall, callStructured } from "./structured";

export interface Sampled<T> {
  /** samples that produced valid output, in sample order */
  samples: { index: number; value: T; score: number }[];
  failed: { index: number; error: string }[];
  scores: number[];
  median: number;
  stdev: number;
  /** 0–1 from spread only; callers combine it with profile completeness */
  confidence: number;
  /** the sample whose score is closest to the median; its evidence is what the report shows */
  representative: { index: number; value: T; score: number };
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const mu = xs.reduce((a, b) => a + b, 0) / xs.length;
  return Math.sqrt(xs.reduce((a, b) => a + (b - mu) ** 2, 0) / (xs.length - 1));
}

/** stdev 0 → 1.0, stdev 20 points → 0 (D-021). A single sample can't show spread: capped at 0.5. */
export function spreadConfidence(scores: number[]): number {
  if (scores.length < 2) return 0.5;
  return Math.max(0, 1 - stdev(scores) / 20);
}

export async function sampleStructured<S extends z.ZodType>(
  ctx: LlmContext,
  call: Omit<StructuredCall<S>, "sample">,
  n: number,
  score: (v: z.infer<S>) => number,
  concurrency = 3,
): Promise<Sampled<z.infer<S>>> {
  const results: ({ ok: true; value: z.infer<S> } | { ok: false; error: string })[] = new Array(n);
  let next = 0;
  async function worker() {
    while (next < n) {
      const i = next++;
      try {
        results[i] = { ok: true, value: await callStructured(ctx, { ...call, sample: i }) };
      } catch (e) {
        results[i] = { ok: false, error: (e as Error).message };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, n) }, worker));

  const samples = results.flatMap((r, index) => (r.ok ? [{ index, value: r.value, score: score(r.value) }] : []));
  const failed = results.flatMap((r, index) => (r.ok ? [] : [{ index, error: r.error }]));
  if (!samples.length) throw new Error(`${call.task}：${n} 个样本全部失败：${failed[0]?.error}`);
  const scores = samples.map((s) => s.score);
  const med = median(scores);
  const representative = samples.reduce((best, s) => (Math.abs(s.score - med) < Math.abs(best.score - med) ? s : best));
  return { samples, failed, scores, median: med, stdev: stdev(scores), confidence: spreadConfidence(scores), representative };
}

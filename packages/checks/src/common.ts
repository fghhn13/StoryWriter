// Shared pieces for every axis: result shape, quote verification, score helpers (spec §5 共同输出格式).
import path from "node:path";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { type Axis, type Entry, type ProjectConfig, readText } from "@sw/core";
import { type Template, loadTemplate } from "@sw/llm";
import { z } from "zod";

const PROMPTS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prompts");

export function template(id: string): Template {
  return loadTemplate(path.join(PROMPTS, `${id}.md`));
}
export function principles(): string {
  return readText(path.join(PROMPTS, "principles.md")).trim();
}

export interface Evidence {
  quote: string;
  /** rule id as it appears in the profile, namespaced for multi-character axes (e.g. "ancore.u1") */
  rule?: string;
  rule_text?: string;
  direction?: "same" | "opposite" | "irrelevant";
  /** what the rule predicted / what the state said (本来应该怎样) */
  expected?: string;
  note?: string;
  weight?: number;
  /** false when the quote is not found verbatim in the text; such evidence never scores */
  verified: boolean;
}

export interface Fix {
  quote: string;
  /** empty: delete the quoted sentence */
  rewrite: string;
  resolves?: string[];
  verified: boolean;
}

export interface CheckResult {
  axis: Axis;
  /** profile id for per-character axes */
  character?: string;
  score: number;
  confidence: number;
  samples: { n: number; scores: number[]; failed: number };
  prediction: string;
  observed: string;
  evidence: Evidence[];
  suggestion?: Fix;
  /** caveats the author must see, e.g. "此人物无决策规则" */
  notes: string[];
  /** the representative sample's full structured output */
  details: unknown;
}

// rewrite may be missing or empty: the cheapest fix is often "delete this sentence"
export const FixSchema = z
  .object({ quote: z.string(), rewrite: z.string().nullable().optional(), resolves: z.array(z.string()).optional() })
  .nullable()
  .optional();

// ---------- quotes ----------

const norm = (s: string) =>
  s
    .replace(/\s+/g, "")
    .replace(/[“”「」『』"]/g, "\"")
    .replace(/[‘’']/g, "'")
    .replace(/[，,]/g, ",")
    .replace(/[……]+|\.{3,}/g, "…");

/** Is `quote` a verbatim slice of `text`, ignoring whitespace and quote-mark style? */
export function quoteInText(quote: string | null | undefined, text: string): boolean {
  if (!quote) return false;
  const q = norm(quote);
  return q.length > 0 && norm(text).includes(q);
}

export function toFix(f: z.infer<typeof FixSchema>, text: string): Fix | undefined {
  return f ? { ...f, rewrite: f.rewrite ?? "", verified: quoteInText(f.quote, text) } : undefined;
}

// ---------- scores ----------

/**
 * Saturating map from accumulated weight to 0–100 (D-020): one clear deviation (weight 2) ≈ 49,
 * two ≈ 74, a severe one (3) ≈ 63. Conforming behaviour elsewhere does not dilute a deviation.
 */
export function saturate(weight: number, scale = 3): number {
  return Math.round(100 * (1 - Math.exp(-weight / scale)));
}

export type Level = "high" | "warn" | "ok";
export function levelOf(axis: Axis, score: number, cfg: ProjectConfig): Level {
  const t = cfg.thresholds[axis];
  return score >= t.high ? "high" : score >= t.warn ? "warn" : "ok";
}

// ---------- rendering profile parts into prompts ----------

export function listEntries(entries: readonly Entry[], prefix = ""): string {
  if (!entries.length) return "（无）";
  return entries.map((e) => `- [${prefix}${e.id}] ${e.text}${e.tag && e.tag !== "留白" ? `〔${e.tag}〕` : ""}${e.secret ? "〔人物本人不知道〕" : ""}`).join("\n");
}

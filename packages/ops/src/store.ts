// Persisting check results as checks/<target>/<axis>[-<character>].yaml (spec §4.5, §9).
// Deferred from M1 (D-028); a re-run overwrites the previous result for the same target/axis/character.
import path from "node:path";
import { type Bridge, type Check, DIRS, type Located, type Project, renderYamlFile, toPosix, writeProjectFile } from "@sw/core";
import type { CheckResult } from "@sw/checks";

export function findBridge(p: Project, id: string): Located<Bridge> {
  const b = p.bridges.find((x) => x.value.id === id);
  if (!b) throw new Error(`找不到桥：${id}`);
  return b;
}

export function checkId(target: string, r: Pick<CheckResult, "axis" | "character">): string {
  return `${target}.${r.axis}${r.character ? `.${r.character}` : ""}`;
}

export function suggestionText(r: CheckResult): string {
  const f = r.suggestion;
  if (!f) return "";
  if (r.axis === "D") return `改${f.quote}：${f.rewrite}`;
  return f.rewrite ? `把「${f.quote}」改成「${f.rewrite}」` : `删掉「${f.quote}」`;
}

export function toCheckDoc(target: string, r: CheckResult, inputs: Record<string, string>): Check & Record<string, unknown> {
  return {
    id: checkId(target, r),
    target,
    target_kind: "bridge",
    axis: r.axis,
    ...(r.character ? { character: r.character } : {}),
    score: r.score,
    confidence: r.confidence,
    prediction: r.prediction,
    observed: r.observed,
    evidence: r.evidence.map((e) => ({
      quote: e.quote,
      ...(e.rule ? { rule: e.rule } : {}),
      ...(e.rule_text ? { rule_text: e.rule_text } : {}),
      ...(e.direction ? { direction: e.direction } : {}),
      ...(e.expected ? { expected: e.expected } : {}),
      ...(e.note ? { note: e.note } : {}),
      ...(e.weight !== undefined ? { weight: e.weight } : {}),
      verified: e.verified,
    })),
    suggestion: suggestionText(r),
    samples: { n: r.samples.n, scores: r.samples.scores, failed: r.samples.failed },
    status: "open",
    notes: r.notes,
    // content hashes of what the check read; M3 compares them to mark checks stale (spec §6-U8)
    inputs,
    at: new Date().toISOString(),
  };
}

export function saveCheck(p: Project, target: string, r: CheckResult, inputs: Record<string, string>): { id: string; file: string } {
  const doc = toCheckDoc(target, r, inputs);
  const rel = toPosix(path.join(DIRS.checks, target, `${r.axis}${r.character ? `-${r.character}` : ""}.yaml`));
  writeProjectFile(p.root, rel, renderYamlFile(doc), { overwrite: true });
  return { id: doc.id, file: rel };
}

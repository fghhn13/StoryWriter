// Persisting check results as checks/<target>/<axis>[-<character>].yaml (spec §4.5, §9).
// A re-run overwrites the result for the same target/axis/character but keeps its history (D-038, D-047).
import fs from "node:fs";
import path from "node:path";
import { type Bridge, type Check, DIRS, type Located, type Project, parseYamlFile, readText, renderYamlFile, toPosix, writeProjectFile } from "@sw/core";
import { type CheckResult, type DiffRow, FIELD_LABEL } from "@sw/checks";

export function findBridge(p: Project, id: string): Located<Bridge> {
  const b = p.bridges.find((x) => x.value.id === id);
  if (!b) throw new Error(`找不到桥：${id}`);
  return b;
}

export function findCheck(p: Project, id: string): Located<Check> {
  const c = p.checks.find((x) => x.value.id === id);
  if (!c) throw new Error(`找不到检查：${id}`);
  return c;
}

export function checkId(target: string, r: Pick<CheckResult, "axis" | "character">): string {
  return `${target}.${r.axis}${r.character ? `.${r.character}` : ""}`;
}

export function checkFile(target: string, r: Pick<CheckResult, "axis" | "character">): string {
  return toPosix(path.join(DIRS.checks, target, `${r.axis}${r.character ? `-${r.character}` : ""}.yaml`));
}

export function suggestionText(r: CheckResult): string {
  const f = r.suggestion;
  if (!f) return "";
  if (r.axis === "D") return `改${f.quote}：${f.rewrite}`;
  return f.rewrite ? `把「${f.quote}」改成「${f.rewrite}」` : `删掉「${f.quote}」`;
}

export interface HarvestItem {
  item: string;
  /** axis B: a premise the state never mentioned; axis D: an arrival item the target didn't have */
  kind: "unmentioned" | "extra";
  quote?: string;
}

/** Spec §6-U9 收获清单 sources: axis B's unmentioned premises and axis D's extras. */
export function harvestOf(r: CheckResult): HarvestItem[] {
  if (r.axis === "B") {
    const um = (r.details as { unmentioned?: { premise: string; quote?: string }[] } | null)?.unmentioned ?? [];
    return um.map((u) => ({ item: u.premise, kind: "unmentioned" as const, ...(u.quote ? { quote: u.quote } : {}) }));
  }
  if (r.axis === "D") {
    const rows = (r.details as { rows?: DiffRow[] } | null)?.rows ?? [];
    return rows
      .filter((x) => x.status === "extra")
      .flatMap((x) => x.derived.map((d) => ({ item: `${d.character ? `${d.character} · ` : ""}${FIELD_LABEL[d.field]}：${d.text}`, kind: "extra" as const })));
  }
  return [];
}

export interface HistoryEntry {
  at: string;
  action: string;
  note?: string;
  score?: number;
}

export function toCheckDoc(
  target: string,
  targetKind: Check["target_kind"],
  r: CheckResult,
  inputs: Record<string, string>,
  history: HistoryEntry[],
): Check & Record<string, unknown> {
  const at = new Date().toISOString();
  const harvest = harvestOf(r);
  return {
    id: checkId(target, r),
    target,
    target_kind: targetKind,
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
    ...(harvest.length ? { harvest } : {}),
    ...(r.axis === "E" ? { thread: r.details } : {}),
    // content hashes of what the check read; a mismatch marks it stale (D-046)
    inputs,
    at,
    history: [...history, { at, action: history.length ? "rerun" : "run", score: r.score }],
  };
}

export function saveCheck(
  p: Project,
  target: string,
  r: CheckResult,
  inputs: Record<string, string>,
  targetKind: Check["target_kind"] = "bridge",
): { id: string; file: string } {
  const rel = checkFile(target, r);
  const abs = path.join(p.root, rel);
  let history: HistoryEntry[] = [];
  if (fs.existsSync(abs)) {
    const prev = parseYamlFile(readText(abs)).data as { history?: HistoryEntry[] } | undefined;
    history = Array.isArray(prev?.history) ? prev.history : [];
  }
  const doc = toCheckDoc(target, targetKind, r, inputs, history);
  writeProjectFile(p.root, rel, renderYamlFile(doc), { overwrite: true });
  return { id: doc.id, file: rel };
}

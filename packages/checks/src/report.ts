// Markdown report. Every finding answers 哪里 / 依据哪条规则 / 本来应该怎样 / 改哪句最便宜 (spec §5).
import type { Project } from "@sw/core";
import type { DiffRow } from "./axis-d";
import { type CheckResult, levelOf } from "./common";
import type { RunResult } from "./run";

export const AXIS_NAME = { A: "人物偏差", B: "连续性偏差", C: "留白侵入", D: "到达偏差", E: "伏笔偏差", F: "间距" } as const;
const LEVEL_MARK = { high: "🔴 高亮", warn: "🟡 提醒", ok: "🟢" } as const;

const cell = (s?: string) => (s ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");

function section(p: Project, r: CheckResult): string {
  const who = r.character ? ` · ${p.profiles.find((x) => x.value.id === r.character)?.value.name ?? r.character}` : "";
  const lines = [
    `## 轴 ${r.axis} · ${AXIS_NAME[r.axis]}${who}`,
    "",
    `**偏差 ${r.score}** ${LEVEL_MARK[levelOf(r.axis, r.score, p.config)]} · 置信度 ${r.confidence} · 样本 ${r.samples.scores.join(" / ") || "—"}`,
  ];
  for (const n of r.notes) lines.push(`> ⚠ ${n}`);
  if (r.axis === "D") {
    lines.push("", diffTable(r));
    if (r.suggestion) lines.push("", fixLine(r));
    return lines.join("\n");
  }
  const findings = r.evidence.filter((e) => e.direction === "opposite").sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  if (findings.length) {
    lines.push("", "| 哪里 | 依据 | 本来应该 | 说明 |", "|---|---|---|---|");
    for (const e of findings) {
      const rule = e.rule ? `${e.rule}${e.rule_text ? `：${e.rule_text}` : ""}` : "—";
      lines.push(`| ${e.verified ? "" : "（引文未核实）"}「${cell(e.quote)}」 | ${cell(rule)} | ${cell(e.expected)} | ${cell(e.note)} |`);
    }
  } else {
    lines.push("", "没有发现偏差。");
  }
  if (r.suggestion) lines.push("", fixLine(r));
  if (r.axis === "B") {
    const um = (r.details as { unmentioned?: { premise: string }[] } | null)?.unmentioned ?? [];
    if (um.length) lines.push("", `<details><summary>状态里没提到的前提（${um.length}，供收获清单）</summary>\n\n${um.map((u) => `- ${u.premise}`).join("\n")}\n\n</details>`);
  }
  return lines.join("\n");
}

function fixLine(r: CheckResult): string {
  const f = r.suggestion!;
  if (r.axis === "D") return `**最便宜的修补**：改${f.quote}——${f.rewrite}`;
  const how = f.rewrite ? `改成「${f.rewrite}」` : "删掉";
  return `**最便宜的修补**${f.verified ? "" : "（原句未核实）"}：把「${f.quote}」${how}`;
}

/** Axis D: every target field, then what the bridge added (spec §5-D 逐字段 diff 表). */
function diffTable(r: CheckResult): string {
  const rows = (r.details as { rows?: DiffRow[] } | null)?.rows ?? [];
  const MARK = { matched: "✓ 对上", missing: "缺失", conflict: "✗ 冲突", extra: "多出（收获）", unjudged: "漏判" } as const;
  const order = { conflict: 0, missing: 1, unjudged: 2, matched: 3, extra: 4 } as const;
  const sorted = [...rows].sort((a, b) => order[a.status] - order[b.status]);
  const out = ["| 字段 | 目标 | 到达 | 结果 |", "|---|---|---|---|"];
  for (const x of sorted) {
    const derived = x.derived.map((d) => d.text).join("；") || undefined;
    const why = x.reason && x.status !== "extra" ? `：${cell(x.reason)}` : "";
    out.push(`| ${x.target?.key ?? x.key} | ${cell(x.target?.text)} | ${cell(derived)} | ${MARK[x.status]}${why} |`);
  }
  return out.join("\n");
}

export interface ReportMeta {
  source?: string;
  calls?: string;
  /** extra header lines, e.g. the bridge and its target */
  extra?: string[];
}

export function renderReport(p: Project, run: RunResult, meta: ReportMeta = {}): string {
  const head = [
    `# 校验报告`,
    "",
    `- 文本：${meta.source ?? "（未命名）"}`,
    `- 起点快照：${run.from.id}「${run.from.title}」（t=${run.from.t}）`,
    ...(meta.extra ?? []).map((l) => `- ${l}`),
    `- 人物：${run.characters.join("、")}`,
    meta.calls ? `- 调用：${meta.calls}` : "",
    "",
    "分数 0 = 完全符合，100 = 完全背离；只用于排序和着色，不是对错。",
  ].filter((l) => l !== "");
  const sorted = [...run.results].sort((a, b) => b.score - a.score);
  return [head.join("\n"), ...sorted.map((r) => section(p, r))].join("\n\n") + "\n";
}

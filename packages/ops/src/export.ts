// U9 导出与收获 (spec §6-U9): manuscript from locked bridges, a report of open checks, and the
// harvest list. Nothing is written back to profiles (D-048).
import type { Check, Project } from "@sw/core";
import { AXIS_NAME, levelOf } from "@sw/checks";
import type { HarvestItem } from "./store";

const cell = (s?: string) => (s ?? "—").replace(/\|/g, "\\|").replace(/\n/g, " ");

export function exportManuscript(p: Project): { text: string; included: string[]; skipped: string[] } {
  const at = new Map(p.snapshots.map((s) => [s.value.id, s.value]));
  const bridges = p.bridges.map((b) => b.value).sort((a, b) => (at.get(a.from)?.t ?? 0) - (at.get(b.from)?.t ?? 0));
  const locked = bridges.filter((b) => b.status === "locked" && b.text);
  const parts = [`# ${p.config.name}`];
  for (const b of locked) {
    const to = at.get(b.to);
    parts.push(`## ${to?.t_label ?? to?.title ?? b.id}`, b.text);
  }
  return {
    text: parts.join("\n\n") + "\n",
    included: locked.map((b) => b.id),
    skipped: bridges.filter((b) => !locked.includes(b)).map((b) => `${b.id}（${b.status}）`),
  };
}

const OPEN = ["open", "stale"] as const;

export function exportReport(p: Project): string {
  const checks = p.checks
    .map((c) => c.value)
    .filter((c) => (OPEN as readonly string[]).includes(c.status))
    .sort((a, b) => b.score - a.score);
  const MARK = { high: "🔴", warn: "🟡", ok: "🟢" } as const;
  const lines = [
    `# 未处理的检查（${p.config.name}）`,
    "",
    `共 ${checks.length} 条（含 ${checks.filter((c) => c.status === "stale").length} 条过期）。按分数排序；分数只用于排序，不是对错。`,
    "",
    "| | 检查 | 对象 | 轴 | 分数 | 状态 | 最重的一条 | 最便宜的修补 |",
    "|---|---|---|---|---|---|---|---|",
  ];
  for (const c of checks) {
    const top = [...c.evidence].filter((e) => e.direction === "opposite").sort((a, b) => ((b as { weight?: number }).weight ?? 0) - ((a as { weight?: number }).weight ?? 0))[0];
    const who = c.character ? ` · ${c.character}` : "";
    lines.push(
      `| ${MARK[levelOf(c.axis, c.score, p.config)]} | ${c.id} | ${c.target_kind} ${c.target} | ${c.axis} ${AXIS_NAME[c.axis]}${who} | ${c.score} | ${c.status === "stale" ? "过期" : "待处理"} | ${top ? `「${cell(top.quote)}」` : "—"} | ${cell(c.suggestion || undefined)} |`,
    );
  }
  return lines.join("\n") + "\n";
}

export function exportHarvest(p: Project): { text: string; count: number } {
  const groups = new Map<string, { check: Check; items: HarvestItem[] }[]>();
  for (const { value: c } of p.checks) {
    const items = (c as Record<string, unknown>).harvest as HarvestItem[] | undefined;
    if (!items?.length) continue;
    groups.set(c.target, [...(groups.get(c.target) ?? []), { check: c, items }]);
  }
  const KIND = { unmentioned: "状态里没提到的前提（轴 B）", extra: "到达状态多出的内容（轴 D）" } as const;
  const lines = [`# 收获清单（${p.config.name}）`, "", "桥里出现、但档案和快照里还没有的事实。工具不会自动写回，由你决定要不要收进档案或快照。"];
  let count = 0;
  for (const [target, list] of groups) {
    lines.push("", `## 桥 ${target}`);
    for (const kind of ["unmentioned", "extra"] as const) {
      const items = list.flatMap((g) => g.items.filter((i) => i.kind === kind).map((i) => ({ ...i, check: g.check.id })));
      if (!items.length) continue;
      lines.push("", `### ${KIND[kind]}`, "");
      for (const i of items) lines.push(`- ${i.item}${i.quote ? `（原文：「${i.quote}」）` : ""} ← ${i.check}`);
      count += items.length;
    }
  }
  if (!count) lines.push("", "（还没有。跑过轴 B / D 的检查之后才会有内容。）");
  return { text: lines.join("\n") + "\n", count };
}

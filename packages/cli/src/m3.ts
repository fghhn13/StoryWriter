// M3 commands: threads and axis E (U7), dispositions (U6), stale scan and rerun (U8), export (U9).
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { type Project, loadProject } from "@sw/core";
import { type LlmContext, createContext } from "@sw/llm";
import {
  acceptCheck,
  addThread,
  checkThread,
  dismissCheck,
  exportHarvest,
  exportManuscript,
  exportReport,
  findStale,
  markFixed,
  markStale,
  planRerun,
  rerunStale,
  revokeAcceptance,
  threadNodes,
} from "@sw/ops";

type Dir = (cmd: Command) => string;

interface LlmOpts {
  model?: string;
  recordings?: string;
}

function checkContext(p: Project, opts: LlmOpts): LlmContext {
  return createContext({
    projectRoot: p.root,
    model: opts.model ?? p.config.llm.check_model ?? p.config.llm.model,
    temperature: p.config.llm.temperature,
    recordings: opts.recordings ? path.resolve(opts.recordings) : undefined,
  });
}

const withLlm = (c: Command) =>
  c
    .option("--model <id>", "模型 id（默认 llm.check_model 或 llm.model）")
    .option("--recordings <dir>", "录制 / 回放目录（SW_LLM_MODE=record|replay 时用）");

const say = (m: string) => console.error(m);

function callsLine(ctx: LlmContext): string {
  const t = ctx.log.totals();
  return `${t.calls} 次真实调用${t.replayed ? `、${t.replayed} 次回放` : ""} · ${t.tokens} tokens · ${t.seconds.toFixed(0)} 秒`;
}

function printStale(list: ReturnType<typeof findStale>) {
  for (const s of list) console.log(`  ${s.check.value.id}  ← ${s.changed.join("、")}`);
}

async function runThreadCheck(p: Project, ctx: LlmContext, id: string, samples?: string) {
  const r = await checkThread(p, ctx, id, { n: samples ? Number(samples) : undefined, onProgress: say });
  const d = r.result.details as { nodes: { node: string; kind: string; t: number; score: number }[]; affected: string[]; unpaid: boolean };
  console.log(`轴 E · 线 ${id}：偏差 ${r.result.score} · 置信度 ${r.result.confidence} → ${r.saved.file}`);
  for (const n of d.nodes) console.log(`  t=${n.t}  ${n.kind === "snapshot" ? "快照" : "桥"} ${n.node}  ${n.score}${d.affected.includes(n.node) ? "  ⚠ 受影响" : ""}`);
  for (const e of r.result.evidence.filter((x) => x.verified)) console.log(`  「${e.quote}」——${e.note}`);
  if (d.unpaid) console.log("  （未收，不计入分数）");
  say(callsLine(ctx));
}

export function registerM3(program: Command, projectDir: Dir): void {
  const thread = program.command("thread").description("伏笔 / 线（U7）");

  withLlm(
    thread
      .command("add")
      .argument("<id>", "线 id")
      .requiredOption("--planted <point>", "埋点：快照 id，或 桥 id#位置")
      .requiredOption("--desc <text>", "这条线的内容")
      .option("--payoff <point>", "收点（可空）")
      .option("--visibility <v>", "reader_only | character | hidden", "reader_only")
      .option("--known-by <ids>", "visibility = character 时：哪些人物知道，逗号分隔")
      .option("--no-check", "不跑轴 E")
      .option("-n, --samples <n>", "每个节点的采样次数"),
  )
    .description("插一条线，并对埋点之后的快照和桥跑轴 E")
    .action(async (id: string, opts: LlmOpts & { planted: string; desc: string; payoff?: string; visibility: string; knownBy?: string; check: boolean; samples?: string }, cmd: Command) => {
      const root = projectDir(cmd);
      if (!["reader_only", "character", "hidden"].includes(opts.visibility)) throw new Error(`visibility 只能是 reader_only / character / hidden`);
      const file = addThread(loadProject(root), {
        id,
        description: opts.desc,
        planted_at: opts.planted,
        payoff_at: opts.payoff,
        visibility: opts.visibility as "reader_only",
        known_by: opts.knownBy?.split(",").map((s) => s.trim()),
      });
      console.log(`线已写入 ${file}`);
      if (opts.check) {
        const p = loadProject(root);
        await runThreadCheck(p, checkContext(p, opts), id, opts.samples);
      }
    });

  withLlm(thread.command("check").argument("<id>", "线 id").option("-n, --samples <n>", "每个节点的采样次数"))
    .description("对一条线跑轴 E")
    .action(async (id: string, opts: LlmOpts & { samples?: string }, cmd: Command) => {
      const p = loadProject(projectDir(cmd));
      await runThreadCheck(p, checkContext(p, opts), id, opts.samples);
    });

  thread
    .command("nodes")
    .argument("<id>", "线 id")
    .description("列出这条线会检查的节点（不调用模型）")
    .action((id: string, _o: unknown, cmd: Command) => {
      const p = loadProject(projectDir(cmd));
      const th = p.threads.find((x) => x.value.id === id)?.value;
      if (!th) throw new Error(`找不到线：${id}`);
      for (const n of threadNodes(p, th)) console.log(`t=${n.t}\t${n.kind}\t${n.id}${n.isPayoff ? "\t收点" : ""}`);
    });

  program
    .command("status")
    .description("扫描过期检查（档案、快照、桥、接受改过之后），标为 stale")
    .action((_o: unknown, cmd: Command) => {
      const p = loadProject(projectDir(cmd));
      const before = new Set(p.checks.filter((c) => c.value.status === "stale").map((c) => c.value.id));
      const stale = markStale(p);
      const counts = new Map<string, number>();
      for (const c of loadProject(p.root).checks) counts.set(c.value.status, (counts.get(c.value.status) ?? 0) + 1);
      console.log(`${p.checks.length} 条检查：${[...counts].map(([k, v]) => `${k} ${v}`).join(" · ") || "无"}`);
      const fresh = stale.filter((s) => !before.has(s.check.value.id));
      if (fresh.length) {
        console.log(`\n新标为过期 ${fresh.length} 条：`);
        printStale(fresh);
      }
      if (stale.length) console.log(`\n重跑：sw rerun --stale（先显示预计调用次数）`);
    });

  withLlm(
    program
      .command("rerun")
      .requiredOption("--stale", "重跑所有过期检查")
      .option("-y, --yes", "确认执行（不加只显示计划和预计调用次数）")
      .option("-n, --samples <n>", "采样次数（默认沿用各检查原来的次数）"),
  )
    .description("一键重跑过期检查（U8）")
    .action(async (opts: LlmOpts & { yes?: boolean; samples?: string }, cmd: Command) => {
      const p = loadProject(projectDir(cmd));
      markStale(p);
      const fresh = loadProject(p.root);
      const plan = planRerun(fresh, { n: opts.samples ? Number(opts.samples) : undefined });
      if (!plan.items.length && !plan.orphans.length) return console.log("没有过期的检查。");
      for (const it of plan.items) console.log(`${it.kind === "bridge" ? "桥" : "线"} ${it.target}：轴 ${it.axes.join("、")} × ${it.n} 次采样 ≈ ${it.calls} 次调用`);
      if (plan.orphans.length) console.log(`对象已不存在、只能删除的检查：${plan.orphans.join("、")}`);
      const ctx = checkContext(fresh, opts);
      console.log(`\n预计约 ${plan.calls} 次调用（格式修复可能额外增加）· 模型 ${ctx.model} · ${ctx.provider.name}`);
      if (!opts.yes) return console.log("确认后加 --yes 执行。");
      const r = await rerunStale(fresh, ctx, plan, say);
      console.log(`已重跑 ${r.rerun.length} 条检查。${r.stillStale.length ? `仍然过期：${r.stillStale.join("、")}` : "没有过期的检查了。"}`);
      say(callsLine(ctx));
    });

  program
    .command("accept")
    .argument("<check>", "检查 id")
    .requiredOption("--why <text>", "接受的理由")
    .option("--delta <text>", "状态增量，例如\"从此她知道 Villy 会为了房间撒小谎\"（默认用理由）")
    .option("--character <id>", "这条变化属于谁（轴 A 以外的检查必须给）")
    .description("接受偏差：写理由，产生状态增量，下游检查标为过期（U6）")
    .action((id: string, opts: { why: string; delta?: string; character?: string }, cmd: Command) => {
      const r = acceptCheck(loadProject(projectDir(cmd)), id, { justification: opts.why, delta: opts.delta, character: opts.character });
      console.log(`已接受 ${id} → ${r.file}（t=${r.t}，之后的状态会带上这条变化）`);
      if (r.stale.length) {
        console.log(`过期 ${r.stale.length} 条：`);
        printStale(r.stale);
      }
    });

  program
    .command("revoke")
    .argument("<acceptance>", "接受记录 id（acc-…）")
    .description("撤销一次接受；对应检查回到 open，下游检查标为过期")
    .action((id: string, _o: unknown, cmd: Command) => {
      const stale = revokeAcceptance(loadProject(projectDir(cmd)), id);
      console.log(`已撤销 ${id}`);
      if (stale.length) printStale(stale);
    });

  program
    .command("dismiss")
    .argument("<check>", "检查 id")
    .requiredOption("--why <text>", "忽略的原因")
    .description("忽略一条检查（U6）")
    .action((id: string, opts: { why: string }, cmd: Command) => {
      dismissCheck(loadProject(projectDir(cmd)), id, opts.why);
      console.log(`已忽略 ${id}`);
    });

  program
    .command("fixed")
    .argument("<check>", "检查 id")
    .option("--note <text>", "说明")
    .description("标记已修好（改了正文或快照后；重跑会给出新结果）")
    .action((id: string, opts: { note?: string }, cmd: Command) => {
      markFixed(loadProject(projectDir(cmd)), id, opts.note);
      console.log(`已标记 ${id} 为 fixed`);
    });

  program
    .command("export")
    .argument("<what>", "manuscript | report | harvest")
    .option("--out <file>", "写到文件（默认打印）")
    .description("导出稿件（locked 桥按 t 拼接）、未处理检查报告、收获清单（U9）")
    .action((what: string, opts: { out?: string }, cmd: Command) => {
      const p = loadProject(projectDir(cmd));
      let text: string;
      if (what === "manuscript") {
        const m = exportManuscript(p);
        text = m.text;
        say(`拼接了 ${m.included.length} 座 locked 桥${m.skipped.length ? `；跳过 ${m.skipped.join("、")}` : ""}`);
      } else if (what === "report") {
        markStale(p);
        text = exportReport(loadProject(p.root));
      } else if (what === "harvest") {
        const h = exportHarvest(p);
        text = h.text;
        say(`收获 ${h.count} 条（不会自动写回档案）`);
      } else throw new Error(`只能导出 manuscript / report / harvest`);
      if (opts.out) {
        fs.writeFileSync(opts.out, text);
        say(`已写入 ${opts.out}`);
      } else console.log(text);
    });
}

// M2 commands: bridges (U5), extraction and axis D, gaps (axis F), candidates (U3), start drafts (U2).
import fs from "node:fs";
import path from "node:path";
import type { Command } from "commander";
import { ENDPOINT_STATUSES, type Project, type Snapshot, loadProject, updateObjectFile } from "@sw/core";
import { type TextAxis, estimateCalls, gapBetween, renderReport } from "@sw/checks";
import { type LlmContext, createContext } from "@sw/llm";
import {
  BRIDGE_AXES,
  type BridgeAxis,
  adoptDerived,
  approveSnapshot,
  checkBridge,
  draftBridge,
  draftStartSnapshot,
  extractDerived,
  extractInputFor,
  findBridge,
  generateCandidates,
  graftSnapshot,
  outlineBridge,
} from "@sw/ops";

type Dir = (cmd: Command) => string;

interface LlmOpts {
  model?: string;
  recordings?: string;
}

/** Generation uses llm.model; checks use llm.check_model when set (D-007). One log for both. */
function contexts(p: Project, opts: LlmOpts): { gen: LlmContext; check: LlmContext } {
  const gen = createContext({
    projectRoot: p.root,
    model: opts.model ?? p.config.llm.model,
    temperature: p.config.llm.temperature,
    recordings: opts.recordings ? path.resolve(opts.recordings) : undefined,
  });
  return { gen, check: { ...gen, model: opts.model ?? p.config.llm.check_model ?? p.config.llm.model } };
}

function callsLine(ctx: LlmContext): string {
  const t = ctx.log.totals();
  return `${t.calls} 次真实调用${t.replayed ? `、${t.replayed} 次回放` : ""} · ${t.tokens} tokens · ${t.seconds.toFixed(0)} 秒`;
}

const withLlm = (c: Command) =>
  c
    .option("--model <id>", "模型 id（默认 project.yaml 的 llm.model / llm.check_model）")
    .option("--recordings <dir>", "录制 / 回放目录（SW_LLM_MODE=record|replay 时用）");

const say = (m: string) => console.error(m);

interface CheckOpts {
  axes?: string;
  samples?: string;
  out?: string;
}

async function runBridgeChecks(p: Project, check: LlmContext, id: string, opts: CheckOpts) {
  const axes = (opts.axes ?? BRIDGE_AXES.join(",")).split(",").map((a) => a.trim().toUpperCase()) as BridgeAxis[];
  for (const a of axes) if (!BRIDGE_AXES.includes(a)) throw new Error(`桥只能跑轴 ${BRIDGE_AXES.join("、")}，没有 ${a}`);
  const n = opts.samples ? Number(opts.samples) : p.config.sampling;
  const b = findBridge(p, id).value;
  const textAxes = axes.filter((a): a is TextAxis => a !== "D");
  const chars = p.snapshots.find((s) => s.value.id === b.from)?.value.lanes.filter((l) => l !== "world").length ?? 0;
  const est = estimateCalls(chars, textAxes, n) + (axes.includes("D") ? n + 1 : 0);
  say(`预计约 ${est} 次调用（格式修复可能额外增加）· 模型 ${check.model} · ${check.provider.name}`);
  const r = await checkBridge(p, check, id, { axes, n, onProgress: say });
  const fresh = loadProject(p.root);
  const report = renderReport(fresh, r.run, {
    source: `桥 ${id}（${findBridge(fresh, id).file}）`,
    extra: [`终点快照：${b.to}`, `检查已写入：${r.saved.map((s) => s.file).join("、")}`],
    calls: callsLine(check),
  });
  if (opts.out) {
    fs.writeFileSync(opts.out, report);
    say(`报告已写入 ${opts.out}`);
  } else console.log(report);
}

export function registerM2(program: Command, projectDir: Dir): void {
  const bridge = program.command("bridge").description("搭桥：大纲 → 正文 → 检查（U5）");

  withLlm(bridge.command("outline").argument("<bridge>", "桥 id").option("--beats <n>", "节拍数（默认 4 到 8）"))
    .description("生成大纲，写进桥文件的 outline（可以手改后再写正文）")
    .action(async (id: string, opts: LlmOpts & { beats?: string }, cmd: Command) => {
      const p = loadProject(projectDir(cmd));
      const { gen } = contexts(p, opts);
      const r = await outlineBridge(p, gen, id, { beats: opts.beats });
      console.log(`大纲已写入 ${r.file}（标记为模型生成，改完再写正文）\n${r.beats.map((b, i) => `${i + 1}. ${b}`).join("\n")}`);
      if (r.touches.length) console.log(`\n⚠ 这些节拍靠近留白：${r.touches.join("、")}`);
      say(callsLine(gen));
    });

  withLlm(
    bridge
      .command("draft")
      .argument("<bridge>", "桥 id")
      .option("--no-check", "写完不跑检查")
      .option("--axes <axes>", "写完后跑的轴", BRIDGE_AXES.join(","))
      .option("-n, --samples <n>", "每个检查的采样次数")
      .option("--out <file>", "检查报告写到文件"),
  )
    .description("按大纲写正文（旧正文存进 versions），然后跑轴 A/B/C/D")
    .action(async (id: string, opts: LlmOpts & CheckOpts & { check: boolean }, cmd: Command) => {
      const root = projectDir(cmd);
      const p = loadProject(root);
      const { gen, check } = contexts(p, opts);
      say("生成正文…");
      const r = await draftBridge(p, gen, id);
      console.log(`正文已写入 ${r.file}（${r.text.length} 字）${r.version ? `；旧正文存为 ${r.version.path}` : ""}`);
      for (const n of r.notes) console.log(`⚠ ${n}`);
      if (opts.check) await runBridgeChecks(loadProject(root), check, id, opts);
      else say(callsLine(gen));
    });

  withLlm(
    bridge
      .command("check")
      .argument("<bridge>", "桥 id")
      .option("--axes <axes>", "要跑的轴", BRIDGE_AXES.join(","))
      .option("-n, --samples <n>", "每个检查的采样次数")
      .option("--out <file>", "报告写到文件"),
  )
    .description("对桥正文跑轴 A/B/C/D，结果写进 checks/")
    .action(async (id: string, opts: LlmOpts & CheckOpts, cmd: Command) => {
      const p = loadProject(projectDir(cmd));
      await runBridgeChecks(p, contexts(p, opts).check, id, opts);
    });

  withLlm(program.command("extract").argument("<bridge>", "桥 id"))
    .description("从桥正文反向提取到达状态（不给模型看目标快照），写进 derived_snapshot")
    .action(async (id: string, opts: LlmOpts, cmd: Command) => {
      const p = loadProject(projectDir(cmd));
      const { check } = contexts(p, opts);
      const b = findBridge(p, id);
      if (!b.value.text) throw new Error(`桥 ${id} 没有正文`);
      const d = await extractDerived(check, extractInputFor(p, b.value));
      updateObjectFile(p.root, b.file, { derived_snapshot: d });
      console.log(`到达状态已写入 ${b.file}：世界事实 ${d.world_facts.length} 条 · 人物 ${Object.keys(d.char_states).join("、")}`);
      say(callsLine(check));
    });

  program
    .command("gap")
    .argument("[from]", "起点快照 id（不给则列出所有相邻的已批准快照）")
    .argument("[to]", "终点快照 id")
    .option("--detail", "列出每一处变化")
    .description("轴 F：相邻快照之间的间距（不调用模型）")
    .action((from: string | undefined, to: string | undefined, opts: { detail?: boolean }, cmd: Command) => {
      const p = loadProject(projectDir(cmd));
      const snaps = p.snapshots.map((s) => s.value);
      let pairs: [Snapshot, Snapshot][];
      if (from || to) {
        const a = snaps.find((s) => s.id === from);
        const b = snaps.find((s) => s.id === to);
        if (!a || !b) throw new Error("需要两个存在的快照 id");
        pairs = [[a, b]];
      } else {
        const line = snaps.filter((s) => ENDPOINT_STATUSES.includes(s.status)).sort((a, b) => a.t - b.t);
        pairs = line.slice(1).map((b, i) => [line[i]!, b]);
      }
      if (!pairs.length) console.log("（没有相邻的已批准快照）");
      const warn = p.config.thresholds.F.warn;
      for (const [a, b] of pairs) {
        const g = gapBetween(a, b, p.config);
        const hint = g.suggestAddPoint ? `  ⚠ ≥${warn}，建议加点：sw candidates ${a.id} ${b.id} --dims …` : "";
        console.log(`${a.id}（t=${a.t}）→ ${b.id}（t=${b.t}）  间距 ${g.score}${hint}`);
        if (opts.detail) {
          for (const c of g.changes) {
            const who = c.character ? `${c.character}.` : "";
            console.log(`  ${who}${c.field}  ×${c.units}（权重 ${c.weight}）  ${c.before.join("；") || "—"}  →  ${c.after.join("；") || "—"}`);
          }
        }
      }
    });

  withLlm(
    program
      .command("candidates")
      .argument("<from>", "前一个已批准快照")
      .argument("<to>", "后一个已批准快照")
      .requiredOption("--dims <dims>", "候选之间必须不同的维度，逗号分隔，例如 \"谁推动,冲突在哪\"")
      .option("-k, --count <k>", "候选数（2–4）", "3"),
  )
    .description("在两个相邻快照之间生成候选中间快照，写进 branches/（U3）")
    .action(async (from: string, to: string, opts: LlmOpts & { dims: string; count: string }, cmd: Command) => {
      const p = loadProject(projectDir(cmd));
      const { gen } = contexts(p, opts);
      const dims = opts.dims.split(/[,，]/).map((d) => d.trim()).filter(Boolean);
      const r = await generateCandidates(p, gen, { from, to, dims, k: Number(opts.count) });
      for (const c of r.candidates) {
        console.log(`\n${c.id}  「${c.title}」  t=${c.t}  → ${c.file}`);
        for (const d of dims) console.log(`  ${d}：${c.dims[d] || "（缺）"}`);
        if (c.touches.length) console.log(`  会触碰的留白：${c.touches.join("、")}`);
      }
      for (const x of r.indistinct) console.log(`\n⚠ 维度「${x.dim}」上 ${x.ids.join("、")} 没有区分开`);
      for (const n of r.notes) console.log(`⚠ ${n}`);
      console.log(`\n挑一个：sw approve <id>（其余的标为 pruned，留在 branches/，可以 sw graft 嫁接回来）`);
      say(callsLine(gen));
    });

  program
    .command("approve")
    .argument("<snapshot>", "快照 id（可以是 branches/ 里的候选）")
    .description("批准快照；候选会移到 snapshots/，同组其他候选标为 pruned")
    .action((id: string, _o: unknown, cmd: Command) => {
      const r = approveSnapshot(loadProject(projectDir(cmd)), id);
      console.log(`${id} 已批准 → ${r.file}`);
      if (r.pruned.length) console.log(`同组候选标为 pruned：${r.pruned.join("、")}`);
      for (const w of r.warnings) console.log(`⚠ ${w}`);
    });

  program
    .command("graft")
    .argument("<snapshot>", "branches/ 里的候选 id")
    .description("把落选的候选嫁接回时间线（status = sketch，需再批准）")
    .action((id: string, _o: unknown, cmd: Command) => {
      const r = graftSnapshot(loadProject(projectDir(cmd)), id);
      console.log(`${id} 已嫁接 → ${r.file}（sketch，用 sw approve ${id} 批准）`);
      for (const w of r.warnings) console.log(`⚠ ${w}`);
    });

  program
    .command("adopt")
    .argument("<bridge>", "桥 id")
    .description("桥比计划好：把它的到达状态采纳为终点快照（旧版本另存）")
    .action((id: string, _o: unknown, cmd: Command) => {
      const r = adoptDerived(loadProject(projectDir(cmd)), id);
      console.log(`快照 ${r.target} 已改为桥 ${id} 的到达状态（${r.file}）；原来的存为 ${r.version.path}`);
      for (const w of r.warnings) console.log(`⚠ ${w}`);
      console.log(`这座桥的检查需要重跑：sw bridge check ${id}`);
    });

  withLlm(
    program
      .command("start-draft")
      .argument("<id>", "新快照 id")
      .requiredOption("--opening <text>", "开场设定；以 @ 开头表示从文件读")
      .option("--t <t>", "故事时间", "0")
      .option("--title <title>", "标题（默认由模型起）")
      .option("--chars <ids>", "涉及人物，逗号分隔（默认：所有人物泳道）"),
  )
    .description("从档案已定事实 + 开场设定起草起点快照（U2；sketch，需批准）")
    .action(async (id: string, opts: LlmOpts & { opening: string; t: string; title?: string; chars?: string }, cmd: Command) => {
      const p = loadProject(projectDir(cmd));
      const { gen } = contexts(p, opts);
      const opening = opts.opening.startsWith("@") ? fs.readFileSync(opts.opening.slice(1), "utf8").trim() : opts.opening;
      const r = await draftStartSnapshot(p, gen, {
        id,
        t: Number(opts.t),
        title: opts.title,
        opening,
        characters: opts.chars?.split(",").map((c) => c.trim()),
      });
      console.log(`起点草稿已写入 ${r.file}（sketch · llm-candidate）。改好后：sw approve ${id}`);
      say(callsLine(gen));
    });
}

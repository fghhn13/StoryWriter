#!/usr/bin/env -S npx tsx
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import {
  type Issue,
  type Located,
  type Project,
  importWikiPage,
  initProject,
  loadProject,
  parseMarkdownFile,
  readText,
  renderYamlFile,
  resolveMapping,
  validateProject,
  writeInlineProfile,
  writeProfileRef,
} from "@sw/core";
import { type RunResult, type TextAxis, estimateCalls, renderReport, runTextChecks } from "@sw/checks";
import { GptsApiProvider, createContext, loadLlmEnv } from "@sw/llm";
import { registerM2 } from "./m2";
import { registerM3 } from "./m3";

const program = new Command();
program.name("sw").description("故事生成器").option("-p, --project <dir>", "项目文件夹", ".");

const projectDir = (cmd: Command) => path.resolve(cmd.optsWithGlobals<{ project: string }>().project);

function formatIssue(i: Issue): string {
  const loc = i.line ? `${i.file}:${i.line}` : i.file;
  return `${i.level === "error" ? "错误" : "提醒"}  ${loc}  ${i.message}`;
}

program
  .command("init")
  .argument("<dir>", "新项目文件夹")
  .option("--name <name>", "作品名")
  .option("--mapping <name>", "把内置导入映射写进 project.yaml（如 oc-wiki）")
  .description("新建项目")
  .action((dir: string, opts: { name?: string; mapping?: string }) => {
    initProject(dir, { name: opts.name ?? path.basename(path.resolve(dir)), mapping: opts.mapping });
    console.log(`已建项目：${path.resolve(dir)}`);
  });

program
  .command("validate")
  .description("校验项目文件格式与对象间引用")
  .option("--strict", "提醒也算失败")
  .action((opts: { strict?: boolean }, cmd: Command) => {
    const p = loadProject(projectDir(cmd));
    const issues = validateProject(p);
    for (const i of issues) console.log(formatIssue(i));
    const errors = issues.filter((i) => i.level === "error").length;
    const warnings = issues.length - errors;
    console.log(
      `\n${p.profiles.length} 档案 · ${p.snapshots.length} 快照 · ${p.bridges.length} 桥 · ${p.threads.length} 线 · ${p.checks.length} 检查 — ${errors} 错误，${warnings} 提醒`,
    );
    if (errors || (opts.strict && warnings)) process.exitCode = 1;
  });

const KINDS = ["profiles", "snapshots", "bridges", "threads", "checks", "acceptances", "lanes"] as const;
type Kind = (typeof KINDS)[number];

function rows(p: Project, kind: Kind): string[] {
  switch (kind) {
    case "profiles":
      return p.profiles.map(({ value: v }) => {
        const n = (k: keyof typeof v) => (v[k] as unknown[]).length;
        const ro = v.readonly ? "  [外部只读]" : "";
        return `${v.id}\t${v.name}\t规则 ${n("heuristics")} · 边界 ${n("boundaries")} · 留白 ${n("unknowns")}${ro}`;
      });
    case "snapshots":
      return [...p.snapshots]
        .sort((a, b) => a.value.t - b.value.t)
        .map(({ value: v }) => `t=${v.t}\t${v.id}\t${v.title}\t${v.status}\t${v.origin}`);
    case "bridges":
      return p.bridges.map(({ value: v }) => `${v.id}\t${v.from} → ${v.to}\t${v.status}\t${v.text.length} 字`);
    case "threads":
      return p.threads.map(({ value: v }) => `${v.id}\t${v.planted_at} → ${v.payoff_at ?? "（未收）"}\t${v.visibility}\t${v.status}`);
    case "checks":
      return p.checks.map(({ value: v }) => `${v.id}\t轴 ${v.axis}\t${v.target}\t${v.score}\t${v.status}`);
    case "acceptances":
      return p.acceptances.map(({ value: v }) => `${v.id}\t${v.character}@t=${v.t}\t${v.delta}`);
    case "lanes":
      return p.config.lanes.map((l) => `${l.id}\t${l.kind}\t${l.name ?? ""}`);
  }
}

program
  .command("list")
  .argument("<kind>", KINDS.join(" | "))
  .description("列出项目中的对象")
  .action((kind: string, _opts: unknown, cmd: Command) => {
    if (!KINDS.includes(kind as Kind)) program.error(`未知类型：${kind}（可选：${KINDS.join("、")}）`);
    const p = loadProject(projectDir(cmd));
    const out = rows(p, kind as Kind);
    console.log(out.length ? out.join("\n") : "（空）");
    if (p.issues.length) console.error(`\n有 ${p.issues.length} 个文件读取问题，运行 sw validate 查看`);
  });

program
  .command("show")
  .argument("<id>", "对象 id")
  .description("显示一个对象的全部字段")
  .action((id: string, _opts: unknown, cmd: Command) => {
    const p = loadProject(projectDir(cmd));
    const all: [string, Located<{ id: string }>[]][] = [
      ["档案", p.profiles],
      ["快照", p.snapshots],
      ["候选快照", p.branchSnapshots],
      ["桥", p.bridges],
      ["线", p.threads],
      ["检查", p.checks],
      ["接受", p.acceptances],
    ];
    const hits = all.flatMap(([k, xs]) => xs.filter((x) => x.value.id === id).map((x) => [k, x] as const));
    if (!hits.length) program.error(`找不到 id 为 ${id} 的对象`);
    for (const [k, x] of hits) {
      console.log(`# ${k} · ${x.file}\n`);
      console.log(renderYamlFile(x.value));
    }
  });

program
  .command("import")
  .argument("<pages...>", "wiki 人物页（Markdown）")
  .option("--mapping <name>", "导入映射名", "oc-wiki")
  .option("--copy", "复制成项目内可编辑档案（默认：只读引用外部文件）")
  .option("--id <id>", "档案 id（只导入一页时可用；默认取页面 frontmatter 的 id）")
  .description("从 Markdown 导入人物档案")
  .action((pages: string[], opts: { mapping: string; copy?: boolean; id?: string }, cmd: Command) => {
    const root = projectDir(cmd);
    const p = loadProject(root);
    const mapping = resolveMapping(p.config, opts.mapping);
    if (!mapping) return program.error(`未知的导入映射：${opts.mapping}`);
    if (opts.id && pages.length > 1) program.error("--id 只能和单个页面一起用");
    for (const page of pages) {
      const imp = importWikiPage(readText(page), mapping);
      const id = opts.id ?? imp.id;
      if (!id) {
        console.error(`跳过 ${page}：页面没有 id，请用 --id 指定`);
        process.exitCode = 1;
        continue;
      }
      const written = opts.copy ? writeInlineProfile(root, imp, id, page) : writeProfileRef(root, page, id, opts.mapping);
      const e = imp.entries;
      const inferred = Object.values(e).flat().filter((x) => x.origin === "llm").length;
      console.log(
        `${id}（${imp.name ?? "?"}）→ ${path.relative(root, written)}\n` +
          `  核心 ${imp.core ? "✓" : "—"} · 人格 ${e.traits.length} · 决策规则 ${e.heuristics.length} · 边界 ${e.boundaries.length} · 事实 ${e.hard_facts.length} · 留白 ${e.unknowns.length} · 推演 ${inferred}`,
      );
      if (!e.heuristics.length) console.log("  ⚠ 没有决策规则：轴 A 对此人物置信度受限");
      if (imp.unmatched.length) console.log(`  未映射的小节：${imp.unmatched.join("、")}`);
    }
  });

program
  .command("check")
  .argument("<scene>", "场景文本（Markdown；frontmatter 可写 from 与 characters）")
  .option("--from <id>", "起点快照 id")
  .option("--chars <ids>", "涉及人物，逗号分隔（默认：起点快照的泳道 + 文本里点名的人物）")
  .option("--axes <axes>", "要跑的轴", "A,B,C")
  .option("-n, --samples <n>", "每个检查的采样次数（默认 project.yaml 的 sampling）")
  .option("--runs <k>", "把整套检查重复 k 次，报告分数波动（M1 验收 4）", "1")
  .option("--model <id>", "模型 id（默认 llm.check_model 或 llm.model）")
  .option("--out <file>", "报告写到文件（默认打印）")
  .option("--recordings <dir>", "录制 / 回放目录（SW_LLM_MODE=record|replay 时用）")
  .description("对一段场景文本跑轴 A（人物）、B（连续性）、C（留白）")
  .action(async (scene: string, opts: Record<string, string | undefined>, cmd: Command) => {
    const p = loadProject(projectDir(cmd));
    const src = parseMarkdownFile(readText(scene));
    const fm = (src.data ?? {}) as { from?: string; characters?: string[] };
    const from = opts.from ?? fm.from;
    if (!from) return program.error("需要起点快照：--from <id>，或在场景 frontmatter 里写 from");
    const axes = opts.axes!.split(",").map((a) => a.trim().toUpperCase()) as TextAxis[];
    const n = opts.samples ? Number(opts.samples) : p.config.sampling;
    const runs = Number(opts.runs);
    const characters = opts.chars?.split(",").map((c) => c.trim()) ?? fm.characters;
    const ctx = createContext({
      projectRoot: p.root,
      model: opts.model ?? p.config.llm.check_model ?? p.config.llm.model,
      temperature: p.config.llm.temperature,
      recordings: opts.recordings ? path.resolve(opts.recordings) : undefined,
    });
    const nChars = characters?.length ?? "?";
    console.error(`预计 ${typeof nChars === "number" ? estimateCalls(nChars, axes, n) * runs : `${n}×(人物数+2)×${runs}`} 次调用（格式修复可能额外增加）· 模型 ${ctx.model} · ${ctx.provider.name}`);

    const all: RunResult[] = [];
    for (let r = 0; r < runs; r++) {
      // run 1 shares recordings with a plain single run
      ctx.runTag = r === 0 ? undefined : `run${r + 1}`;
      all.push(
        await runTextChecks(p, ctx, {
          text: src.body.trim(),
          from,
          characters,
          axes,
          n,
          onProgress: (m) => console.error(`${runs > 1 ? `[第 ${r + 1}/${runs} 轮] ` : ""}${m}`),
        }),
      );
    }
    const t = ctx.log.totals();
    const calls = `${t.calls} 次真实调用${t.replayed ? `、${t.replayed} 次回放` : ""} · ${t.tokens} tokens · ${t.seconds.toFixed(0)} 秒`;
    let report = renderReport(p, all[0]!, { source: path.relative(p.root, path.resolve(scene)), calls });
    if (runs > 1) {
      const rows = all[0]!.results.map((res, i) => {
        const scores = all.map((run) => run.results[i]!.score);
        const spread = Math.max(...scores) - Math.min(...scores);
        return `| 轴 ${res.axis}${res.character ? ` · ${res.character}` : ""} | ${scores.join(" / ")} | ${spread} | ${spread <= 20 ? "✓ 在 ±10 内" : "✗ 超出 ±10"} |`;
      });
      report += `\n## 重复 ${runs} 轮的分数波动\n\n| 检查 | 各轮分数 | 极差 | ±10 |\n|---|---|---|---|\n${rows.join("\n")}\n`;
    }
    if (opts.out) {
      fs.writeFileSync(opts.out, report);
      console.error(`报告已写入 ${opts.out}`);
    } else console.log(report);
  });

registerM2(program, projectDir);
registerM3(program, projectDir);

program
  .command("serve")
  .option("--port <n>", "端口", "4173")
  .option("--host <h>", "监听地址（默认只在本机）", "127.0.0.1")
  .option("--recordings <dir>", "录制 / 回放目录（SW_LLM_MODE=record|replay 时用）")
  .option("--no-ui", "只提供 /api（Tauri 桌面窗口用）")
  .description("打开画布（本地网页）；在编辑器里改文件，画布会自动刷新")
  .action(async (opts: { port: string; host: string; recordings?: string; ui: boolean }, cmd: Command) => {
    const { startServer } = await import("@sw/server");
    const s = await startServer({ root: projectDir(cmd), port: Number(opts.port), host: opts.host, ui: opts.ui, recordings: opts.recordings ? path.resolve(opts.recordings) : undefined });
    console.log(`画布：${s.url}
项目：${projectDir(cmd)}
Ctrl+C 退出`);
  });

const llm = program.command("llm").description("检查 LLM 中转站连通性（GPTsAPI）");
llm
  .command("models")
  .description("列出中转站返回的模型 id（不计费）")
  .action(async (_opts: unknown, cmd: Command) => {
    const env = loadLlmEnv({ dirs: [projectDir(cmd), process.cwd()] });
    const ids = await new GptsApiProvider(env).models();
    console.log(`${env.baseUrl} · ${ids.length} 个模型\n${ids.join("\n")}`);
  });
llm
  .command("smoke")
  .description("发一次最小对话（计费，最多 16 输出 token），期望回答 OK")
  .action(async (_opts: unknown, cmd: Command) => {
    const env = loadLlmEnv({ dirs: [projectDir(cmd), process.cwd()] });
    const r = await new GptsApiProvider(env).chatOnce({
      model: env.model,
      messages: [{ role: "user", content: "Reply with exactly: OK" }],
      max_tokens: 16,
    });
    const passed = r.text.trim() === "OK";
    console.log(JSON.stringify({ model: r.model, answer: r.text, usage: r.usage, seconds: +r.seconds.toFixed(2), passed }, null, 2));
    if (!passed) process.exitCode = 1;
  });

program.parseAsync().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});

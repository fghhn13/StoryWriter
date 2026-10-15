// U5 搭桥: outline → (author edits) → draft → checks A/B/C/D (spec §6-U5).
import { DIRS, type Project, loadProject, updateObjectFile, saveVersion, validateProject } from "@sw/core";
import { type CheckResult, type RunResult, type TextAxis, checkAxisD, runTextChecks } from "@sw/checks";
import { type LlmContext, callStructured, callText } from "@sw/llm";
import { z } from "zod";
import { NO_VOICE_NOTE, castOf, characterBriefs, findSnapshot, genPrinciples, hash, opsTemplate, renderSnapshot, voiceSample } from "./brief";
import { extractDerived, extractInputFor } from "./extract";
import { findBridge, saveCheck } from "./store";

const OutlineOutput = z.object({
  beats: z.array(z.string().min(1)).min(1),
  touches_unknowns: z.array(z.string()).default([]),
});

/** Refuse to generate on a bridge the validator rejects (non-approved or non-adjacent endpoints). */
function assertBridgeUsable(p: Project, id: string) {
  const b = findBridge(p, id);
  const errors = validateProject(p).filter((i) => i.level === "error" && i.file === b.file);
  if (errors.length) throw new Error(`桥 ${id} 不能生成：\n${errors.map((e) => `  ${e.file}:${e.line ?? ""} ${e.message}`).join("\n")}`);
  return b;
}

function generationInputs(p: Project, id: string) {
  const b = assertBridgeUsable(p, id);
  const from = findSnapshot(p, b.value.from);
  const to = findSnapshot(p, b.value.to);
  const brief = characterBriefs(p, castOf(p, from, to), from.t);
  return { b, from, to, brief };
}

export interface OutlineResult {
  beats: string[];
  touches: string[];
  file: string;
}

export async function outlineBridge(p: Project, ctx: LlmContext, id: string, opts: { beats?: string } = {}): Promise<OutlineResult> {
  const { b, from, to, brief } = generationInputs(p, id);
  const out = await callStructured(ctx, {
    task: `outline:${id}`,
    template: opsTemplate("bridge-outline"),
    schema: OutlineOutput,
    summary: `大纲 ${id}：${from.id} → ${to.id} · 人物 ${Object.keys(brief.injected).join(",")}`,
    vars: {
      principles: genPrinciples(),
      from: renderSnapshot(from),
      to: renderSnapshot(to),
      characters: brief.text,
      beats_hint: opts.beats ?? "4 到 8",
    },
  });
  const keys = new Set(brief.scope.map((s) => s.key));
  const touches = out.touches_unknowns.filter((k) => keys.has(k));
  updateObjectFile(p.root, b.file, {
    outline: out.beats,
    status: b.value.text ? b.value.status : "outline",
    // the outline is model output until the author edits or approves it (spec §3.1)
    outline_origin: "llm",
    outline_touches_unknowns: touches.length ? touches : undefined,
    injected: { outline: { template: "bridge-outline", snapshots: [from.id, to.id], characters: brief.injected } },
  });
  return { beats: out.beats, touches, file: b.file };
}

export interface DraftResult {
  text: string;
  file: string;
  version?: { v: number; path: string };
  notes: string[];
}

export async function draftBridge(p: Project, ctx: LlmContext, id: string): Promise<DraftResult> {
  const { b, from, to, brief } = generationInputs(p, id);
  if (!b.value.outline.length) throw new Error(`桥 ${id} 还没有大纲：先运行 sw bridge outline ${id}（可以改完再写正文）`);
  const voice = voiceSample(p);
  const notes = voice ? [] : [NO_VOICE_NOTE];
  const text = await callText(ctx, {
    task: `draft:${id}`,
    template: opsTemplate("bridge-draft"),
    summary: `正文 ${id}：${from.id} → ${to.id} · 节拍 ${b.value.outline.length} · 声音样本 ${voice ? voice.path : "无"}`,
    vars: {
      principles: genPrinciples(),
      from: renderSnapshot(from),
      to: renderSnapshot(to),
      characters: brief.text,
      outline: b.value.outline.map((x, i) => `${i + 1}. ${x}`).join("\n"),
      voice: voice ? `下面是作者自己写的一段文字，模仿它的语气、句子长短和叙述距离（不要模仿内容）：\n<<<\n${voice.text}\n>>>` : "（无。用克制、具体的叙述。）",
    },
  });

  // every rewrite keeps the previous text (spec §4.3 versions)
  let version: DraftResult["version"];
  const versions = [...b.value.versions];
  if (b.value.text) {
    version = saveVersion(p.root, DIRS.bridges, id, b.file);
    versions.push({ v: version.v, at: new Date().toISOString(), path: version.path, note: `重写前的 ${b.value.status}` });
  }
  updateObjectFile(
    p.root,
    b.file,
    {
      status: "draft",
      text_origin: "llm",
      versions: versions.length ? versions : undefined,
      // the old arrival state described the old text
      derived_snapshot: undefined,
      injected: {
        ...(b.value.injected ?? {}),
        draft: {
          template: "bridge-draft",
          snapshots: [from.id, to.id],
          outline_hash: hash(b.value.outline.join("\n")),
          voice_sample: voice?.path ?? null,
          characters: brief.injected,
        },
      },
    },
    text,
  );
  return { text, file: b.file, version, notes };
}

export interface BridgeCheckResult {
  run: RunResult;
  saved: { id: string; file: string }[];
  extracted: boolean;
}

export const BRIDGE_AXES = ["A", "B", "C", "D"] as const;
export type BridgeAxis = (typeof BRIDGE_AXES)[number];

/** Axes A/B/C on the text from the bridge's start, axis D against its target; results go to checks/. */
export async function checkBridge(
  p: Project,
  ctx: LlmContext,
  id: string,
  opts: { axes?: BridgeAxis[]; n?: number; onProgress?: (m: string) => void } = {},
): Promise<BridgeCheckResult> {
  const b = findBridge(p, id);
  const text = b.value.text;
  if (!text) throw new Error(`桥 ${id} 没有正文`);
  const axes = opts.axes ?? [...BRIDGE_AXES];
  const n = opts.n ?? p.config.sampling;
  const say = opts.onProgress ?? (() => {});
  const from = findSnapshot(p, b.value.from);
  const to = findSnapshot(p, b.value.to);
  const textAxes = axes.filter((a): a is TextAxis => a !== "D");
  const run: RunResult = textAxes.length
    ? await runTextChecks(p, ctx, { text, from: from.id, axes: textAxes, n, onProgress: say })
    : { from, characters: [], results: [] };

  let extracted = false;
  if (axes.includes("D")) {
    let derived = b.value.derived_snapshot;
    if (!derived || derived.text_hash !== hash(text)) {
      say("反向提取到达状态（不给模型看目标快照）");
      derived = await extractDerived(ctx, extractInputFor(p, b.value));
      updateObjectFile(p.root, b.file, { derived_snapshot: derived });
      extracted = true;
    }
    say(`轴 D · 到达（${n} 次采样）`);
    run.results.push(await checkAxisD(ctx, { target: to, derived, n }));
  }

  const inputs = { text: hash(text), from: hash(JSON.stringify(from)), to: hash(JSON.stringify(to)) };
  const saved = run.results.map((r: CheckResult) => saveCheck(p, id, r, inputs));
  const fresh = findBridge(loadProject(p.root), id);
  updateObjectFile(p.root, fresh.file, { checks: [...new Set([...fresh.value.checks, ...saved.map((s) => s.id)])] });
  return { run, saved, extracted };
}

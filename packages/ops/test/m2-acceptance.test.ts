// M2 acceptance (spec §10) replayed from recorded real-model outputs in fixtures/recordings/m2.
// Record (pays only for requests not yet recorded, D-031):
//   SW_LLM_MODE=record npx vitest run packages/ops/test/m2-acceptance.test.ts
// Recording also writes the reports/m2-*.md files.
import fs from "node:fs";
import path from "node:path";
import { loadProject } from "@sw/core";
import { type DiffRow, renderReport } from "@sw/checks";
import { createContext, currentMode } from "@sw/llm";
import { describe, expect, it } from "vitest";
import { MINIMAL, REPO, edit, tempCopy } from "../../core/test/helpers";
import { checkBridge, draftBridge, generateCandidates, outlineBridge } from "../src";

const REC = path.join(REPO, "fixtures/recordings/m2");
const MODEL = "claude-opus-5-5";
const MODE = currentMode("replay");
const RECORDING = MODE === "record";
const TIMEOUT = RECORDING ? 40 * 60_000 : 30_000;

const context = (root: string) => createContext({ projectRoot: root, model: MODEL, recordings: REC, mode: "replay" });
const rowsOf = (r: { details: unknown }) => (r.details as { rows: DiffRow[] }).rows;
const writeReport = (name: string, text: string) => {
  if (RECORDING) fs.writeFileSync(path.join(REPO, "reports", name), text);
};

describe.skipIf(!RECORDING && !fs.existsSync(REC))("M2 acceptance (recorded)", () => {
  it(
    "bridge: axis D lines up field by field; changing one target wants shows up in the diff",
    async () => {
      const dir = tempCopy(MINIMAL);
      const ctx = context(dir);
      const outline = await outlineBridge(loadProject(dir), ctx, "b-fifth");
      expect(outline.beats.length).toBeGreaterThanOrEqual(3);
      const draft = await draftBridge(loadProject(dir), ctx, "b-fifth");
      expect(draft.text.length).toBeGreaterThan(200);

      const first = await checkBridge(loadProject(dir), ctx, "b-fifth", { n: 3 });
      expect(first.extracted).toBe(true);
      const d1 = first.run.results.find((r) => r.axis === "D")!;
      const target1 = loadProject(dir).snapshots.find((s) => s.value.id === "s-registered")!.value;
      // every target field appears exactly once in the diff, and the model judged it
      const rows1 = rowsOf(d1).filter((r) => r.target);
      expect(rows1.map((r) => r.key).sort()).toEqual(
        [
          ...target1.world_facts.map((_, i) => `world.${i + 1}`),
          ...Object.entries(target1.char_states).flatMap(([c, s]) => [
            ...s.knows.map((_, i) => `${c}.knows.${i + 1}`),
            ...s.wants.map((_, i) => `${c}.wants.${i + 1}`),
            ...(s.feels ? [`${c}.feels`] : []),
            ...(s.location ? [`${c}.location`] : []),
            ...Object.keys(s.relationships).map((o) => `${c}.relationships.${o}`),
          ]),
        ].sort(),
      );
      expect(rows1.filter((r) => r.status === "unjudged")).toEqual([]);
      const before = rows1.find((r) => r.key === "ancore.wants.1")!;

      const p1 = loadProject(dir);
      const bridge = p1.bridges[0]!.value;
      writeReport(
        "m2-bridge.md",
        `# M2 · 搭桥实录（b-fifth）\n\n## 大纲（模型生成）\n\n${bridge.outline.map((b, i) => `${i + 1}. ${b}`).join("\n")}\n\n## 正文（模型生成）\n\n${bridge.text}\n\n## 到达状态（反向提取，未看目标快照）\n\n\`\`\`yaml\n${JSON.stringify(bridge.derived_snapshot, null, 1)}\n\`\`\`\n`,
      );
      writeReport("m2-checks.md", renderReport(p1, first.run, { source: "桥 b-fifth（模型生成正文）", extra: ["终点快照：s-registered"] }));

      // change one wants on the target and re-run axis D only
      edit(path.join(dir, "snapshots/t1-registered.md"), "亲自体验另一种人生。", "尽快离开这个社团，不再回来。");
      const second = await checkBridge(loadProject(dir), ctx, "b-fifth", { n: 3, axes: ["D"] });
      // the text didn't change, so the arrival state is reused: extraction never depended on the target
      expect(second.extracted).toBe(false);
      const d2 = second.run.results.find((r) => r.axis === "D")!;
      const after = rowsOf(d2).find((r) => r.key === "ancore.wants.1")!;
      expect(after.target?.text).toBe("尽快离开这个社团，不再回来。");
      expect(after.status === "conflict" || after.status === "missing").toBe(true);
      expect(after.status).not.toBe(before.status);
      expect(d2.score).toBeGreaterThan(d1.score);
      writeReport(
        "m2-target-change.md",
        `# M2 · 改目标快照的一个 wants 后重跑轴 D\n\n改动：s-registered · ancore.wants.1「亲自体验另一种人生。」→「尽快离开这个社团，不再回来。」\n\n| | 改前 | 改后 |\n|---|---|---|\n| ancore.wants.1 | ${before.status} | ${after.status} |\n| 轴 D 分数 | ${d1.score} | ${d2.score} |\n\n反向提取没有重跑（正文没变，提取请求与目标快照无关）。\n\n${renderReport(loadProject(dir), { ...second.run, characters: [] }, { source: "桥 b-fifth", extra: ["终点快照：s-registered（已改）"] })}`,
      );
    },
    TIMEOUT,
  );

  it(
    "candidates: three snapshots, distinguishable on the requested dimensions",
    async () => {
      const dir = tempCopy(MINIMAL);
      const dims = ["谁推动", "冲突在哪"];
      const r = await generateCandidates(loadProject(dir), context(dir), { from: "s-start", to: "s-registered", dims, k: 3 });
      expect(r.candidates).toHaveLength(3);
      expect(r.indistinct).toEqual([]);
      for (const c of r.candidates) for (const d of dims) expect(c.dims[d]).toBeTruthy();
      const p = loadProject(dir);
      expect(p.branchSnapshots.every((s) => s.value.status === "sketch" && s.value.origin === "llm-candidate")).toBe(true);
      writeReport(
        "m2-candidates.md",
        `# M2 · 候选快照（s-start → s-registered，维度：${dims.join("、")}）\n\n${r.candidates
          .map((c) => {
            const s = p.branchSnapshots.find((x) => x.value.id === c.id)!.value;
            return `## ${c.id}「${c.title}」\n\n${dims.map((d) => `- **${d}**：${c.dims[d]}`).join("\n")}\n- 会触碰的留白：${c.touches.join("、") || "无"}\n- 世界事实：${s.world_facts.join("；")}\n\n${s.author_notes}`;
          })
          .join("\n\n")}\n`,
      );
    },
    TIMEOUT,
  );
});

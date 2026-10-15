// M3 acceptance (spec §10) replayed from recorded real-model outputs in fixtures/recordings/m3.
// Record (pays only for requests not yet recorded, D-031):
//   SW_LLM_MODE=record npx vitest run packages/ops/test/m3-acceptance.test.ts
// Recording also writes reports/m3-*.md.
import fs from "node:fs";
import path from "node:path";
import { loadProject } from "@sw/core";
import { type NodeResult } from "@sw/checks";
import { createContext, currentMode } from "@sw/llm";
import { describe, expect, it } from "vitest";
import { REPO, edit, tempCopy } from "../../core/test/helpers";
import { addThread, checkBridge, checkThread, exportReport, findStale, markStale, planRerun, rerunStale } from "../src";

const M3 = path.join(REPO, "fixtures/m3-project");
const REC = path.join(REPO, "fixtures/recordings/m3");
const RECORDING = currentMode("replay") === "record";
const TIMEOUT = RECORDING ? 40 * 60_000 : 30_000;
const context = (root: string) => createContext({ projectRoot: root, model: "claude-opus-5-5", recordings: REC, mode: "replay" });
const writeReport = (name: string, text: string) => {
  if (RECORDING) fs.writeFileSync(path.join(REPO, "reports", name), text);
};

// planted at t=1; the t=3 snapshot has everyone cleaning the activity room on Saturday
const THREAD = {
  id: "th-key",
  description: "登记当天傍晚，学生会以“设备用电不合规”为由收走了活动室的钥匙，两周之内社团不能进入活动室。",
  planted_at: "s-registered",
  visibility: "character" as const,
  known_by: ["tina"],
};

describe.skipIf(!RECORDING && !fs.existsSync(REC))("M3 acceptance (recorded)", () => {
  it(
    "a thread at t=1 that contradicts the t=3 snapshot: axis E highlights t=3; a t=0 hard fact edit stales everything downstream; one rerun clears it",
    async () => {
      const dir = tempCopy(M3);
      const ctx = context(dir);
      addThread(loadProject(dir), THREAD);

      // ---- 1. axis E
      const e = await checkThread(loadProject(dir), ctx, "th-key", { n: 3 });
      const d = e.result.details as { nodes: NodeResult[]; affected: string[]; unpaid: boolean };
      expect(d.affected).toContain("s-cleanup");
      expect(d.affected).not.toContain("s-library");
      expect(d.nodes.find((n) => n.node === "s-cleanup")!.score).toBeGreaterThanOrEqual(40);
      expect(d.unpaid).toBe(true);
      writeReport(
        "m3-thread.md",
        [
          "# M3 · 伏笔检查（轴 E）",
          "",
          `线 th-key（埋点 s-registered，t=1；只有 tina 知道）：${THREAD.description}`,
          "",
          `**偏差 ${e.result.score}** · 置信度 ${e.result.confidence} · 未收：${d.unpaid ? "是（没有收点，不计分）" : "否"}`,
          "",
          "| t | 节点 | 偏差 | 样本 | 受影响 |",
          "|---|---|---|---|---|",
          ...d.nodes.map((n) => `| ${n.t} | ${n.kind === "snapshot" ? "快照" : "桥"} ${n.node} | ${n.score} | ${n.scores.join(" / ")} | ${d.affected.includes(n.node) ? "⚠" : ""} |`),
          "",
          "## 证据",
          "",
          ...e.result.evidence.map((x) => `- ${x.verified ? "" : "（引文未核实）"}「${x.quote}」——${x.note}`),
          "",
        ].join("\n"),
      );

      // ---- 2. checks on every bridge, then edit a t=0 profile hard fact
      for (const b of ["b01", "b12", "b23"]) await checkBridge(loadProject(dir), ctx, b, { n: 1, axes: ["B", "C"] });
      expect(findStale(loadProject(dir))).toEqual([]);
      const all = loadProject(dir).checks.map((c) => c.value.id).sort();
      expect(all).toEqual(["b01.B", "b01.C", "b12.B", "b12.C", "b23.B", "b23.C", "th-key.E"]);

      edit(path.join(dir, "profiles/tina.md"), "年龄：18", "年龄：17");
      const stale = markStale(loadProject(dir));
      expect(stale.map((s) => s.check.value.id).sort()).toEqual(all);
      expect(loadProject(dir).checks.every((c) => c.value.status === "stale")).toBe(true);
      const reportStale = exportReport(loadProject(dir));

      // ---- 3. one rerun
      const plan = planRerun(loadProject(dir));
      const before = ctx.log.records.length;
      const r = await rerunStale(loadProject(dir), ctx, plan);
      expect(r.stillStale).toEqual([]);
      const rerunCalls = ctx.log.records.slice(before);
      const fresh = rerunCalls.filter((c) => !c.replayed).length;
      expect(loadProject(dir).checks.every((c) => c.value.status === "open")).toBe(true);
      writeReport(
        "m3-stale.md",
        [
          "# M3 · 改 t=0 档案的一条 hard_fact → 下游检查全部过期 → 一键重跑",
          "",
          "改动：profiles/tina.md 的已定事实「年龄：18」→「年龄：17」。",
          "",
          "## 过期的检查（sw status）",
          "",
          ...stale.map((s) => `- ${s.check.value.id} ← ${s.changed.join("、")}`),
          "",
          "## 重跑计划（sw rerun --stale）",
          "",
          ...plan.items.map((i) => `- ${i.kind === "bridge" ? "桥" : "线"} ${i.target}：轴 ${i.axes.join("、")} × ${i.n} 次采样 ≈ ${i.calls} 次调用`),
          `- 合计约 ${plan.calls} 次调用；实际 ${rerunCalls.length} 次，其中 ${RECORDING ? fresh : "（回放）"} 次是新请求（提示内容没变的请求复用录制：只有轴 B 的提示里有已定事实）`,
          "",
          `重跑后仍然过期：${r.stillStale.length ? r.stillStale.join("、") : "无"}`,
          "",
          "## 重跑前的报告（sw export report）",
          "",
          reportStale,
        ].join("\n"),
      );
    },
    TIMEOUT,
  );
});

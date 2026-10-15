// M3 operations with a scripted provider: threads + axis E, stale scan and rerun, dispositions, export.
import fs from "node:fs";
import path from "node:path";
import { type Project, loadProject, validateProject } from "@sw/core";
import { CallLog, type ChatRequest, type LlmContext, type LlmProvider } from "@sw/llm";
import { describe, expect, it } from "vitest";
import { REPO, edit, tempCopy } from "../../core/test/helpers";
import {
  acceptCheck,
  addThread,
  checkBridge,
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
} from "../src";

const M3 = path.join(REPO, "fixtures/m3-project");

function scripted(by: Record<string, (req: ChatRequest, task: string) => unknown>, calls: string[] = []): LlmProvider {
  return {
    name: "scripted",
    async chat(req, meta) {
      const task = meta!.key!.split("#")[1]!;
      calls.push(task);
      const kind = task.split(":")[0]!;
      if (!(kind in by)) throw new Error(`no script for ${task}`);
      return { text: "```json\n" + JSON.stringify(by[kind]!(req, task)) + "\n```", model: "m", seconds: 0 };
    },
  };
}
const ctx = (provider: LlmProvider): LlmContext => ({ provider, log: new CallLog(), model: "m" });

const SCRIPT = {
  // the thread contradicts only the Saturday cleanup in the activity room
  "axis-e": (_req: ChatRequest, task: string) =>
    task.endsWith("@s-cleanup")
      ? { conflicts: [{ quote: "周六上午，社团五个人在活动室里大扫除。", category: "spacetime", reason: "钥匙被收走，进不了活动室" }], leaks: [] }
      : { conflicts: [], leaks: [] },
  "axis-a": () => ({ heuristic_answers: [], behaviors: [], judgments: [], boundary_hits: [], cheapest_fix: null }),
  "axis-b": () => ({
    premises: [{ id: "p1", quote: "活动室", premise: "社团有一间活动室", category: "spacetime", character: null, status: "unmentioned", reason: "" }],
    cheapest_fix: null,
  }),
  "axis-c": () => ({ unknowns: [], cheapest_fix: null }),
};

const THREAD = {
  id: "th-key",
  description: "登记当天傍晚，学生会以“设备用电不合规”为由收走了活动室的钥匙，两周之内社团不能进入活动室。",
  planted_at: "s-registered",
  visibility: "character" as const,
  known_by: ["tina"],
};

const withThread = () => {
  const dir = tempCopy(M3);
  addThread(loadProject(dir), THREAD);
  return dir;
};
const statusOf = (p: Project, id: string) => p.checks.find((c) => c.value.id === id)?.value.status;

describe("threads and axis E (U7)", () => {
  it("nodes run from the planting point to the payoff, bridges included", () => {
    const dir = withThread();
    const p = loadProject(dir);
    const th = p.threads[0]!.value;
    expect(threadNodes(p, th).map((n) => n.id)).toEqual(["b12", "s-library", "b23", "s-cleanup"]);
    expect(threadNodes(p, { ...th, payoff_at: "s-library" }).map((n) => [n.id, n.isPayoff])).toEqual([
      ["b12", false],
      ["s-library", true],
    ]);
    // planted inside a bridge: that bridge is not re-read, the next ones are
    expect(threadNodes(p, { ...th, planted_at: "b12#3" }).map((n) => n.id)).toEqual(["s-library", "b23", "s-cleanup"]);
    expect(validateProject(p).filter((i) => i.level === "error")).toEqual([]);
  });

  it("highlights the contradicting node, reports unpaid separately, saves a thread check", async () => {
    const dir = withThread();
    const r = await checkThread(loadProject(dir), ctx(scripted(SCRIPT)), "th-key", { n: 1 });
    const d = r.result.details as { affected: string[]; unpaid: boolean };
    expect(d.affected).toEqual(["s-cleanup"]);
    expect(d.unpaid).toBe(true);
    expect(r.result.score).toBeGreaterThanOrEqual(40);
    expect(r.result.evidence[0]?.verified).toBe(true);
    const p = loadProject(dir);
    const c = p.checks.find((x) => x.value.id === "th-key.E")!.value;
    expect([c.target_kind, c.target]).toEqual(["thread", "th-key"]);
    expect(validateProject(p).filter((i) => i.level === "error")).toEqual([]);
  });
});

describe("stale and rerun (U8)", () => {
  async function seeded() {
    const dir = withThread();
    const c = ctx(scripted(SCRIPT));
    for (const b of ["b01", "b12", "b23"]) await checkBridge(loadProject(dir), c, b, { n: 1, axes: ["A", "B", "C"] });
    await checkThread(loadProject(dir), c, "th-key", { n: 1 });
    return dir;
  }

  it("a fresh run is not stale; editing a t=0 profile hard fact stales every downstream check", async () => {
    const dir = await seeded();
    expect(findStale(loadProject(dir))).toEqual([]);
    edit(path.join(dir, "profiles/tina.md"), "年龄：18", "年龄：17");
    const stale = markStale(loadProject(dir));
    const p = loadProject(dir);
    // every check that read Tina's profile: A for tina on all bridges, B and C on all bridges, the thread
    expect(stale.map((s) => s.check.value.id).sort()).toEqual(
      ["b01.A.tina", "b01.B", "b01.C", "b12.A.tina", "b12.B", "b12.C", "b23.A.tina", "b23.B", "b23.C", "th-key.E"].sort(),
    );
    expect(stale.every((s) => s.changed.includes("profile:tina"))).toBe(true);
    expect(statusOf(p, "b01.A.ancore")).toBe("open");
    expect(statusOf(p, "b01.B")).toBe("stale");
  });

  it("rerun --stale plans the calls, reruns, and leaves nothing stale", async () => {
    const dir = await seeded();
    edit(path.join(dir, "profiles/tina.md"), "年龄：18", "年龄：17");
    const p = loadProject(dir);
    const plan = planRerun(p);
    expect(plan.items.map((i) => `${i.target}:${i.axes.join("")}`).sort()).toEqual(["b01:ABC", "b12:ABC", "b23:ABC", "th-key:E"]);
    // per bridge: A for 2 characters + B + C, one sample each; the thread: 4 nodes
    expect(plan.calls).toBe(3 * 4 + 4);
    const calls: string[] = [];
    const r = await rerunStale(p, ctx(scripted(SCRIPT, calls)), plan);
    expect(r.stillStale).toEqual([]);
    expect(calls).toHaveLength(plan.calls);
    const c = loadProject(dir).checks.find((x) => x.value.id === "b01.B")!.value as unknown as { history: { action: string }[] };
    expect(c.history.map((h) => h.action)).toEqual(["run", "rerun"]);
  });

  it("editing a bridge's text stales only that bridge's checks (修桥)", async () => {
    const dir = await seeded();
    edit(path.join(dir, "bridges/b12.md"), "第二天午休", "第二天下午");
    const ids = findStale(loadProject(dir)).map((s) => s.check.value.id).sort();
    expect(ids).toEqual(["b12.A.ancore", "b12.A.tina", "b12.B", "b12.C", "th-key.E"]);
  });
});

describe("dispositions (U6)", () => {
  async function oneBridge() {
    const dir = tempCopy(M3);
    await checkBridge(loadProject(dir), ctx(scripted(SCRIPT)), "b12", { n: 1, axes: ["A", "B"] });
    return dir;
  }

  it("accept writes a delta at the bridge's start, keeps the check itself fresh, stales the rest", async () => {
    const dir = await oneBridge();
    const r = acceptCheck(loadProject(dir), "b12.A.tina", { justification: "她这次让步是故意的", delta: "从此她愿意先让新人自己看规则" });
    expect(r.t).toBe(1);
    const p = loadProject(dir);
    expect(p.acceptances[0]!.value).toMatchObject({ check: "b12.A.tina", character: "tina", t: 1, delta: "从此她愿意先让新人自己看规则" });
    expect(statusOf(p, "b12.A.tina")).toBe("accepted");
    expect(r.stale.map((s) => s.check.value.id)).toEqual(["b12.B"]);
    expect(validateProject(p).filter((i) => i.level === "error")).toEqual([]);

    revokeAcceptance(p, r.acceptance);
    const q = loadProject(dir);
    expect(q.acceptances).toEqual([]);
    expect(statusOf(q, "b12.A.tina")).toBe("open");
  });

  it("accepting a non-character check needs --character; dismiss needs a reason; history is kept", async () => {
    const dir = await oneBridge();
    expect(() => acceptCheck(loadProject(dir), "b12.B", { justification: "x" })).toThrow(/--character/);
    expect(() => dismissCheck(loadProject(dir), "b12.B", " ")).toThrow(/原因/);
    dismissCheck(loadProject(dir), "b12.B", "这是作者故意留的");
    markFixed(loadProject(dir), "b12.A.ancore", "改了第三段");
    const p = loadProject(dir);
    expect(statusOf(p, "b12.B")).toBe("dismissed");
    const h = (p.checks.find((c) => c.value.id === "b12.A.ancore")!.value as unknown as { history: { action: string; note?: string }[] }).history;
    expect(h.at(-1)).toMatchObject({ action: "fixed", note: "改了第三段" });
  });
});

describe("export (U9)", () => {
  it("manuscript joins locked bridges in t order; report lists open checks; harvest lists unmentioned premises", async () => {
    const dir = tempCopy(M3);
    edit(path.join(dir, "bridges/b23.md"), "status: locked", "status: draft");
    const m = exportManuscript(loadProject(dir));
    expect(m.included).toEqual(["b01", "b12"]);
    expect(m.skipped).toEqual(["b23（draft）"]);
    expect(m.text.indexOf("第五栏写下名字")).toBeLessThan(m.text.indexOf("第二天午休"));

    await checkBridge(loadProject(dir), ctx(scripted(SCRIPT)), "b12", { n: 1, axes: ["B"] });
    const p = loadProject(dir);
    expect(exportReport(p)).toContain("| b12.B | bridge b12 |");
    const h = exportHarvest(p);
    expect(h.count).toBe(1);
    expect(h.text).toContain("社团有一间活动室");
    expect(fs.readFileSync(path.join(dir, "profiles/tina.md"), "utf8")).not.toContain("活动室"); // nothing written back
  });
});

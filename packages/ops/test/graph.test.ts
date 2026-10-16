// Graph mode (D-057–D-065) with a scripted provider: nodes, edges, constraints, axis T / K,
// routes, route outline, stale + rerun.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject, loadProject, validateProject, writeProfileRef } from "@sw/core";
import { CallLog, type ChatRequest, type LlmContext, type LlmProvider } from "@sw/llm";
import { describe, expect, it } from "vitest";
import {
  addConstraint,
  checkConstraints,
  checkEdge,
  checkRoute,
  createEdge,
  createNode,
  createProfile,
  deleteEdge,
  deleteNode,
  editConstraint,
  enableGraphMode,
  findStale,
  listConstraints,
  loadCanvas,
  removeConstraint,
  rerunGraph,
  routeInfo,
  routeOutline,
  saveRoute,
  updateEdge,
  updateNode,
} from "../src";

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
  // the jump to "s3" makes Tina compromise for no reason
  "axis-t": (_req: ChatRequest, task: string) =>
    task.endsWith("->n3")
      ? {
          changes: [{ id: "c1", character: "tina", field: "wants", from: "保住活动室。", to: "把活动室让出去。", verdict: "implausible", rule: "tina.h1", reason: "无理由妥协", needs: "她判断已经不值得坚持" }],
          boundary_hits: [],
          unknown_hits: [],
          cheapest_fix: { where: "终点 · tina.wants", change: "保留：保住活动室。" },
        }
      : { changes: [{ id: "c1", character: "tina", field: "knows", from: null, to: "安可已登记。", verdict: "plausible", rule: null, reason: "" }], boundary_hits: [], unknown_hits: [], cheapest_fix: null },
  "axis-k": (req: ChatRequest) =>
    req.messages.at(-1)!.content.includes("Tina 今年 30 岁")
      ? { issues: [{ kind: "contradiction", a: "tina.f1", b: "tina.f2", reason: "年龄不一致", suggestion: "删掉一条" }] }
      : { issues: [] },
  "axis-a": () => ({ heuristic_answers: [], behaviors: [], judgments: [], boundary_hits: [], cheapest_fix: null }),
  "axis-b": () => ({ premises: [] }),
  "axis-c": () => ({ unknowns: [] }),
  "axis-d": () => ({ fields: [] }),
  extract: () => ({ world_facts: [], char_states: {} }),
};

function setup() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sw-graph-")), "proj");
  initProject(dir, { name: "graph" });
  enableGraphMode(loadProject(dir));
  const p = () => loadProject(dir);
  createProfile(p(), { id: "tina", name: "缇娜", core: "现实判断" });
  addConstraint(p(), "tina", "heuristics", { text: "现实上应该怎么处理？" });
  addConstraint(p(), "tina", "hard_facts", { text: "Tina 今年 18 岁" });
  addConstraint(p(), "world", "world_rules", { text: "学生会周五收回空置活动室" });
  for (const [title, x] of [["开场", 0], ["登记", 300], ["让出", 600]] as const) createNode(p(), { title, x, y: 0 });
  updateNode(p(), "n1", { world_facts: ["社团差一个人"], char_states: { tina: { wants: ["保住活动室。"] } } });
  updateNode(p(), "n2", { char_states: { tina: { knows: ["安可已登记。"], wants: ["保住活动室。"] } } });
  updateNode(p(), "n3", { char_states: { tina: { wants: ["把活动室让出去。"] } } });
  createEdge(p(), "n1", "n2", "安可来了，签了字");
  createEdge(p(), "n2", "n3");
  return { dir, p };
}

describe("graph mode", () => {
  it("builds a valid project from the canvas operations", () => {
    const { p } = setup();
    const proj = p();
    expect(proj.config.mode).toBe("graph");
    expect(validateProject(proj).filter((i) => i.level === "error")).toEqual([]);
    // t is derived from the edges (D-058)
    expect(proj.snapshots.map((s) => [s.value.id, s.value.t]).sort()).toEqual([["n1", 0], ["n2", 1], ["n3", 2]]);
    expect(proj.config.lanes.map((l) => l.id)).toEqual(["world", "tina"]);
    expect(proj.snapshots.find((s) => s.value.id === "n2")!.value.lanes).toEqual(["world", "tina"]);
    expect(loadCanvas(proj).nodes.n2).toEqual({ x: 300, y: 0 });
  });

  it("refuses cycles, self-loops and duplicate edges", () => {
    const { p } = setup();
    expect(() => createEdge(p(), "n3", "n1")).toThrow(/环/);
    expect(() => createEdge(p(), "n1", "n1")).toThrow(/自己/);
    expect(() => createEdge(p(), "n1", "n2")).toThrow(/已经有/);
    // branching is fine (D-057)
    createEdge(p(), "n1", "n3");
    expect(p().snapshots.find((s) => s.value.id === "n3")!.value.t).toBe(2);
  });

  it("axis T on an edge without prose; route score is the weakest edge; outline export", async () => {
    const { p, dir } = setup();
    const calls: string[] = [];
    const c = ctx(scripted(SCRIPT, calls));
    const r = await checkEdge(p(), c, "e-n2-n3", { n: 1 });
    expect(r.results.map((x) => x.axis)).toEqual(["T"]);
    expect(r.results[0]!.score).toBe(63); // one implausible change, weight 3
    expect(r.results[0]!.notes.join()).toContain("还没有情节概述");
    // the prompt carries the world rule and the namespaced heuristics
    const route = saveRoute(p(), { name: "主线", nodes: ["n1", "n2", "n3"] });
    let info = routeInfo(p(), route);
    expect(info.complete).toBe(false);
    info = await checkRoute(p(), c, route, {});
    // only the unchecked edge runs (3 samples by default); the checked one is reused
    expect(calls.filter((t) => t.startsWith("axis-t"))).toEqual(["axis-t:n2->n3", "axis-t:n1->n2", "axis-t:n1->n2", "axis-t:n1->n2"]);
    expect(info.complete).toBe(true);
    expect(info.score).toBe(63);
    expect(info.weakest).toBe("e-n2-n3");
    const out = routeOutline(p(), route);
    expect(out.file).toBe("exports/r1.outline.md");
    expect(fs.readFileSync(path.join(dir, out.file), "utf8")).toContain("情节：安可来了，签了字");
    expect(out.text).toContain("路线偏差：63（最弱一环：e-n2-n3）");
    expect(out.text).toContain("- 缇娜：想要 把活动室让出去。");
  });

  it("an edge with prose also runs the text axes", async () => {
    const { p } = setup();
    updateEdge(p(), "e-n1-n2", { text: "安可在第五栏写下名字。Tina 签了字。" });
    const r = await checkEdge(p(), ctx(scripted(SCRIPT)), "e-n1-n2", { n: 1 });
    expect(r.results.map((x) => x.axis).sort()).toEqual(["A", "B", "C", "D", "T"]);
  });

  it("constraints: add / edit / remove, axis K, and edge checks go stale", async () => {
    const { p } = setup();
    const c = ctx(scripted(SCRIPT));
    await checkEdge(p(), c, "e-n1-n2", { n: 1 });
    expect(findStale(p())).toEqual([]);
    const key = addConstraint(p(), "tina", "hard_facts", { text: "Tina 今年 30 岁", secret: true });
    expect(key).toBe("tina.f2");
    const k = await checkConstraints(p(), c, { changed: [key], n: 1 });
    expect(k.result.score).toBe(63);
    expect(k.saved.file).toBe("checks/constraints/K.yaml");
    // the profile changed, so the edge check is stale
    expect(findStale(p()).map((s) => s.check.value.id)).toEqual(["e-n1-n2.T"]);
    const r = await rerunGraph(p(), c, (fresh) => checkConstraints(fresh, c));
    expect(r.edges).toEqual(["e-n1-n2"]);
    expect(findStale(p())).toEqual([]);

    editConstraint(p(), "tina", "hard_facts", "f2", { text: "Tina 今年 18 岁，生日在冬天" });
    const tina = listConstraints(p()).find((o) => o.owner === "tina")!;
    expect(tina.fields.hard_facts!.map((e) => [e.id, e.text, !!e.secret])).toEqual([["f1", "Tina 今年 18 岁", false], ["f2", "Tina 今年 18 岁，生日在冬天", true]]);
    removeConstraint(p(), "tina", "hard_facts", "f1");
    // ids don't shift when an earlier entry is removed
    expect(listConstraints(p()).find((o) => o.owner === "tina")!.fields.hard_facts!.map((e) => e.id)).toEqual(["f2"]);
    expect(listConstraints(p()).find((o) => o.owner === "world")!.fields.world_rules!.map((e) => e.id)).toEqual(["w1"]);
  });

  it("external profiles: imported entries are read-only, additions go to the ref file's extra", () => {
    const { p, dir } = setup();
    const page = path.join(path.dirname(dir), "villy.md");
    fs.writeFileSync(page, "---\nid: villy\ntitle: Villy\n---\n\n## 留白\n- 〔留白〕家族结构。\n");
    const before = fs.readFileSync(page, "utf8");
    writeProfileRef(dir, page, "villy", "oc-wiki");
    const key = addConstraint(p(), "villy", "boundaries", { text: "怀疑在场景中不可见" });
    expect(key).toBe("villy.b1");
    const villy = listConstraints(p()).find((o) => o.owner === "villy")!;
    expect(villy.external).toBe(path.resolve(page));
    expect(villy.fields.unknowns!.map((e) => e.editable)).toEqual([false]);
    expect(villy.fields.boundaries!.map((e) => [e.text, e.editable])).toEqual([["怀疑在场景中不可见", true]]);
    expect(() => removeConstraint(p(), "villy", "unknowns", "u1")).toThrow(/只读/);
    expect(fs.readFileSync(page, "utf8")).toBe(before);
    expect(fs.readFileSync(path.join(dir, "profiles/villy.ref.yaml"), "utf8")).toContain("怀疑在场景中不可见");
  });

  it("deleting a node removes its edges, their checks and routes through it", async () => {
    const { p, dir } = setup();
    await checkEdge(p(), ctx(scripted(SCRIPT)), "e-n2-n3", { n: 1 });
    saveRoute(p(), { name: "x", nodes: ["n1", "n2", "n3"] });
    deleteNode(p(), "n3");
    const proj = p();
    expect(proj.bridges.map((b) => b.value.id)).toEqual(["e-n1-n2"]);
    expect(fs.existsSync(path.join(dir, "checks/e-n2-n3"))).toBe(false);
    expect(loadCanvas(proj).routes).toEqual([]);
    deleteEdge(proj, "e-n1-n2");
    expect(validateProject(p()).filter((i) => i.level === "error")).toEqual([]);
  });
});

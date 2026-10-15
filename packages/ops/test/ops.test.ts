// M2 operations with a scripted provider. Real-model behaviour is covered by m2-acceptance.test.ts.
import fs from "node:fs";
import path from "node:path";
import { type Snapshot, loadProject, updateObjectFile, validateProject } from "@sw/core";
import { AxisDOutput, DERIVED_PREFIX, diffRows, gapBetween, scoreAxisD, stateItems } from "@sw/checks";
import { CallLog, type ChatRequest, type LlmContext, type LlmProvider, requestKey } from "@sw/llm";
import { describe, expect, it } from "vitest";
import { MINIMAL, edit, tempCopy } from "../../core/test/helpers";
import {
  adoptDerived,
  approveSnapshot,
  castOf,
  characterBriefs,
  checkBridge,
  draftBridge,
  extractDerived,
  extractInputFor,
  generateCandidates,
  graftSnapshot,
  indistinctDims,
  outlineBridge,
} from "../src";

type Script = Record<string, unknown | ((req: ChatRequest) => unknown)>;

/** Answers by task name (the part of the recording key before the first ":"). Records every request. */
function scripted(by: Script, seen: { task: string; req: ChatRequest }[] = []): LlmProvider {
  return {
    name: "scripted",
    async chat(req, meta) {
      const full = meta!.key!.split("#")[1]!;
      const task = full.split(":")[0]!;
      seen.push({ task: full, req });
      if (!(task in by)) throw new Error(`no script for ${task}`);
      const v = by[task];
      const out = typeof v === "function" ? (v as (r: ChatRequest) => unknown)(req) : v;
      return { text: typeof out === "string" ? out : "```json\n" + JSON.stringify(out) + "\n```", model: "m", seconds: 0 };
    },
  };
}
const ctx = (provider: LlmProvider): LlmContext => ({ provider, log: new CallLog(), model: "m" });

const TEXT = "活动室里，Tina 把表格推过去。安可在第五栏写下名字，说想试试那台设备。";
const DERIVED = {
  world_facts: ["安可被登记为 ILLUSION 的第五名正式成员。"],
  char_states: {
    tina: { knows: ["安可已登记。"], wants: ["保住活动室。"], feels: "待观察。", location: "活动室", relationships: {} },
    ancore: { knows: ["社团的设备能进入模拟的人生。"], wants: ["体验另一种人生。"], feels: "好奇。", location: "活动室", relationships: {} },
  },
};
const allMatched = (req: ChatRequest) => {
  const keys = [...req.messages.at(-1)!.content.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1]!).filter((k) => !k.startsWith(DERIVED_PREFIX));
  return { items: keys.map((key) => ({ key, status: "matched", derived: [], reason: "" })), cheapest_fix: null };
};
const SCRIPT: Script = {
  outline: { beats: ["Villy 带人进门。", "Tina 讲清要求。", "安可看设备，登记。"], touches_unknowns: ["ancore.u1", "made.up"] },
  draft: TEXT,
  extract: DERIVED,
  "axis-a": { heuristic_answers: [], behaviors: [], judgments: [], boundary_hits: [], cheapest_fix: null },
  "axis-b": { premises: [], cheapest_fix: null },
  "axis-c": { unknowns: [], cheapest_fix: null },
  "axis-d": allMatched,
};

describe("axis F (gap, computed in code)", () => {
  const p = loadProject(MINIMAL);
  const [a, b] = ["s-start", "s-registered"].map((id) => p.snapshots.find((s) => s.value.id === id)!.value) as [Snapshot, Snapshot];
  it("is 0 for identical snapshots and grows with changes", () => {
    expect(gapBetween(a, a).score).toBe(0);
    const g = gapBetween(a, b, p.config);
    expect(g.score).toBe(53);
    expect(g.suggestAddPoint).toBe(false);
    expect(g.changes.find((c) => c.character === "ancore" && c.field === "wants")?.units).toBe(1);
  });
  it("counts a character entering the scene", () => {
    const c = { ...b, char_states: { ...b.char_states, villy: { knows: [], wants: [], relationships: {} } } };
    expect(gapBetween(b, c).changes.some((x) => x.field === "lane" && x.character === "villy")).toBe(true);
  });
});

describe("axis D (diff from structure)", () => {
  const p = loadProject(MINIMAL);
  const target = p.snapshots.find((s) => s.value.id === "s-registered")!.value;
  const t = stateItems(target);
  const d = stateItems(DERIVED, DERIVED_PREFIX);
  it("lists every target field once, extras after; conflict > missing > extra", () => {
    const out = AxisDOutput.parse({
      items: t.map((x) => ({
        key: x.key,
        status: x.key === "ancore.wants.1" ? "conflict" : x.key === "world.2" ? "missing" : "matched",
        derived: x.key === "ancore.wants.1" ? ["d:ancore.wants.1"] : [],
      })),
    });
    const rows = diffRows(out, t, d);
    expect(rows.filter((r) => r.target).map((r) => r.key)).toEqual(t.map((x) => x.key));
    expect(rows.find((r) => r.key === "ancore.wants.1")?.status).toBe("conflict");
    // derived items not claimed by a matched/conflict row are extras (harvest)
    expect(rows.filter((r) => r.status === "extra").length).toBe(d.length - 1);
    const conflictOnly = scoreAxisD(AxisDOutput.parse({ items: t.map((x) => ({ key: x.key, status: x.key === "ancore.wants.1" ? "conflict" : "matched" })) }), t, []);
    const missingOnly = scoreAxisD(AxisDOutput.parse({ items: t.map((x) => ({ key: x.key, status: x.key === "ancore.wants.1" ? "missing" : "matched" })) }), t, []);
    expect(conflictOnly).toBeGreaterThan(missingOnly);
    expect(missingOnly).toBeGreaterThanOrEqual(35);
    expect(scoreAxisD(AxisDOutput.parse({ items: t.map((x) => ({ key: x.key, status: "matched" })) }), t, d)).toBeLessThan(35);
  });
  it("an unjudged target field is reported, not scored", () => {
    const rows = diffRows(AxisDOutput.parse({ items: [] }), t, []);
    expect(rows.every((r) => r.status === "unjudged")).toBe(true);
    expect(scoreAxisD(AxisDOutput.parse({ items: [] }), t, [])).toBe(0);
  });
});

describe("extraction never sees the target (spec §5-D.1)", () => {
  it("prompt has no target-only content, and editing the target does not change the request", async () => {
    const dir = tempCopy(MINIMAL);
    const seen: { task: string; req: ChatRequest }[] = [];
    const run = async () => {
      const p = loadProject(dir);
      await extractDerived(ctx(scripted(SCRIPT, seen)), extractInputFor(p, { from: "s-start", text: TEXT }));
    };
    await run();
    edit(path.join(dir, "snapshots/t1-registered.md"), "亲自体验另一种人生。", "尽快离开这个社团。");
    await run();
    const prompt = seen[0]!.req.messages.map((m) => m.content).join("\n");
    for (const targetOnly of ["安可登记为第五人", "她看起来最不麻烦", "s-registered", "待观察"]) expect(prompt).not.toContain(targetOnly);
    expect(requestKey(seen[0]!.req)).toBe(requestKey(seen[1]!.req));
  });
});

describe("secret hard facts (D-033)", () => {
  it("are withheld from generation briefs", () => {
    const dir = tempCopy(MINIMAL);
    edit(path.join(dir, "profiles/ancore.md"), "unknowns:", "hard_facts:\n  - { text: 本应姓方。, secret: true }\n  - 灰绿色头发。\nunknowns:");
    const p = loadProject(dir);
    const s = p.snapshots.find((x) => x.value.id === "s-start")!.value;
    const b = characterBriefs(p, castOf(p, s), 0);
    expect(b.text).toContain("灰绿色头发");
    expect(b.text).not.toContain("本应姓方");
    expect((b.injected.ancore as { secret_withheld: number }).secret_withheld).toBe(1);
  });
});

describe("bridge: outline → draft → checks (U5)", () => {
  it("writes outline, text, versions, derived snapshot and checks; project stays valid", async () => {
    const dir = tempCopy(MINIMAL);
    const c = ctx(scripted(SCRIPT));
    const o = await outlineBridge(loadProject(dir), c, "b-fifth");
    expect(o.touches).toEqual(["ancore.u1"]); // unknown keys outside the scope are dropped
    let br = loadProject(dir).bridges[0]!.value;
    expect(br.status).toBe("outline");
    expect(br.outline).toHaveLength(3);

    const d1 = await draftBridge(loadProject(dir), c, "b-fifth");
    expect(d1.version).toBeUndefined();
    expect(d1.notes[0]).toMatch(/没有声音样本/);
    const d2 = await draftBridge(loadProject(dir), c, "b-fifth");
    expect(d2.version?.v).toBe(1);
    expect(fs.existsSync(path.join(dir, "bridges/.versions/b-fifth/v1.md"))).toBe(true);

    const r = await checkBridge(loadProject(dir), c, "b-fifth", { n: 1 });
    expect(r.extracted).toBe(true);
    expect(r.run.results.map((x) => `${x.axis}${x.character ?? ""}`).sort()).toEqual(["Aancore", "Atina", "B", "C", "D"]);
    const p = loadProject(dir);
    br = p.bridges[0]!.value;
    expect(br.text).toBe(TEXT);
    expect(br.status).toBe("draft");
    expect(br.versions).toHaveLength(1);
    expect(br.derived_snapshot?.origin).toBe("llm");
    expect(br.checks).toContain("b-fifth.D");
    expect(p.checks.map((x) => x.value.id).sort()).toEqual(["b-fifth.A.ancore", "b-fifth.A.tina", "b-fifth.B", "b-fifth.C", "b-fifth.D"]);
    expect(validateProject(p).filter((i) => i.level === "error")).toEqual([]);

    // unchanged text: the stored derived snapshot is reused, no second extraction
    const again = await checkBridge(p, c, "b-fifth", { n: 1, axes: ["D"] });
    expect(again.extracted).toBe(false);
  });

  it("refuses a bridge whose endpoint is not approved", async () => {
    const dir = tempCopy(MINIMAL);
    edit(path.join(dir, "snapshots/t1-registered.md"), "status: approved", "status: sketch");
    await expect(outlineBridge(loadProject(dir), ctx(scripted(SCRIPT)), "b-fifth")).rejects.toThrow(/approved/);
  });

  it("adopt makes the derived snapshot the target and keeps the old version", async () => {
    const dir = tempCopy(MINIMAL);
    updateObjectFile(dir, "bridges/start__registered.md", { status: "draft", derived_snapshot: DERIVED }, TEXT);
    const r = adoptDerived(loadProject(dir), "b-fifth");
    const p = loadProject(dir);
    const to = p.snapshots.find((s) => s.value.id === "s-registered")!.value;
    expect(to.origin).toBe("derived");
    expect(to.char_states.ancore?.wants).toEqual(["体验另一种人生。"]);
    expect(fs.readFileSync(path.join(dir, r.version.path), "utf8")).toContain("亲自体验另一种人生");
    expect(validateProject(p).filter((i) => i.level === "error")).toEqual([]);
  });
});

describe("candidates (U3)", () => {
  const cand = (title: string, push: string, conflict: string) => ({
    title,
    dims: { 谁推动: push, 冲突在哪: conflict },
    world_facts: ["还差一个人。"],
    char_states: { tina: { knows: [], wants: ["保住活动室。"] }, stranger: { knows: [] } },
    touches_unknowns: ["ancore.u2", "nope"],
    rationale: title,
  });
  const script = {
    candidates: {
      candidates: [cand("Villy 拉人", "Villy", "Tina 嫌他随便"), cand("安可自己来", "安可", "设备要不要给外人用"), cand("Tina 去找", "Tina", "截止日期")],
    },
  };

  it("writes sketches to branches/, then approve moves one and prunes the rest; graft brings one back", async () => {
    const dir = tempCopy(MINIMAL);
    const r = await generateCandidates(loadProject(dir), ctx(scripted(script)), { from: "s-start", to: "s-registered", dims: ["谁推动", "冲突在哪"] });
    expect(r.candidates).toHaveLength(3);
    expect(r.indistinct).toEqual([]);
    expect(r.candidates[0]!.t).toBe(0.5);
    expect(r.candidates[0]!.touches).toEqual(["ancore.u2"]);
    let p = loadProject(dir);
    expect(p.branchSnapshots.map((s) => [s.value.status, s.value.origin])).toEqual(Array(3).fill(["sketch", "llm-candidate"]));
    expect(Object.keys(p.branchSnapshots[0]!.value.char_states)).toEqual(["tina"]); // off-lane characters dropped

    const chosen = r.candidates[1]!.id;
    const a = approveSnapshot(p, chosen);
    expect(a.pruned).toHaveLength(2);
    expect(a.warnings[0]).toMatch(/b-fifth 跨过了/);
    p = loadProject(dir);
    expect(p.snapshots.find((s) => s.value.id === chosen)?.value.status).toBe("approved");
    expect(p.branchSnapshots.every((s) => s.value.pruned)).toBe(true);
    // the old bridge now spans a point: validation says so
    expect(validateProject(p).some((i) => i.level === "error" && /只能连相邻快照/.test(i.message))).toBe(true);

    graftSnapshot(p, r.candidates[0]!.id);
    p = loadProject(dir);
    const g = p.snapshots.find((s) => s.value.id === r.candidates[0]!.id)!.value;
    expect([g.status, g.pruned]).toEqual(["sketch", undefined]);
  });

  it("flags candidates that do not differ on a dimension", () => {
    const x = indistinctDims(
      [
        { id: "a", dims: { 谁推动: "Villy。" } },
        { id: "b", dims: { 谁推动: "Villy" } },
        { id: "c", dims: { 谁推动: "安可" } },
      ],
      ["谁推动"],
    );
    expect(x).toEqual([{ dim: "谁推动", ids: ["a", "b"] }]);
  });

  it("rejects non-adjacent or non-approved endpoints and bad counts", async () => {
    const p = loadProject(MINIMAL);
    const c = ctx(scripted(script));
    await expect(generateCandidates(p, c, { from: "s-start", to: "s-registered", dims: ["x"], k: 5 })).rejects.toThrow(/2 到 4/);
    await expect(generateCandidates(p, c, { from: "s-registered", to: "s-start", dims: ["x"] })).rejects.toThrow(/早于/);
  });
});

describe("updateObjectFile", () => {
  it("keeps the author's comments and unknown keys", () => {
    const dir = tempCopy(MINIMAL);
    const f = path.join(dir, "profiles/ancore.md");
    updateObjectFile(dir, "profiles/ancore.md", { my_field: 1 });
    const s = fs.readFileSync(f, "utf8");
    expect(s).toContain("# heuristics 故意留空");
    expect(s).toContain("my_field: 1");
    expect(() => updateObjectFile(dir, "../outside.md", {})).toThrow(/项目外/);
  });
});

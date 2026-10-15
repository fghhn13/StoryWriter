// Scoring and orchestration with a scripted provider. Real-model behaviour is covered by the
// recorded run in m1-acceptance.test.ts.
import fs from "node:fs";
import path from "node:path";
import { loadProject, parseMarkdownFile } from "@sw/core";
import { CallLog, type LlmProvider } from "@sw/llm";
import { describe, expect, it } from "vitest";
import {
  AxisAOutput,
  AxisBOutput,
  AxisCOutput,
  NO_HEURISTICS_NOTE,
  quoteInText,
  renderReport,
  runTextChecks,
  saturate,
  scoreAxisA,
  scoreAxisB,
  scoreAxisC,
  unknownScope,
} from "../src";

const MINIMAL = path.resolve(__dirname, "../../../fixtures/minimal-project");
const scene = (name: string) => parseMarkdownFile(fs.readFileSync(path.join(MINIMAL, "scenes", name), "utf8")).body.trim();
const TEXT = scene("fifth-person.planted.md");

describe("quotes", () => {
  it("match verbatim slices, tolerant of whitespace and quote style", () => {
    expect(quoteInText("“好，你说了算。”她说", TEXT)).toBe(true);
    expect(quoteInText('"好，你说了算。" 她说', TEXT)).toBe(true);
    expect(quoteInText("好，你说的算", TEXT)).toBe(false);
    expect(quoteInText("", TEXT)).toBe(false);
  });
});

describe("axis A scoring (from structure, spec §3.2)", () => {
  const base = AxisAOutput.parse({
    behaviors: [
      { id: "x1", quote: "好，你说了算。", action: "同意造假" },
      { id: "x2", quote: "我懂你。", action: "替人解释" },
      { id: "x3", quote: "编造的引文", action: "-" },
    ],
  });
  it("saturates; conforming behaviour does not dilute", () => {
    expect(saturate(0)).toBe(0);
    expect(saturate(2)).toBe(49);
    expect(saturate(4)).toBe(74);
    const out = { ...base, judgments: [
      { behavior: "x1", rule: "h4", direction: "opposite" as const, severity: 2, reason: "" },
      { behavior: "x1", rule: "h1", direction: "opposite" as const, severity: 3, reason: "" },
      { behavior: "x2", rule: "t3", direction: "opposite" as const, severity: 2, reason: "" },
      { behavior: "x2", rule: "h6", direction: "same" as const, reason: "" },
    ] };
    // x1 counts once at its max severity (3) + x2 (2) = 5
    expect(scoreAxisA(out, TEXT)).toBe(saturate(5));
  });
  it("ignores fabricated quotes", () => {
    const out = { ...base, judgments: [{ behavior: "x3", rule: "h4", direction: "opposite" as const, severity: 3, reason: "" }] };
    expect(scoreAxisA(out, TEXT)).toBe(0);
  });
  it("a boundary hit lifts the score to at least 80", () => {
    expect(scoreAxisA({ ...base, boundary_hits: [{ rule: "b1", quote: "我懂你。", reason: "" }] }, TEXT)).toBe(80);
  });
});

describe("axis B / C scoring", () => {
  it("B weighs knowledge leaks most", () => {
    const mk = (category: "knowledge" | "object") =>
      AxisBOutput.parse({ premises: [{ id: "p", quote: "我懂你。", premise: "-", category, status: "false" }] });
    expect(scoreAxisB(mk("knowledge"), TEXT)).toBe(saturate(3));
    expect(scoreAxisB(mk("object"), TEXT)).toBe(saturate(1));
  });

  it("C: explicit 100, hint 50, halved if not load-bearing, permanent explicit 100", () => {
    const p = loadProject(MINIMAL);
    const scope = unknownScope(p, ["ancore", "tina"]);
    expect(scope.map((s) => s.key)).toEqual(["ancore.u1", "ancore.u2", "ancore.u3", "tina.u1", "tina.u2"]);
    const q = "我懂你。";
    const one = (rule: string, answer_level: "explicit" | "strong_hint", load_bearing: boolean) =>
      scoreAxisC(AxisCOutput.parse({ unknowns: [{ rule, answer_level, quote: q, load_bearing }] }), scope, TEXT);
    expect(one("tina.u1", "explicit", true)).toBe(100);
    expect(one("tina.u1", "explicit", false)).toBe(50);
    expect(one("tina.u1", "strong_hint", false)).toBe(25);
    expect(one("ancore.u1", "explicit", false)).toBe(100); // permanent
    expect(one("nobody.u9", "explicit", true)).toBe(0); // not in scope
  });
});

/** Answers by task name; every sample gets the same canned output. */
function scripted(by: Record<string, unknown>): LlmProvider {
  return {
    name: "scripted",
    async chat(_req, meta) {
      const task = meta!.key!.split("#")[1]!;
      if (!(task in by)) throw new Error(`no script for ${task}`);
      return { text: "```json\n" + JSON.stringify(by[task]) + "\n```", model: "m", seconds: 0 };
    },
  };
}

describe("runTextChecks", () => {
  it("runs A per character, B and C once; caps 安可's confidence; renders the four questions", async () => {
    const p = loadProject(MINIMAL);
    const ctx = {
      log: new CallLog(),
      model: "m",
      provider: scripted({
        "axis-a:tina": {
          heuristic_answers: [{ rule: "h4", answer: "造假会让社团失去活动室，不值得妥协，她会拒绝。" }],
          behaviors: [{ id: "x1", quote: "“好，你说了算。”她说", action: "同意改日期" }],
          judgments: [{ behavior: "x1", rule: "h4", direction: "opposite", severity: 3, reason: "无理由妥协" }],
          cheapest_fix: { quote: "“好，你说了算。”她说", rewrite: "“不行。”她说", resolves: ["x1"] },
        },
        "axis-a:ancore": { behaviors: [{ id: "x1", quote: "说了一半。", action: "回答" }], judgments: [] },
        "axis-b": { premises: [] },
        "axis-c": { unknowns: [{ rule: "tina.u1", answer_level: "none", quote: null, load_bearing: false }] },
      }),
    };
    const run = await runTextChecks(p, ctx, { text: TEXT, from: "s-start", n: 3 });
    expect(run.characters.sort()).toEqual(["ancore", "tina"]);
    expect(ctx.log.records).toHaveLength(12);
    const tina = run.results.find((r) => r.character === "tina")!;
    expect(tina.score).toBe(saturate(3));
    expect(tina.confidence).toBe(1);
    const ancore = run.results.find((r) => r.character === "ancore")!;
    expect(ancore.confidence).toBeLessThanOrEqual(0.3);
    expect(ancore.notes).toContain(NO_HEURISTICS_NOTE);
    const c = run.results.find((r) => r.axis === "C")!;
    expect(c.notes.join()).toContain("漏判");

    const md = renderReport(p, run);
    expect(md).toContain("| 哪里 | 依据 | 本来应该 | 说明 |");
    expect(md).toContain("h4：值得妥协吗？");
    expect(md).toContain("造假会让社团失去活动室");
    expect(md).toContain("**最便宜的修补**：把「“好，你说了算。”她说」改成「“不行。”她说」");
  });

  it("injects 留白 and the start state into every prompt", async () => {
    const p = loadProject(MINIMAL);
    const seen: string[] = [];
    const ctx = {
      log: new CallLog(),
      model: "m",
      provider: {
        name: "spy",
        async chat(req: { messages: { content: string }[] }) {
          seen.push(req.messages.map((m) => m.content).join("\n"));
          return { text: '{"premises":[],"unknowns":[],"behaviors":[],"judgments":[]}', model: "m", seconds: 0 };
        },
      } as LlmProvider,
    };
    await runTextChecks(p, ctx, { text: TEXT, from: "s-start", n: 1, characters: ["tina"] });
    for (const prompt of seen) {
      expect(prompt).toContain("留白不填");
      expect(prompt).toContain("最终是否离开 Alice");
    }
    expect(seen[0]).toContain("保住活动室");
  });
});

// M1 acceptance (spec §10) replayed from recorded real-model outputs in fixtures/recordings/m1.
// Re-record with: SW_LLM_MODE=record sw -p fixtures/minimal-project check <scene> --recordings fixtures/recordings/m1 [--runs 3]
import fs from "node:fs";
import path from "node:path";
import { loadProject, parseMarkdownFile } from "@sw/core";
import { CallLog, RecordingProvider } from "@sw/llm";
import { describe, expect, it } from "vitest";
import { NO_HEURISTICS_NOTE, NO_HEURISTICS_CAP, runTextChecks } from "../src";

const REPO = path.resolve(__dirname, "../../..");
const MINIMAL = path.join(REPO, "fixtures/minimal-project");
const REC = path.join(REPO, "fixtures/recordings/m1");
const MODEL = "claude-opus-5-5";

const scene = (name: string) => {
  // recordings are keyed on LF text; a CRLF working copy must not change the request
  const src = parseMarkdownFile(fs.readFileSync(path.join(MINIMAL, "scenes", name), "utf8").replace(/\r\n/g, "\n"));
  return { text: src.body.trim(), ...(src.data as { from: string; characters: string[] }) };
};
const replay = (runTag?: string) => ({ provider: new RecordingProvider(undefined, REC, "replay"), log: new CallLog(), model: MODEL, runTag });
const run = (name: string, runTag?: string) => {
  const s = scene(name);
  return runTextChecks(loadProject(MINIMAL), replay(runTag), { text: s.text, from: s.from, characters: s.characters, n: 3 });
};

describe.skipIf(!fs.existsSync(REC))("M1 acceptance (recorded)", () => {
  it("1. axis A catches both planted Tina deviations, quoting the text", async () => {
    const r = await run("fifth-person.planted.md");
    const tina = r.results.find((x) => x.axis === "A" && x.character === "tina")!;
    const opposite = tina.evidence.filter((e) => e.direction === "opposite" && e.verified);
    expect(opposite.some((e) => e.quote.includes("你说了算"))).toBe(true);
    expect(opposite.some((e) => e.quote.includes("我懂你") || e.quote.includes("你其实是"))).toBe(true);
    expect(tina.score).toBeGreaterThanOrEqual(40);
  });

  it("1b. the clean scene scores lower for Tina than the planted one", async () => {
    const clean = (await run("fifth-person.clean.md")).results.find((x) => x.axis === "A" && x.character === "tina")!;
    const planted = (await run("fifth-person.planted.md")).results.find((x) => x.axis === "A" && x.character === "tina")!;
    expect(clean.score).toBeLessThan(planted.score);
  });

  it("2. axis C reports 安可's lineage as an explicitly filled unknown", async () => {
    const c = (await run("fifth-person.leak.md")).results.find((x) => x.axis === "C")!;
    const hit = c.evidence.find((e) => e.rule === "ancore.u1" && e.verified);
    expect(hit?.note).toMatch(/^明示/);
    expect(c.score).toBeGreaterThanOrEqual(50);
  });

  it("3. axis A on 安可 flags limited confidence (no heuristics)", async () => {
    const a = (await run("fifth-person.clean.md")).results.find((x) => x.axis === "A" && x.character === "ancore")!;
    expect(a.notes).toContain(NO_HEURISTICS_NOTE);
    expect(a.confidence).toBeLessThanOrEqual(NO_HEURISTICS_CAP);
  });

  it("4. three runs of the same input stay within ±10", async () => {
    const runs = await Promise.all([undefined, "run2", "run3"].map((t) => run("fifth-person.planted.md", t)));
    for (let i = 0; i < runs[0]!.results.length; i++) {
      const scores = runs.map((r) => r.results[i]!.score);
      expect(Math.max(...scores) - Math.min(...scores), `${runs[0]!.results[i]!.axis}/${runs[0]!.results[i]!.character}: ${scores}`).toBeLessThanOrEqual(20);
    }
  });
});

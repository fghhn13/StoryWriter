import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  CallLog,
  type ChatRequest,
  type LlmProvider,
  RecordingProvider,
  callStructured,
  extractJson,
  median,
  normalizeBaseUrl,
  parseEnvFile,
  render,
  sampleStructured,
  spreadConfidence,
} from "../src";
import type { Template } from "../src";

const TPL: Template = { id: "t", version: 1, system: "系统 {{x}}", user: "用户 {{x}}", file: "-" };

/** Fake provider that answers from a queue and records what it saw. */
function fake(answers: string[]): LlmProvider & { seen: ChatRequest[] } {
  const seen: ChatRequest[] = [];
  return {
    name: "fake",
    seen,
    async chat(req) {
      seen.push(req);
      const text = answers.shift();
      if (text === undefined) throw new Error("fake provider exhausted");
      return { text, model: req.model, seconds: 0.01, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
    },
  };
}
const ctx = (provider: LlmProvider) => ({ provider, log: new CallLog(), model: "m" });

describe("config (port of api.py)", () => {
  it("parses dotenv and labelled formats", () => {
    expect(parseEnvFile("# c\nGPTSAPI_API_KEY=sk-1 # note\nexport GPTSAPI_MODEL='claude-opus-5-5'\n")).toEqual({
      GPTSAPI_API_KEY: "sk-1",
      GPTSAPI_MODEL: "claude-opus-5-5",
    });
    expect(parseEnvFile("Base URL: https://api2.gptsapi.net\nAPI Key: sk-2\nModel: x\n")).toEqual({
      GPTSAPI_BASE_URL: "https://api2.gptsapi.net",
      GPTSAPI_API_KEY: "sk-2",
      GPTSAPI_MODEL: "x",
    });
    expect(() => parseEnvFile("whatever line")).toThrow();
  });

  it("normalises the base URL to exactly one /v1", () => {
    expect(normalizeBaseUrl("https://api2.gptsapi.net")).toBe("https://api2.gptsapi.net/v1");
    expect(normalizeBaseUrl("https://api2.gptsapi.net/v1/")).toBe("https://api2.gptsapi.net/v1");
    expect(() => normalizeBaseUrl("http://api2.gptsapi.net")).toThrow();
    expect(() => normalizeBaseUrl("https://api2.gptsapi.net/v1/chat/completions")).toThrow();
  });
});

describe("structured output", () => {
  const schema = z.object({ a: z.number() });

  it("extracts JSON from fences or bare text", () => {
    expect(extractJson('说明\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('好的：{"a":2} 完毕')).toEqual({ a: 2 });
  });

  it("renders templates and refuses unknown variables", () => {
    expect(render("你好 {{ name }}", { name: "Tina" })).toBe("你好 Tina");
    expect(() => render("{{nope}}", {})).toThrow(/nope/);
  });

  it("repairs once, then succeeds", async () => {
    const p = fake(['{"a":"x"}', '{"a":3}']);
    const c = ctx(p);
    expect(await callStructured(c, { task: "t", template: TPL, vars: { x: "1" }, schema, summary: "s" })).toEqual({ a: 3 });
    expect(p.seen[1]!.messages.at(-1)!.content).toContain("不符合要求的 JSON");
    expect(c.log.records.map((r) => r.attempt)).toEqual([1, 2]);
    expect(c.log.records[0]!.error).toBeTruthy();
  });

  it("gives up after the repair turn", async () => {
    await expect(callStructured(ctx(fake(["no", "still no"])), { task: "t", template: TPL, vars: { x: "1" }, schema, summary: "s" })).rejects.toThrow(/两次/);
  });
});

describe("multi-sampling", () => {
  it("median, spread confidence, representative sample", async () => {
    const p = fake(['{"a":10}', '{"a":30}', '{"a":20}']);
    const r = await sampleStructured(ctx(p), { task: "t", template: TPL, vars: { x: "1" }, schema: z.object({ a: z.number() }), summary: "s" }, 3, (v) => v.a, 1);
    expect(r.scores).toEqual([10, 30, 20]);
    expect(r.median).toBe(20);
    expect(r.representative.score).toBe(20);
    expect(r.confidence).toBeCloseTo(0.5, 5);
    expect(median([1, 2, 3, 4])).toBe(2.5);
    expect(spreadConfidence([50, 50, 50])).toBe(1);
  });

  it("drops failed samples but keeps going", async () => {
    const p = fake(['{"a":10}', "x", "x", '{"a":20}']);
    const r = await sampleStructured(ctx(p), { task: "t", template: TPL, vars: { x: "1" }, schema: z.object({ a: z.number() }), summary: "s" }, 3, (v) => v.a, 1);
    expect(r.scores).toEqual([10, 20]);
    expect(r.failed).toHaveLength(1);
  });
});

describe("record / replay", () => {
  it("replays recorded samples without a live provider", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-rec-"));
    const call = { task: "t", template: TPL, vars: { x: "1" }, schema: z.object({ a: z.number() }), summary: "s" };
    const rec = new RecordingProvider(fake(['{"a":1}', '{"a":2}', '{"a":3}']), dir, "record");
    const live = await sampleStructured(ctx(rec), call, 3, (v) => v.a, 1);
    const replay = new RecordingProvider(undefined, dir, "replay");
    const again = await sampleStructured(ctx(replay), call, 3, (v) => v.a, 1);
    expect(again.scores).toEqual(live.scores);
    const changed = { ...call, vars: { x: "2" } };
    await expect(sampleStructured(ctx(replay), changed, 1, (v) => v.a)).rejects.toThrow(/回放缺少录制/);
  });
});

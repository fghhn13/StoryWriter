import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BUILTIN_MAPPINGS,
  anchorEntries,
  importWikiPage,
  initProject,
  loadProject,
  validateProject,
  writeInlineProfile,
  writeProfileRef,
  writeProjectFile,
} from "../src";

const MAPPING = BUILTIN_MAPPINGS["oc-wiki"]!;

const PAGE = `---
id: demo
title: 示例
aliases: [Demo]
---

# 示例 / Demo

> **角色核心：她只想把事情做完。**

## 基础档案
| 项目 | 内容 |
|---|---|
| 年龄 | 18 |
| 身份 | [学生](x.md) |

额外的一段说明。

## 核心人格（就现有文档所见）
- 先问实际情况。
- 不喜欢被解释，
  续行也算同一条。

## 写作指南（源：Demo Bible §Ⅰ）
1. 现实上怎么办？
2. 值得吗？

## 写作边界
前言段落也算一条。
1. **不要**替她解释。

## 推演说明
“某事”为压力测试〔推演〕。

## 终局构想 〔暂定〕
- 也许会离开。

## 留白
- 〔留白〕最终去哪里。
- 〔Agent 建议〕也许是 X。
`;

describe("wiki import (U1, D-011)", () => {
  const imp = importWikiPage(PAGE, MAPPING);

  it("takes id / name / aliases from frontmatter and core from the blockquote", () => {
    expect(imp).toMatchObject({ id: "demo", name: "示例", aliases: ["Demo"], core: "她只想把事情做完。" });
  });

  it("matches section headings by prefix", () => {
    expect(imp.entries.traits.map((e) => e.text)).toEqual(["先问实际情况。", "不喜欢被解释，续行也算同一条。"]);
    expect(imp.entries.heuristics.map((e) => e.text)).toEqual(["现实上怎么办？", "值得吗？"]);
    expect(imp.entries.heuristics[0]!.source).toBe("Demo Bible §Ⅰ");
  });

  it("keeps prose paragraphs and strips inline markdown", () => {
    expect(imp.entries.boundaries.map((e) => e.text)).toEqual(["前言段落也算一条。", "不要替她解释。"]);
  });

  it("turns the 基础档案 table into hard facts", () => {
    expect(imp.entries.hard_facts.map((e) => e.text)).toEqual(["年龄：18", "身份：学生", "额外的一段说明。"]);
  });

  it("marks inferred material as llm and never as an anchor (D-006)", () => {
    expect(imp.entries.inferred).toEqual([expect.objectContaining({ origin: "llm", tag: "推演" })]);
    const [real, suggested] = imp.entries.unknowns;
    expect(real).toMatchObject({ text: "最终去哪里。", tag: "留白", origin: "profile" });
    expect(suggested).toMatchObject({ text: "也许是 X。", tag: "Agent 建议", origin: "llm" });
  });

  it("reports unmapped sections instead of silently dropping them", () => {
    expect(imp.unmatched).toEqual(["终局构想 〔暂定〕"]);
  });
});

describe("external profiles are read-only (§6-U1)", () => {
  function setup() {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "sw-ext-"));
    const wiki = path.join(base, "wiki");
    fs.mkdirSync(wiki);
    const page = path.join(wiki, "demo.md");
    fs.writeFileSync(page, PAGE);
    const proj = path.join(base, "proj");
    initProject(proj, { name: "t", mapping: "oc-wiki" });
    return { page, proj };
  }
  const hash = (f: string) => crypto.createHash("sha256").update(fs.readFileSync(f)).digest("hex");

  it("loads a referenced page, applies extra entries, never writes the source", () => {
    const { page, proj } = setup();
    const before = hash(page);
    const ref = writeProfileRef(proj, page, "demo", "oc-wiki");
    fs.appendFileSync(ref, "extra:\n  boundaries:\n    - { text: 项目内追加的边界。, source: 测试 }\n");
    const p = loadProject(proj);
    expect(validateProject(p).filter((i) => i.level === "error")).toEqual([]);
    const demo = p.profiles[0]!.value;
    expect(demo).toMatchObject({ id: "demo", readonly: true, source: path.resolve(page) });
    expect(demo.boundaries.map((b) => b.text)).toEqual(["前言段落也算一条。", "不要替她解释。", "项目内追加的边界。"]);
    expect(demo.boundaries.map((b) => b.id)).toEqual(["b1", "b2", "b3"]);
    expect(anchorEntries(demo.unknowns).map((u) => u.text)).toEqual(["最终去哪里。"]);
    expect(hash(page)).toBe(before);
  });

  it("refuses to write outside the project folder", () => {
    const { page, proj } = setup();
    expect(() => writeProjectFile(proj, page, "x", { overwrite: true })).toThrow(/项目外/);
    expect(() => writeProjectFile(proj, "../escape.md", "x")).toThrow(/项目外/);
  });

  it("--copy produces an editable inline profile that round-trips", () => {
    const { page, proj } = setup();
    writeInlineProfile(proj, importWikiPage(fs.readFileSync(page, "utf8"), MAPPING), "demo", page);
    const demo = loadProject(proj).profiles[0]!.value;
    expect(demo.readonly).toBe(false);
    expect(demo.heuristics.map((h) => h.text)).toEqual(["现实上怎么办？", "值得吗？"]);
    expect(demo.unknowns[1]).toMatchObject({ origin: "llm", tag: "Agent 建议" });
  });

  it("reports a missing external file with its ref line", () => {
    const { proj } = setup();
    fs.writeFileSync(path.join(proj, "profiles/ghost.ref.yaml"), "id: ghost\npath: ../nowhere.md\n");
    const [e] = validateProject(loadProject(proj)).filter((i) => i.level === "error");
    expect(e).toMatchObject({ file: "profiles/ghost.ref.yaml", line: 2 });
  });
});

// Real data set (D-005). Skipped on machines without the author's wiki.
const WIKI = "F:/fghn_works/fghn's oc universe/wiki/characters";
describe.skipIf(!fs.existsSync(WIKI))("author's wiki", () => {
  const read = (id: string) => importWikiPage(fs.readFileSync(path.join(WIKI, `${id}.md`), "utf8"), MAPPING);

  it("Tina: seven heuristics, core from the page, 推演 marked llm", () => {
    const t = read("tina");
    expect(t.core).toContain("独立生活的一切能力");
    expect(t.entries.heuristics).toHaveLength(7);
    expect(t.entries.heuristics[3]!.text).toBe("值得妥协吗？");
    expect(t.entries.unknowns.length).toBeGreaterThanOrEqual(2);
    expect(t.entries.inferred.every((e) => e.origin === "llm")).toBe(true);
  });

  it("安可: no heuristics; 身世 is a hard fact, not something the importer invents", () => {
    const a = read("ancore");
    expect(a.entries.heuristics).toEqual([]);
    expect(a.entries.unknowns.length).toBeGreaterThan(0);
  });

  it("the wiki fixture project validates", () => {
    const p = loadProject(path.resolve(__dirname, "../../../fixtures/wiki-project"));
    expect(validateProject(p).filter((i) => i.level === "error")).toEqual([]);
    const villy = p.profiles.find((x) => x.value.id === "villy-kame")!.value;
    expect(villy.boundaries.map((b) => b.id)).toEqual(["b-suspicion-hidden", "b-suspicion-constant"]);
  });
});

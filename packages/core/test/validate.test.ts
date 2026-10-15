import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadProject, validateProject } from "../src";
import { MINIMAL, edit, lineOf, tempCopy } from "./helpers";

const errorsOf = (dir: string) => validateProject(loadProject(dir)).filter((i) => i.level === "error");

describe("minimal fixture (M0 acceptance)", () => {
  it("reads two profiles, two snapshots and one empty bridge", () => {
    const p = loadProject(MINIMAL);
    expect(p.profiles.map((x) => x.value.id).sort()).toEqual(["ancore", "tina"]);
    expect(p.snapshots).toHaveLength(2);
    expect(p.bridges).toHaveLength(1);
    expect(p.bridges[0]!.value.status).toBe("empty");
    expect(p.config.thresholds.A).toEqual({ warn: 40, high: 70 });
  });

  it("validates with no errors and warns that 安可 has no heuristics", () => {
    const issues = validateProject(loadProject(MINIMAL));
    expect(issues.filter((i) => i.level === "error")).toEqual([]);
    const w = issues.filter((i) => i.level === "warning");
    expect(w).toHaveLength(1);
    expect(w[0]!.file).toBe("profiles/ancore.md");
    expect(w[0]!.message).toContain("没有决策规则");
  });

  it("normalises entries and keeps author ids", () => {
    const tina = loadProject(MINIMAL).profiles.find((x) => x.value.id === "tina")!.value;
    expect(tina.heuristics.map((h) => h.id)).toEqual(["h1", "h2", "h3", "h4", "h5", "h6", "h7"]);
    expect(tina.traits[0]).toMatchObject({ id: "t1", origin: "profile" });
    const ancore = loadProject(MINIMAL).profiles.find((x) => x.value.id === "ancore")!.value;
    expect(ancore.unknowns[0]).toMatchObject({ id: "u1", permanent: true });
  });
});

describe("broken files are reported with file and line", () => {
  it("bad field type", () => {
    const dir = tempCopy(MINIMAL);
    const f = path.join(dir, "snapshots/t0-start.md");
    edit(f, "t: 0", "t: 开场");
    const [e] = errorsOf(dir);
    expect(e).toMatchObject({ file: "snapshots/t0-start.md", line: lineOf(f, "t: 开场") });
    expect(e!.message).toMatch(/^t:/);
  });

  it("nested bad field", () => {
    const dir = tempCopy(MINIMAL);
    const f = path.join(dir, "snapshots/t1-registered.md");
    edit(f, "      - 亲自体验另一种人生。", "      - { 不是: 字符串 }");
    const [e] = errorsOf(dir);
    expect(e).toMatchObject({ file: "snapshots/t1-registered.md", line: lineOf(f, "不是: 字符串") });
    expect(e!.message).toContain("char_states.ancore.wants.0");
  });

  it("invalid enum value", () => {
    const dir = tempCopy(MINIMAL);
    const f = path.join(dir, "bridges/start__registered.md");
    edit(f, "status: empty", "status: finished");
    const [e] = errorsOf(dir);
    expect(e).toMatchObject({ file: "bridges/start__registered.md", line: lineOf(f, "status: finished") });
  });

  it("YAML syntax error", () => {
    const dir = tempCopy(MINIMAL);
    const f = path.join(dir, "profiles/tina.md");
    edit(f, "aliases: [Tina]", "aliases: [Tina");
    const [e] = errorsOf(dir);
    expect(e!.file).toBe("profiles/tina.md");
    expect(e!.line).toBeGreaterThanOrEqual(lineOf(f, "aliases: [Tina"));
  });

  it("missing frontmatter", () => {
    const dir = tempCopy(MINIMAL);
    fs.writeFileSync(path.join(dir, "threads/oops.md"), "就是一段话\n");
    expect(errorsOf(dir)).toEqual([expect.objectContaining({ file: "threads/oops.md", line: 1 })]);
  });

  it("missing required field points at the object", () => {
    const dir = tempCopy(MINIMAL);
    const f = path.join(dir, "profiles/ancore.md");
    edit(f, "name: 安可\n", "");
    const [e] = errorsOf(dir);
    expect(e).toMatchObject({ file: "profiles/ancore.md" });
    expect(e!.message).toMatch(/^name:/);
  });
});

describe("cross-object rules", () => {
  it("bridge endpoint must exist", () => {
    const dir = tempCopy(MINIMAL);
    const f = path.join(dir, "bridges/start__registered.md");
    edit(f, "to: s-registered", "to: s-nowhere");
    expect(errorsOf(dir)).toEqual([
      expect.objectContaining({ file: "bridges/start__registered.md", line: lineOf(f, "to: s-nowhere"), message: expect.stringContaining("s-nowhere") }),
    ]);
  });

  it("only approved/locked snapshots can be bridge endpoints", () => {
    const dir = tempCopy(MINIMAL);
    edit(path.join(dir, "snapshots/t1-registered.md"), "status: approved", "status: sketch");
    const [e] = errorsOf(dir);
    expect(e!.message).toContain("只有 approved / locked");
  });

  it("bridges connect adjacent snapshots only", () => {
    const dir = tempCopy(MINIMAL);
    const mid = fs.readFileSync(path.join(dir, "snapshots/t1-registered.md"), "utf8").replace("id: s-registered", "id: s-mid");
    edit(path.join(dir, "snapshots/t1-registered.md"), "t: 1", "t: 2");
    fs.writeFileSync(path.join(dir, "snapshots/t1-mid.md"), mid);
    const [e] = errorsOf(dir);
    expect(e!.message).toContain("只能连相邻快照");
    expect(e!.message).toContain("s-mid");
  });

  it("a seed snapshot in between does not break adjacency", () => {
    const dir = tempCopy(MINIMAL);
    const mid = fs
      .readFileSync(path.join(dir, "snapshots/t1-registered.md"), "utf8")
      .replace("id: s-registered", "id: s-idea")
      .replace("status: approved", "status: seed");
    edit(path.join(dir, "snapshots/t1-registered.md"), "t: 1", "t: 2");
    fs.writeFileSync(path.join(dir, "snapshots/t1-idea.md"), mid);
    expect(errorsOf(dir)).toEqual([]);
  });

  it("char_states must belong to the snapshot's lanes; lanes must exist", () => {
    const dir = tempCopy(MINIMAL);
    const f = path.join(dir, "snapshots/t0-start.md");
    edit(f, "lanes: [world, tina, ancore]", "lanes: [world, tina, villy]");
    const msgs = errorsOf(dir).map((e) => e.message);
    expect(msgs).toEqual(expect.arrayContaining([expect.stringContaining("不存在的泳道：villy"), expect.stringContaining("ancore 不在本快照的 lanes 中")]));
  });

  it("duplicate ids", () => {
    const dir = tempCopy(MINIMAL);
    fs.copyFileSync(path.join(dir, "profiles/tina.md"), path.join(dir, "profiles/tina-copy.md"));
    expect(errorsOf(dir)[0]!.message).toContain("id 重复：tina");
  });

  it("threads, checks and acceptances reference existing objects", () => {
    const dir = tempCopy(MINIMAL);
    fs.writeFileSync(
      path.join(dir, "threads/room.md"),
      "---\nid: th-room\nplanted_at: s-start\npayoff_at: b-nowhere#3\nvisibility: character\nknown_by: [villy]\n---\n活动室的钥匙。\n",
    );
    fs.writeFileSync(
      path.join(dir, "checks/c1.yaml"),
      "id: c1\ntarget: b-fifth\ntarget_kind: bridge\naxis: A\nscore: 120\nconfidence: 0.5\n",
    );
    fs.writeFileSync(path.join(dir, "acceptances/a1.yaml"), "id: a1\ncheck: c9\ncharacter: tina\nt: 1\ndelta: 从此她知道。\njustification: 转折。\n");
    const msgs = errorsOf(dir).map((e) => `${e.file}: ${e.message}`);
    expect(msgs).toEqual(
      expect.arrayContaining([
        expect.stringContaining("threads/room.md: 收点不存在：b-nowhere#3"),
        expect.stringContaining("threads/room.md: known_by 引用了不存在的人物：villy"),
        expect.stringContaining("checks/c1.yaml: score"),
        expect.stringContaining("acceptances/a1.yaml: 接受引用了不存在的检查：c9"),
      ]),
    );
  });
});

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { MINIMAL, edit, tempCopy } from "../../core/test/helpers";

const MAIN = path.resolve(__dirname, "../src/main.ts");
const sw = (...args: string[]) => {
  const r = spawnSync(process.execPath, ["--import", "tsx", MAIN, ...args], { encoding: "utf8" });
  return { code: r.status, out: r.stdout + r.stderr };
};

describe("sw CLI (M0 acceptance)", () => {
  it("validate passes on the minimal fixture", () => {
    const r = sw("-p", MINIMAL, "validate");
    expect(r.code).toBe(0);
    expect(r.out).toContain("2 档案 · 2 快照 · 1 桥");
    expect(r.out).toContain("0 错误");
  });

  it("validate fails with file:line on a broken file", () => {
    const dir = tempCopy(MINIMAL);
    edit(path.join(dir, "snapshots/t0-start.md"), "t: 0", "t: 开场");
    const r = sw("-p", dir, "validate");
    expect(r.code).toBe(1);
    // line 4: "---" is line 1, then id, title, t
    expect(r.out).toMatch(/错误 {2}snapshots\/t0-start\.md:4 {2}t:/);
    // the bridge pointing at the unreadable snapshot is not reported a second time
    expect(r.out).not.toContain("起点快照不存在");
  });

  it("list and show", () => {
    expect(sw("-p", MINIMAL, "list", "snapshots").out).toMatch(/t=0\ts-start[\s\S]*t=1\ts-registered/);
    expect(sw("-p", MINIMAL, "list", "bridges").out).toContain("b-fifth\ts-start → s-registered\tempty");
    expect(sw("-p", MINIMAL, "show", "tina").out).toContain("值得妥协吗？");
    expect(sw("-p", MINIMAL, "show", "nobody").code).not.toBe(0);
  });

  it("init + import --copy", () => {
    const base = tempCopy(path.join(MINIMAL, "profiles"));
    const proj = path.join(base, "proj");
    expect(sw("init", proj, "--mapping", "oc-wiki").code).toBe(0);
    const page = path.join(base, "page.md");
    fs.writeFileSync(page, "---\nid: x\ntitle: X\n---\n\n## 写作指南\n1. 问一？\n");
    const r = sw("-p", proj, "import", page, "--copy");
    expect(r.out).toContain("决策规则 1");
    expect(sw("-p", proj, "validate").code).toBe(0);
  });
});

describe("sw CLI (M2, no model calls)", () => {
  it("gap lists adjacent approved snapshots", () => {
    const r = sw("-p", MINIMAL, "gap", "--detail");
    expect(r.code).toBe(0);
    expect(r.out).toContain("s-start（t=0）→ s-registered（t=1）  间距 53");
    expect(r.out).toContain("ancore.wants  ×1");
  });

  it("adopt without a derived snapshot explains what to run", () => {
    const r = sw("-p", MINIMAL, "adopt", "b-fifth");
    expect(r.code).not.toBe(0);
    expect(r.out).toContain("还没有到达状态");
  });
});

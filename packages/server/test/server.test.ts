// The canvas API end to end (no UI, scripted model): every canvas operation U2–U8 goes through HTTP.
import fs from "node:fs";
import path from "node:path";
import { loadProject, validateProject } from "@sw/core";
import { CallLog, type LlmProvider } from "@sw/llm";
import { afterEach, describe, expect, it } from "vitest";
import { MINIMAL, tempCopy } from "../../core/test/helpers";
import { startServer } from "../src";

const state = (lanes: string[]) =>
  Object.fromEntries(lanes.map((l) => [l, { knows: [`${l} 知道开场的事。`], wants: ["保住活动室。"], feels: "平静。", location: "活动室", relationships: {} }]));
const TEXT = "活动室的窗半开着。\n\n“好，你说了算。”Tina 说。\n\n安可在第五栏写下名字。";

function answer(task: string, prompt: string): unknown {
  const kind = task.split(":")[0];
  switch (kind) {
    case "start":
      return { title: "差第五个人", world_facts: ["社团还差第五个正式成员。"], char_states: state(["tina", "ancore"]) };
    case "candidates":
      return {
        candidates: ["Villy", "安可", "Tina"].map((who, i) => ({
          title: `${who}推动`,
          dims: { 谁推动: who },
          world_facts: [`${who}先动了。`],
          char_states: state(["tina"]),
          touches_unknowns: [],
          rationale: String(i),
        })),
      };
    case "outline":
      return { beats: ["进门。", "登记。"], touches_unknowns: [] };
    case "draft":
      return TEXT;
    case "extract":
      return { world_facts: ["安可登记了。"], char_states: state(["tina", "ancore"]) };
    case "axis-a":
      return task.endsWith("tina")
        ? {
            behaviors: [{ id: "x1", quote: "“好，你说了算。”Tina 说。", action: "让步" }],
            judgments: [{ behavior: "x1", rule: "h4", direction: "opposite", severity: 3 }],
            cheapest_fix: null,
          }
        : { cheapest_fix: null };
    case "axis-b":
      return { premises: [], cheapest_fix: null };
    case "axis-c":
      return { unknowns: [], cheapest_fix: null };
    case "axis-d": {
      const keys = [...prompt.matchAll(/^- \[([^\]]+)\]/gm)].map((m) => m[1]!).filter((k) => !k.startsWith("d:"));
      return { items: keys.map((key) => ({ key, status: "matched" })), cheapest_fix: null };
    }
    case "axis-e":
      return { conflicts: [], leaks: [] };
  }
  throw new Error(`no script for ${task}`);
}

const provider: LlmProvider = {
  name: "scripted",
  async chat(req, meta) {
    const task = meta!.key!.split("#")[1]!;
    const out = answer(task, req.messages.map((m) => m.content).join("\n"));
    return { text: typeof out === "string" ? out : "```json\n" + JSON.stringify(out) + "\n```", model: "m", seconds: 0 };
  },
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function serve(dir: string) {
  const s = await startServer({ root: dir, port: 0, ui: false, contexts: () => ({ provider, log: new CallLog(), model: "m" }) });
  close = s.close;
  const call = async <T = Record<string, unknown>>(method: "GET" | "POST", url: string, body?: unknown): Promise<T> => {
    const r = await fetch(s.url + url, { method, headers: { "Content-Type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = (await r.json()) as T & { error?: string };
    if (!r.ok) throw new Error(data.error);
    return data;
  };
  return { url: s.url, get: <T = Record<string, unknown>>(u: string) => call<T>("GET", u), post: <T = Record<string, unknown>>(u: string, b: unknown = {}) => call<T>("POST", u, b) };
}

/** minimal fixture without snapshots and bridges: the canvas starts from nothing */
function emptyProject() {
  const dir = tempCopy(MINIMAL);
  for (const d of ["snapshots", "bridges"]) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
  return dir;
}

describe("canvas API", () => {
  it("serves the project view", async () => {
    const api = await serve(tempCopy(MINIMAL));
    const v = await api.get<{ name: string; snapshots: unknown[]; gaps: { score: number }[]; lanes: unknown[] }>("/api/project");
    expect(v.name).toContain("第五个人");
    expect(v.snapshots).toHaveLength(2);
    expect(v.gaps[0]!.score).toBe(53);
    expect(v.lanes).toHaveLength(3);
  });

  it("U2–U8 through HTTP only, leaving a valid project", async () => {
    const dir = emptyProject();
    const api = await serve(dir);
    // U2
    await api.post("/api/start-draft", { id: "s0", t: 0, opening: "差第五个人" });
    await api.post("/api/snapshot/s0/confirm");
    await api.post("/api/snapshots/s0/approve");
    await api.post("/api/snapshots", { data: { id: "s2", title: "登记", t: 2, lanes: ["world", "tina", "ancore"], world_facts: ["安可登记了。"], char_states: state(["tina", "ancore"]), status: "approved" } });
    // U3 / U4
    const c = await api.post<{ candidates: { id: string }[] }>("/api/candidates", { from: "s0", to: "s2", dims: "谁推动", k: 3 });
    expect(c.candidates).toHaveLength(3);
    await api.post(`/api/snapshots/${encodeURIComponent(c.candidates[1]!.id)}/approve`);
    // U5
    const v1 = await api.get<{ missingBridges: { from: string; to: string }[] }>("/api/project");
    expect(v1.missingBridges).toHaveLength(2);
    const b = await api.post<{ id: string }>("/api/bridges", v1.missingBridges[0]);
    expect(b.id).toBe("b-0-1");
    await api.post(`/api/bridges/${b.id}/outline`);
    await api.post(`/api/bridges/${b.id}/save`, { outline: ["进门。", "登记。", "作者加的：核对学号。"] });
    const d = await api.post<{ saved: { id: string }[] }>(`/api/bridges/${b.id}/draft`);
    expect(d.saved.map((s) => s.id)).toContain(`${b.id}.D`);
    // U6
    await api.post(`/api/checks/${b.id}.A.tina/accept`, { why: "故意让步", delta: "从此她在小事上让 Villy 拍板" });
    await api.post(`/api/checks/${b.id}.C/dismiss`, { why: "没有留白被碰" });
    // U7
    const th = await api.post<{ saved: { id: string } }>("/api/threads", { id: "th", description: "钥匙被收走了。", planted_at: "s0" });
    expect(th.saved.id).toBe("th.E");
    // U8
    await api.post(`/api/bridges/${b.id}/save`, { text: `${TEXT}\n\n作者补的一句。` });
    const v2 = await api.get<{ stale: { id: string }[] }>("/api/project");
    expect(v2.stale.map((s) => s.id)).toContain(`${b.id}.B`);
    const plan = await api.get<{ calls: number }>("/api/rerun-plan");
    expect(plan.calls).toBeGreaterThan(0);
    const r = await api.post<{ stillStale: string[] }>("/api/rerun");
    expect(r.stillStale).toEqual([]);
    // U9
    await api.post(`/api/bridges/${b.id}/save`, { status: "locked" });
    const m = await api.get<{ included: string[] }>("/api/export/manuscript");
    expect(m.included).toEqual([b.id]);

    const p = loadProject(dir);
    expect(p.acceptances).toHaveLength(1);
    expect(p.bridges[0]!.value.versions.length).toBeGreaterThan(0);
    expect(validateProject(p).filter((i) => i.level === "error")).toEqual([]);
  });

  it("edits objects as YAML, reorders lanes, rejects bad input with a message", async () => {
    const dir = tempCopy(MINIMAL);
    const api = await serve(dir);
    const src = await api.get<{ yaml: string; body: string }>("/api/objects/snapshot/s-start");
    expect(src.yaml).toContain("差第五个人");
    await api.post("/api/objects/snapshot/s-start", { yaml: src.yaml.replace("差第五个人", "还差一个人"), body: src.body });
    expect(loadProject(dir).snapshots.find((s) => s.value.id === "s-start")!.value.title).toBe("还差一个人");
    await expect(api.post("/api/objects/snapshot/s-start", { yaml: "t: 很早" })).rejects.toThrow(/t/);
    await api.post("/api/lanes/order", { order: ["ancore", "tina", "world"] });
    expect(loadProject(dir).config.lanes.map((l) => l.id)).toEqual(["ancore", "tina", "world"]);
    await expect(api.post("/api/lanes/order", { order: ["tina"] })).rejects.toThrow(/全部泳道/);
    await expect(api.post("/api/checks/nope/dismiss", { why: "x" })).rejects.toThrow(/找不到检查/);
  });

  it("pushes a change event when a file is edited on disk", async () => {
    const dir = tempCopy(MINIMAL);
    const api = await serve(dir);
    const res = await fetch(`${api.url}/api/events`);
    const reader = res.body!.getReader();
    const seen = (async () => {
      let buf = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return buf;
        buf += new TextDecoder().decode(value);
        if (buf.includes("event: change")) return buf;
      }
    })();
    await new Promise((r) => setTimeout(r, 200));
    fs.appendFileSync(path.join(dir, "snapshots/t0-start.md"), "\n作者在编辑器里加的一句。\n");
    const buf = await Promise.race([seen, new Promise<string>((r) => setTimeout(() => r("timeout"), 4000))]);
    await reader.cancel();
    expect(buf).toContain("event: change");
    expect(buf).toContain("t0-start.md");
  });
});

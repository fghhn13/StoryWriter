// Graph-mode API end to end (no UI, scripted model): build a graph over HTTP, check an edge and a
// route as background jobs, add a constraint (auto conflict check + stale rerun), export the outline.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { initProject, loadProject, validateProject } from "@sw/core";
import { CallLog, type LlmProvider } from "@sw/llm";
import { afterEach, describe, expect, it } from "vitest";
import { type GraphView, startServer } from "../src";

const provider: LlmProvider = {
  name: "scripted",
  async chat(_req, meta) {
    const kind = meta!.key!.split("#")[1]!.split(":")[0];
    const out =
      kind === "axis-t"
        ? { changes: [{ id: "c1", character: "tina", field: "wants", from: null, to: "离开。", verdict: "stretch", reason: "缺理由", needs: "一个契机" }] }
        : kind === "axis-k"
          ? { issues: [] }
          : null;
    if (!out) throw new Error(`no script for ${kind}`);
    return { text: "```json\n" + JSON.stringify(out) + "\n```", model: "m", seconds: 0 };
  },
};

let close: (() => Promise<void>) | undefined;
afterEach(async () => {
  await close?.();
  close = undefined;
});

async function boot() {
  const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "sw-gapi-")), "proj");
  initProject(dir, { name: "g" });
  const s = await startServer({ root: dir, port: 0, ui: false, contexts: () => ({ provider, log: new CallLog(), model: "m" }) });
  close = s.close;
  const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
    const r = await fetch(s.url + url, { method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    const data = (await r.json()) as Record<string, unknown>;
    if (!r.ok && !headers["x-expect-error"]) throw new Error(`${method} ${url}: ${data.error}`);
    return { status: r.status, data };
  };
  const post = (url: string, body: unknown = {}) => call("POST", url, body).then((r) => r.data);
  const view = () => call("GET", "/api/graph").then((r) => r.data as unknown as GraphView);
  /** wait until no background job is running */
  const idle = async () => {
    for (let i = 0; i < 200; i++) {
      const r = await fetch(s.url + "/api/events");
      const reader = r.body!.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      await reader.cancel();
      if (first.includes('"jobs":[]')) return;
      await new Promise((res) => setTimeout(res, 20));
    }
    throw new Error("jobs never finished");
  };
  return { dir, s, call, post, view, idle };
}

describe("graph API", () => {
  it("canvas flow: nodes, edges, constraint, edge + route checks, outline", async () => {
    const { dir, post, view, idle } = await boot();
    await post("/api/graph/enable");
    await post("/api/profiles", { id: "tina", name: "缇娜" });
    for (const [title, x] of [["A", 0], ["B", 300]] as const) await post("/api/nodes", { title, x, y: 10 });
    await post("/api/nodes/n1", { char_states: { tina: { wants: ["留下。"] } } });
    await post("/api/nodes/n2", { char_states: { tina: { wants: ["离开。"] } } });
    await post("/api/edges", { from: "n1", to: "n2", summary: "她想通了" });
    await post("/api/layout", { positions: { n2: { x: 400, y: 50 } } });

    let v = await view();
    expect(v.mode).toBe("graph");
    expect(v.nodes.map((n) => [n.id, n.pos])).toEqual([["n1", { x: 0, y: 10 }], ["n2", { x: 400, y: 50 }]]);
    expect(v.edges[0]!.info).toMatchObject({ checked: false, hasText: false });

    const job = await post("/api/edges/e-n1-n2/check");
    expect(typeof job.job).toBe("number");
    await idle();
    v = await view();
    expect(v.edges[0]!.info).toMatchObject({ checked: true, score: 28, axes: { T: 28 } });

    const route = await post("/api/routes", { name: "Main", nodes: ["n1", "n2"] });
    await post(`/api/routes/${route.id}/check`);
    await idle();
    v = await view();
    expect(v.routes[0]).toMatchObject({ name: "Main", score: 28, complete: true });

    // a new constraint: axis K runs, the edge check goes stale and is rerun automatically
    const added = await post("/api/constraints", { owner: "tina", field: "heuristics", text: "这是她想要的吗？" });
    expect(added.key).toBe("tina.h1");
    await idle();
    v = await view();
    expect(v.constraintCheck).toMatchObject({ axis: "K", score: 0, isStale: false });
    expect(v.edges[0]!.info.stale).toBe(false);
    expect(v.constraints.find((o) => o.owner === "tina")!.fields.heuristics!.map((e) => e.text)).toEqual(["这是她想要的吗？"]);

    const out = await post(`/api/routes/${route.id}/outline`);
    expect(out.file).toBe("exports/r1.outline.md");
    expect(fs.existsSync(path.join(dir, "exports/r1.outline.md"))).toBe(true);
    expect(validateProject(loadProject(dir)).filter((i) => i.level === "error")).toEqual([]);
  });

  it("errors come back as JSON; refused edges don't write files", async () => {
    const { call, post } = await boot();
    await post("/api/graph/enable");
    await post("/api/nodes", { title: "A" });
    await post("/api/nodes", { title: "B" });
    await post("/api/edges", { from: "n1", to: "n2" });
    const r = await call("POST", "/api/edges", { from: "n2", to: "n1" }, { "x-expect-error": "1" });
    expect(r.status).toBe(400);
    expect(String(r.data.error)).toMatch(/环/);
  });

  it("only the Tauri window and localhost may call cross-origin", async () => {
    const { s } = await boot();
    const ok = await fetch(s.url + "/api/graph", { headers: { Origin: "http://tauri.localhost" } });
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://tauri.localhost");
    const pre = await fetch(s.url + "/api/nodes", { method: "OPTIONS", headers: { Origin: "tauri://localhost" } });
    expect(pre.status).toBe(204);
    const evil = await fetch(s.url + "/api/graph", { headers: { Origin: "https://example.com" } });
    expect(evil.status).toBe(403);
  });
});

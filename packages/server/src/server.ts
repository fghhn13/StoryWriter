// Local HTTP API over @sw/ops (spec §7, PLAN M4). Files stay the only truth: every request reloads
// the project, and a file watcher tells the canvas to refetch when anything changes on disk,
// including edits the author makes in an editor.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type Project, loadProject } from "@sw/core";
import { renderReport } from "@sw/checks";
import { type LlmContext, createContext } from "@sw/llm";
import {
  type BridgeAxis,
  type EditableKind,
  acceptCheck,
  addThread,
  adoptDerived,
  approveSnapshot,
  checkBridge,
  checkThread,
  confirmModelOutput,
  createBridge,
  createSnapshot,
  dismissCheck,
  draftBridge,
  draftStartSnapshot,
  editObject,
  exportHarvest,
  exportManuscript,
  exportReport,
  generateCandidates,
  graftSnapshot,
  markFixed,
  markStale,
  outlineBridge,
  planRerun,
  readObjectSource,
  reorderLanes,
  rerunStale,
  revokeAcceptance,
  saveBridge,
} from "@sw/ops";
import { buildView } from "./view";

export type ContextFactory = (p: Project, role: "gen" | "check") => LlmContext;

export interface ServerOptions {
  root: string;
  port?: number;
  host?: string;
  /** serve the canvas through Vite (default true); tests turn it off */
  ui?: boolean;
  recordings?: string;
  /** override how LLM contexts are made (tests use a scripted provider) */
  contexts?: ContextFactory;
}

const CANVAS = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../canvas");

function defaultContexts(recordings?: string): ContextFactory {
  return (p, role) =>
    createContext({
      projectRoot: p.root,
      model: role === "gen" ? p.config.llm.model : (p.config.llm.check_model ?? p.config.llm.model),
      temperature: p.config.llm.temperature,
      recordings,
    });
}

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "请求体不是 JSON");
  }
}

const str = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw new HttpError(400, `缺少 ${name}`);
  return v.trim();
};
const optStr = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const optNum = (v: unknown) => (v === undefined || v === null || v === "" ? undefined : Number(v));

type Handler = (ctx: { p: Project; body: Record<string, unknown>; params: string[]; say: (m: string) => void }) => Promise<unknown> | unknown;

export async function startServer(opts: ServerOptions) {
  const root = path.resolve(opts.root);
  if (!fs.existsSync(path.join(root, "project.yaml"))) throw new Error(`${root} 不是项目（没有 project.yaml）`);
  const contexts = opts.contexts ?? defaultContexts(opts.recordings);
  const clients = new Set<http.ServerResponse>();
  const broadcast = (event: string, data: unknown) => {
    const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
    for (const c of clients) c.write(msg);
  };
  const jobs = new Map<number, string>();
  let jobSeq = 0;

  const usage = (c: LlmContext) => {
    const t = c.log.totals();
    return { calls: t.calls, replayed: t.replayed, tokens: t.tokens, seconds: Math.round(t.seconds) };
  };

  // ---- routes: [method, pattern, handler]; (\w…) groups become params
  const routes: [string, RegExp, Handler][] = [
    ["GET", /^\/api\/project$/, ({ p }) => buildView(p)],
    ["GET", /^\/api\/export\/(manuscript|report|harvest)$/, ({ p, params }) => {
      if (params[0] === "manuscript") return exportManuscript(p);
      if (params[0] === "report") return { text: exportReport(p) };
      return exportHarvest(p);
    }],
    ["GET", /^\/api\/rerun-plan$/, ({ p }) => planRerun(p)],
    ["GET", /^\/api\/objects\/(snapshot|bridge|thread)\/([^/]+)$/, ({ p, params }) => readObjectSource(p, params[0] as EditableKind, decodeURIComponent(params[1]!))],

    ["POST", /^\/api\/lanes\/order$/, ({ p, body }) => reorderLanes(p, body.order as string[])],
    ["POST", /^\/api\/snapshots$/, ({ p, body }) => ({ file: createSnapshot(p, body.data as Record<string, unknown>, optStr(body.notes) ?? "") })],
    ["POST", /^\/api\/objects\/(snapshot|bridge|thread)\/([^/]+)$/, ({ p, body, params }) => ({
      file: editObject(p, params[0] as EditableKind, decodeURIComponent(params[1]!), str(body.yaml, "yaml"), typeof body.body === "string" ? body.body : undefined),
    })],
    ["POST", /^\/api\/snapshots\/([^/]+)\/approve$/, ({ p, params }) => approveSnapshot(p, decodeURIComponent(params[0]!))],
    ["POST", /^\/api\/snapshots\/([^/]+)\/graft$/, ({ p, params }) => graftSnapshot(p, decodeURIComponent(params[0]!))],
    ["POST", /^\/api\/(snapshot|bridge)\/([^/]+)\/confirm$/, ({ p, params, body }) =>
      confirmModelOutput(p, params[0] as "snapshot", decodeURIComponent(params[1]!), body.what as "outline" | undefined)],
    ["POST", /^\/api\/start-draft$/, async ({ p, body }) => {
      const c = contexts(p, "gen");
      const r = await draftStartSnapshot(p, c, {
        id: str(body.id, "id"),
        t: optNum(body.t),
        title: optStr(body.title),
        opening: str(body.opening, "开场设定"),
        characters: Array.isArray(body.characters) ? (body.characters as string[]) : undefined,
      });
      return { ...r, usage: usage(c) };
    }],
    ["POST", /^\/api\/candidates$/, async ({ p, body }) => {
      const c = contexts(p, "gen");
      const dims = (Array.isArray(body.dims) ? (body.dims as string[]) : String(body.dims ?? "").split(/[,，]/)).map((d) => d.trim()).filter(Boolean);
      const r = await generateCandidates(p, c, { from: str(body.from, "from"), to: str(body.to, "to"), dims, k: optNum(body.k) });
      return { ...r, usage: usage(c) };
    }],

    ["POST", /^\/api\/bridges$/, ({ p, body }) => createBridge(p, str(body.from, "from"), str(body.to, "to"))],
    ["POST", /^\/api\/bridges\/([^/]+)\/outline$/, async ({ p, params }) => {
      const c = contexts(p, "gen");
      return { ...(await outlineBridge(p, c, decodeURIComponent(params[0]!))), usage: usage(c) };
    }],
    ["POST", /^\/api\/bridges\/([^/]+)\/draft$/, async ({ p, params, body, say }) => {
      const id = decodeURIComponent(params[0]!);
      const gen = contexts(p, "gen");
      say(`写正文：${id}`);
      const d = await draftBridge(p, gen, id);
      // spec §6-U5: checks run right after generation
      if (body.check === false) return { ...d, usage: usage(gen) };
      const check = contexts(loadProject(p.root), "check");
      const r = await checkBridge(loadProject(p.root), check, id, { onProgress: say });
      return { draft: d, saved: r.saved, usage: { gen: usage(gen), check: usage(check) } };
    }],
    ["POST", /^\/api\/bridges\/([^/]+)\/check$/, async ({ p, params, body, say }) => {
      const id = decodeURIComponent(params[0]!);
      const c = contexts(p, "check");
      const r = await checkBridge(p, c, id, { axes: body.axes as BridgeAxis[] | undefined, n: optNum(body.n), onProgress: say });
      return { saved: r.saved, report: renderReport(loadProject(p.root), r.run, { source: `桥 ${id}` }), usage: usage(c) };
    }],
    ["POST", /^\/api\/bridges\/([^/]+)\/save$/, ({ p, params, body }) =>
      saveBridge(p, decodeURIComponent(params[0]!), { outline: body.outline as string[] | undefined, text: body.text as string | undefined, status: optStr(body.status) })],
    ["POST", /^\/api\/bridges\/([^/]+)\/adopt$/, ({ p, params }) => adoptDerived(p, decodeURIComponent(params[0]!))],

    ["POST", /^\/api\/threads$/, async ({ p, body, say }) => {
      const id = str(body.id, "id");
      const file = addThread(p, {
        id,
        description: str(body.description, "描述"),
        planted_at: str(body.planted_at, "埋点"),
        payoff_at: optStr(body.payoff_at),
        visibility: (optStr(body.visibility) ?? "reader_only") as "reader_only",
        known_by: Array.isArray(body.known_by) ? (body.known_by as string[]) : undefined,
      });
      if (body.check === false) return { file };
      const c = contexts(loadProject(p.root), "check");
      const r = await checkThread(loadProject(p.root), c, id, { onProgress: say });
      return { file, saved: r.saved, details: r.result.details, usage: usage(c) };
    }],
    ["POST", /^\/api\/threads\/([^/]+)\/check$/, async ({ p, params, say }) => {
      const c = contexts(p, "check");
      const r = await checkThread(p, c, decodeURIComponent(params[0]!), { onProgress: say });
      return { saved: r.saved, details: r.result.details, usage: usage(c) };
    }],

    ["POST", /^\/api\/checks\/([^/]+)\/accept$/, ({ p, params, body }) =>
      acceptCheck(p, decodeURIComponent(params[0]!), { justification: str(body.why, "理由"), delta: optStr(body.delta), character: optStr(body.character) })],
    ["POST", /^\/api\/checks\/([^/]+)\/dismiss$/, ({ p, params, body }) => dismissCheck(p, decodeURIComponent(params[0]!), str(body.why, "原因"))],
    ["POST", /^\/api\/checks\/([^/]+)\/fixed$/, ({ p, params, body }) => markFixed(p, decodeURIComponent(params[0]!), optStr(body.note))],
    ["POST", /^\/api\/acceptances\/([^/]+)\/revoke$/, ({ p, params }) => revokeAcceptance(p, decodeURIComponent(params[0]!))],
    ["POST", /^\/api\/rerun$/, async ({ p, say }) => {
      markStale(p);
      const fresh = loadProject(p.root);
      const plan = planRerun(fresh);
      const c = contexts(fresh, "check");
      const r = await rerunStale(fresh, c, plan, say);
      return { ...r, usage: usage(c) };
    }],
  ];

  async function api(req: http.IncomingMessage, res: http.ServerResponse, url: URL) {
    if (url.pathname === "/api/events") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      res.write(`event: hello\ndata: ${JSON.stringify({ jobs: [...jobs.values()] })}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    const send = (status: number, data: unknown) => {
      res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(data ?? { ok: true }));
    };
    for (const [method, re, handler] of routes) {
      const m = re.exec(url.pathname);
      if (!m || req.method !== method) continue;
      const job = ++jobSeq;
      try {
        const body = method === "POST" ? await readJson(req) : {};
        if (method === "POST") {
          jobs.set(job, `${url.pathname}`);
          broadcast("job", { id: job, state: "start", what: url.pathname });
        }
        const say = (msg: string) => broadcast("progress", { id: job, msg });
        const out = await handler({ p: loadProject(root), body, params: m.slice(1), say });
        send(200, out);
      } catch (e) {
        const status = e instanceof HttpError ? e.status : 400;
        send(status, { error: (e as Error).message });
      } finally {
        if (jobs.delete(job)) broadcast("job", { id: job, state: "end" });
      }
      return;
    }
    send(404, { error: `没有这个接口：${req.method} ${url.pathname}` });
  }

  const server = http.createServer();
  let vite: { middlewares: http.RequestListener; close(): Promise<void> } | undefined;
  if (opts.ui !== false) {
    const { createServer } = await import("vite");
    vite = await createServer({
      configFile: path.join(CANVAS, "vite.config.ts"),
      root: CANVAS,
      server: { middlewareMode: true, hmr: { server } },
      appType: "spa",
      logLevel: "warn",
    });
  }
  server.on("request", (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname.startsWith("/api/")) return void api(req, res, url);
    if (vite) return vite.middlewares(req, res);
    res.writeHead(404).end();
  });

  // file changes → canvas refetch (author edits in an editor show up live)
  let timer: NodeJS.Timeout | undefined;
  const watcher = fs.watch(root, { recursive: true }, (_e, name) => {
    const n = String(name ?? "").replace(/\\/g, "/");
    if (n.startsWith("llm-log/") || n.includes("/.versions/")) return;
    clearTimeout(timer);
    timer = setTimeout(() => broadcast("change", { file: n }), 150);
  });

  await new Promise<void>((resolve) => server.listen(opts.port ?? 4173, opts.host ?? "127.0.0.1", resolve));
  const addr = server.address() as { port: number };
  return {
    url: `http://${opts.host ?? "127.0.0.1"}:${addr.port}`,
    port: addr.port,
    async close() {
      watcher.close();
      clearTimeout(timer);
      for (const c of clients) c.end();
      await vite?.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

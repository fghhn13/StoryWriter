// Graph-mode API (D-057–D-066) for the Tauri canvas. Edits answer at once; checks run as
// background jobs whose progress and result go out over /api/events, and their files arrive
// through the watcher's "change" events like any other edit.
import { type Project, loadProject } from "@sw/core";
import type { LlmContext } from "@sw/llm";
import {
  type ConstraintField,
  type Route,
  CONSTRAINTS_TARGET,
  addConstraint,
  checkConstraints,
  checkEdge,
  checkRoute,
  createEdge,
  createNode,
  createProfile,
  deleteEdge,
  deleteNode,
  deleteRoute,
  edgeInfo,
  editConstraint,
  enableGraphMode,
  findRoute,
  findStale,
  listConstraints,
  loadCanvas,
  markStale,
  moveNodes,
  removeConstraint,
  rerunGraph,
  routeInfo,
  routeOutline,
  saveRoute,
  updateEdge,
  updateNode,
  updateProfileMeta,
} from "@sw/ops";
import { validateProject } from "@sw/core";

export type Background = (what: string, run: (say: (m: string) => void) => Promise<unknown>) => { job: number };
type Ctx = { p: Project; body: Record<string, unknown>; params: string[]; say: (m: string) => void };
type Handler = (c: Ctx) => Promise<unknown> | unknown;

const s = (v: unknown, name: string): string => {
  if (typeof v !== "string" || !v.trim()) throw Object.assign(new Error(`missing ${name}`), { status: 400 });
  return v;
};
const opt = (v: unknown) => (typeof v === "string" ? v : undefined);
const strings = (v: unknown): string[] | undefined => (Array.isArray(v) ? v.map(String) : undefined);
const id = (params: string[], i = 0) => decodeURIComponent(params[i]!);

/** Everything the canvas draws in graph mode, in one document. Read-only. */
export function buildGraphView(p: Project) {
  const canvas = loadCanvas(p);
  const staleIds = new Set(findStale(p).map((x) => x.check.value.id));
  const edges = p.bridges.map((b) => ({ ...b.value, file: b.file, info: edgeInfo(p, b.value, staleIds) }));
  const constraintCheck = p.checks.find((c) => c.value.target === CONSTRAINTS_TARGET && c.value.axis === "K");
  return {
    root: p.root,
    name: p.config.name,
    mode: p.config.mode,
    thresholds: p.config.thresholds,
    sampling: p.config.sampling,
    nodes: p.snapshots.map((x, i) => ({
      ...x.value,
      file: x.file,
      // nodes without a stored position fan out so a hand-written project still shows up
      pos: canvas.nodes[x.value.id] ?? { x: (i % 6) * 280, y: Math.floor(i / 6) * 200 },
    })),
    edges,
    routes: canvas.routes.map((r) => routeInfo(p, r)),
    constraints: listConstraints(p),
    constraintCheck: constraintCheck ? { ...constraintCheck.value, isStale: staleIds.has(constraintCheck.value.id), file: constraintCheck.file } : null,
    checks: p.checks.map((c) => ({ ...c.value, file: c.file, isStale: staleIds.has(c.value.id) || c.value.status === "stale" })),
    acceptances: p.acceptances.map((a) => ({ ...a.value, file: a.file })),
    issues: validateProject(p),
  };
}
export type GraphView = ReturnType<typeof buildGraphView>;

export function graphRoutes(deps: { contexts: (p: Project, role: "gen" | "check") => LlmContext; background: Background; root: string }): [string, RegExp, Handler][] {
  const { contexts, background, root } = deps;
  const fresh = () => loadProject(root);

  /** After any constraint edit: axis K, then mark and rerun whatever went stale (D-064). */
  const afterConstraintChange = (changed: string[]) =>
    background("constraints", async (say) => {
      const c = contexts(fresh(), "check");
      say("Checking constraints for conflicts");
      await checkConstraints(fresh(), c, { changed });
      const stale = markStale(fresh());
      if (stale.length) {
        say(`Re-checking ${stale.length} stale result(s)`);
        await rerunGraph(fresh(), c, (pp) => checkConstraints(pp, c), say);
      }
      const t = c.log.totals();
      return { calls: t.calls, tokens: t.tokens };
    });

  return [
    ["GET", /^\/api\/graph$/, ({ p }) => buildGraphView(p)],
    ["POST", /^\/api\/graph\/enable$/, ({ p }) => enableGraphMode(p)],

    // nodes
    ["POST", /^\/api\/nodes$/, ({ p, body }) => createNode(p, { id: opt(body.id), title: s(body.title, "title"), x: Number(body.x ?? 0), y: Number(body.y ?? 0) })],
    ["POST", /^\/api\/nodes\/([^/]+)$/, ({ p, body, params }) => ({
      file: updateNode(p, id(params), {
        title: opt(body.title),
        world_facts: strings(body.world_facts),
        char_states: body.char_states as Record<string, unknown> | undefined,
        notes: opt(body.notes),
      }),
    })],
    ["POST", /^\/api\/nodes\/([^/]+)\/delete$/, ({ p, params }) => deleteNode(p, id(params))],
    ["POST", /^\/api\/layout$/, ({ p, body }) => moveNodes(p, body.positions as Record<string, { x: number; y: number }>)],

    // edges
    ["POST", /^\/api\/edges$/, ({ p, body }) => createEdge(p, s(body.from, "from"), s(body.to, "to"), opt(body.summary))],
    ["POST", /^\/api\/edges\/([^/]+)$/, ({ p, body, params }) => updateEdge(p, id(params), { summary: opt(body.summary), outline: strings(body.outline), text: opt(body.text) })],
    ["POST", /^\/api\/edges\/([^/]+)\/delete$/, ({ p, params }) => deleteEdge(p, id(params))],
    ["POST", /^\/api\/edges\/([^/]+)\/check$/, ({ params }) => {
      const e = id(params);
      return background(`check ${e}`, async (say) => {
        const c = contexts(fresh(), "check");
        const r = await checkEdge(fresh(), c, e, { onProgress: say });
        return { saved: r.saved.map((x) => x.id), calls: c.log.totals().calls };
      });
    }],

    // routes
    ["POST", /^\/api\/routes$/, ({ p, body }) => saveRoute(p, { id: opt(body.id), name: opt(body.name) ?? "", nodes: strings(body.nodes) ?? [] })],
    ["POST", /^\/api\/routes\/([^/]+)\/delete$/, ({ p, params }) => deleteRoute(p, id(params))],
    ["POST", /^\/api\/routes\/([^/]+)\/check$/, ({ p, params, body }) => {
      const r: Route = findRoute(p, id(params));
      return background(`check route ${r.name}`, async (say) => {
        const c = contexts(fresh(), "check");
        const info = await checkRoute(fresh(), c, r, { force: body.force === true, onProgress: say });
        return { score: info.score, calls: c.log.totals().calls };
      });
    }],
    ["POST", /^\/api\/routes\/([^/]+)\/outline$/, ({ p, params }) => {
      const out = routeOutline(p, findRoute(p, id(params)));
      return { text: out.text, file: out.file };
    }],

    // constraints
    ["POST", /^\/api\/profiles$/, ({ p, body }) => ({ file: createProfile(p, { id: s(body.id, "id"), name: s(body.name, "name"), core: opt(body.core) }) })],
    ["POST", /^\/api\/profiles\/([^/]+)$/, ({ p, body, params }) => {
      updateProfileMeta(p, id(params), { name: opt(body.name), core: opt(body.core) });
      return afterConstraintChange([]);
    }],
    ["POST", /^\/api\/constraints$/, ({ p, body }) => {
      const key = addConstraint(p, s(body.owner, "owner"), s(body.field, "field") as ConstraintField, { text: opt(body.text), secret: body.secret === true, permanent: body.permanent === true });
      return { key, ...afterConstraintChange([key]) };
    }],
    ["POST", /^\/api\/constraints\/([^/]+)\/([^/]+)\/([^/]+)$/, ({ p, body, params }) => {
      const key = editConstraint(p, id(params, 0), id(params, 1) as ConstraintField, id(params, 2), {
        text: opt(body.text),
        secret: typeof body.secret === "boolean" ? body.secret : undefined,
        permanent: typeof body.permanent === "boolean" ? body.permanent : undefined,
      });
      return { key, ...afterConstraintChange([key]) };
    }],
    ["POST", /^\/api\/constraints\/([^/]+)\/([^/]+)\/([^/]+)\/delete$/, ({ p, params }) => {
      removeConstraint(p, id(params, 0), id(params, 1) as ConstraintField, id(params, 2));
      return afterConstraintChange([]);
    }],
    ["POST", /^\/api\/constraints\/check$/, () => afterConstraintChange([])],
    ["POST", /^\/api\/graph\/rerun$/, () =>
      background("re-check stale", async (say) => {
        markStale(fresh());
        const c = contexts(fresh(), "check");
        return rerunGraph(fresh(), c, (pp) => checkConstraints(pp, c), say);
      })],
  ];
}

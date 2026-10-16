import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useCallback, useEffect, useRef, useState } from "react";
import { get, inTauri, post, setBase, useGraph } from "./api";
import { Board, type BoardApi } from "./board/Board";
import { type Pt, shortestPath } from "./board/geometry";
import { ConstraintsPanel } from "./panels/Constraints";
import { Inspector } from "./panels/Inspector";
import { RoutesPanel } from "./panels/Routes";
import type { Selection } from "./types";

const RECENT = "sw.recent";
const recent = (): string[] => {
  try {
    return JSON.parse(localStorage.getItem(RECENT) ?? "[]") as string[];
  } catch {
    return [];
  }
};
const remember = (path: string) => {
  try {
    localStorage.setItem(RECENT, JSON.stringify([path, ...recent().filter((p) => p !== path)].slice(0, 8)));
  } catch {
    /* not remembered */
  }
};

/** Wait for a freshly started backend to answer (it needs a second or two to boot). */
async function waitForBackend(): Promise<void> {
  for (let i = 0; i < 150; i++) {
    try {
      await get("/api/graph");
      return;
    } catch {
      if (inTauri() && i > 5 && !(await invoke<boolean>("backend_alive"))) throw new Error("The backend stopped. Is Node installed, and is this a StoryWriter project?");
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error("The backend did not answer in 30 seconds.");
}

export function App() {
  const browserApi = new URLSearchParams(location.search).get("api");
  const [ready, setReady] = useState(false);
  const [opening, setOpening] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    if (!browserApi) return;
    setBase(browserApi);
    waitForBackend().then(() => setReady(true), (e: Error) => setStartError(e.message));
  }, [browserApi]);

  const openProject = useCallback(async (path: string) => {
    setOpening(path);
    setStartError(null);
    try {
      setBase(await invoke<string>("open_project", { path }));
      await waitForBackend();
      remember(path);
      setReady(true);
    } catch (e) {
      setStartError(String((e as Error).message ?? e));
    } finally {
      setOpening(null);
    }
  }, []);

  if (!ready) return <StartScreen onOpen={openProject} opening={opening} error={startError} browser={!!browserApi} />;
  return <Workspace onClose={browserApi ? undefined : () => setReady(false)} />;
}

function StartScreen(props: { onOpen(path: string): void; opening: string | null; error: string | null; browser: boolean }) {
  const [name, setName] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const pick = async () => {
    const dir = await open({ directory: true, title: "Open a StoryWriter project folder" });
    if (typeof dir === "string") props.onOpen(dir);
  };
  const create = async () => {
    setErr(null);
    const parent = await open({ directory: true, title: "Where should the new project folder go?" });
    if (typeof parent !== "string") return;
    const path = `${parent.replace(/[\\/]+$/, "")}\\${name.trim()}`;
    try {
      await invoke("init_project", { path, name: name.trim() });
      props.onOpen(path);
    } catch (e) {
      setErr(String(e));
    }
  };
  return (
    <div className="start">
      <div className="start-card">
        <h1>StoryWriter</h1>
        <p className="muted">Grow a story from states. Place moments on the canvas, connect them, and check how plausible each step is.</p>
        {props.browser ? (
          <p>{props.error ?? "Connecting to the backend…"}</p>
        ) : (
          <>
            <button className="primary wide" onClick={pick} disabled={!!props.opening}>
              Open project folder…
            </button>
            <div className="row">
              <input placeholder="New project name" value={name} onChange={(e) => setName(e.target.value)} />
              <button disabled={!name.trim() || !!props.opening} onClick={create}>
                Create…
              </button>
            </div>
            {recent().length > 0 && (
              <>
                <h4>Recent</h4>
                {recent().map((p) => (
                  <button key={p} className="link recent" onClick={() => props.onOpen(p)} disabled={!!props.opening}>
                    {p}
                  </button>
                ))}
              </>
            )}
            {props.opening && <p className="muted">Starting the backend for {props.opening}…</p>}
            {(props.error || err) && <p className="error-text">{props.error ?? err}</p>}
          </>
        )}
      </div>
    </div>
  );
}

function Workspace(props: { onClose?: () => void }) {
  const { view, error, jobs, toasts, act, toast } = useGraph(true);
  const [selection, setSelection] = useState<Selection>(null);
  const [tab, setTab] = useState<"constraints" | "routes">("constraints");
  const [activeRoute, setActiveRoute] = useState<string | null>(null);
  const [draft, setDraft] = useState<string[] | null>(null);
  const [newNode, setNewNode] = useState<Pt | null>(null);
  const [outline, setOutline] = useState<{ text: string; file: string } | null>(null);
  const [showIssues, setShowIssues] = useState(false);
  const board = useRef<BoardApi>(null);
  const busy = jobs.length > 0;

  // drop a selection whose object was deleted (here or in an editor). Only things that were there
  // and vanished: a just-created object is selected before the refetch shows it.
  const known = useRef(new Set<string>());
  useEffect(() => {
    if (!view) return;
    const ids = new Set([...view.nodes.map((n) => `node:${n.id}`), ...view.edges.map((e) => `edge:${e.id}`)]);
    if (selection) {
      const key = `${selection.kind}:${selection.id}`;
      if (!ids.has(key) && known.current.has(key)) setSelection(null);
    }
    known.current = ids;
  }, [view, selection]);

  const deleteSelection = useCallback(() => {
    if (!selection || !view) return;
    if (selection.kind === "node") {
      const n = view.nodes.find((x) => x.id === selection.id);
      if (n && confirm(`Delete "${n.title}" and every edge touching it?`)) void act(() => post(`/api/nodes/${encodeURIComponent(n.id)}/delete`));
    } else if (confirm("Delete this edge and its check results?")) {
      void act(() => post(`/api/edges/${encodeURIComponent(selection.id)}/delete`));
    }
  }, [selection, view, act]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("input, textarea, select, [contenteditable]")) return;
      if (e.key === "Escape") {
        if (draft) setDraft(null);
        else setSelection(null);
      } else if ((e.key === "Delete" || e.key === "Backspace") && selection) {
        e.preventDefault();
        deleteSelection();
      } else if (e.key === "f" || e.key === "F") board.current?.fit();
      else if (e.key === "n" || e.key === "N") setNewNode(board.current?.center() ?? { x: 0, y: 0 });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, selection, deleteSelection]);

  if (!view) return <div className="start">{error ? <p className="error-text">{error}</p> : <p className="muted">Loading…</p>}</div>;

  if (view.mode !== "graph") {
    return (
      <div className="start">
        <div className="start-card">
          <h2>{view.name}</h2>
          <p>This project uses the timeline layout. The canvas needs graph mode: nodes get their order from the edges you draw instead of a fixed time value.</p>
          <p className="muted small">Snapshots, bridges, profiles and checks are kept. You can switch back by removing `mode: graph` from project.yaml.</p>
          <div className="row">
            <button className="primary" onClick={() => act(() => post("/api/graph/enable"))}>
              Switch to graph mode
            </button>
            {props.onClose && <button onClick={props.onClose}>Back</button>}
          </div>
        </div>
      </div>
    );
  }

  const staleCount = view.checks.filter((c) => c.isStale).length;
  const errors = view.issues.filter((i) => i.level === "error");
  const highlight = draft ?? view.routes.find((r) => r.id === activeRoute)?.nodes ?? [];

  const onRouteClick = (node: string) => {
    setDraft((d) => {
      if (!d || !d.length) return [node];
      const last = d[d.length - 1]!;
      if (node === last) return d;
      const path = shortestPath(last, node, view.edges);
      if (!path) {
        toast("error", `No path of edges leads from "${view.nodes.find((n) => n.id === last)?.title}" to "${view.nodes.find((n) => n.id === node)?.title}".`);
        return d;
      }
      return [...d, ...path.slice(1)];
    });
  };

  return (
    <div className="app">
      <header>
        <b className="title">{view.name}</b>
        <span className="muted small path" title={view.root}>
          {view.root}
        </span>
        <span className="spacer" />
        {draft && <span className="chip accent">Route mode · click nodes · Esc to cancel</span>}
        <button onClick={() => setNewNode(board.current?.center() ?? { x: 0, y: 0 })} title="New node (N, or double-click the board)">
          + Node
        </button>
        <button onClick={() => board.current?.fit()} title="Fit everything (F)">
          Fit
        </button>
        {staleCount > 0 && (
          <button disabled={busy} onClick={() => act(() => post("/api/graph/rerun"))}>
            Re-check {staleCount} stale
          </button>
        )}
        {errors.length > 0 && (
          <button className="danger-outline" onClick={() => setShowIssues(!showIssues)}>
            {errors.length} problem{errors.length > 1 ? "s" : ""}
          </button>
        )}
        {props.onClose && (
          <button onClick={props.onClose} title="Close this project">
            Close
          </button>
        )}
      </header>

      <div className="body">
      <aside className="left">
        <div className="tabs">
          <button className={tab === "constraints" ? "on" : ""} onClick={() => setTab("constraints")}>
            Constraints
          </button>
          <button className={tab === "routes" ? "on" : ""} onClick={() => setTab("routes")}>
            Routes {view.routes.length > 0 && <span className="muted">({view.routes.length})</span>}
          </button>
        </div>
        {tab === "constraints" ? (
          <ConstraintsPanel view={view} act={act} busy={busy} />
        ) : (
          <RoutesPanel
            view={view}
            act={act}
            busy={busy}
            active={activeRoute}
            setActive={setActiveRoute}
            draft={draft}
            startDraft={() => {
              setSelection(null);
              setDraft([]);
            }}
            cancelDraft={() => setDraft(null)}
            undoDraft={() => setDraft((d) => (d ? d.slice(0, -1) : d))}
            saveDraft={async (name) => {
              const r = await act(() => post<{ id: string }>("/api/routes", { name, nodes: draft }));
              if (r) {
                setDraft(null);
                setActiveRoute(r.id);
              }
            }}
            onOutline={(text, file) => setOutline({ text, file })}
          />
        )}
      </aside>

      <main>
        <Board
          view={view}
          selection={selection}
          mode={draft ? "route" : "select"}
          highlight={highlight}
          apiRef={board}
          onSelect={setSelection}
          onMove={(positions) => void act(() => post("/api/layout", { positions }))}
          onCreateNode={setNewNode}
          onConnect={async (from, to) => {
            const r = await act(() => post<{ id: string }>("/api/edges", { from, to }));
            if (r) setSelection({ kind: "edge", id: r.id });
          }}
          onRouteClick={onRouteClick}
        />
        {view.nodes.length === 0 && <div className="empty-hint">Double-click anywhere to place your first moment.</div>}
        {jobs.length > 0 && (
          <div className="jobs">
            {jobs.map((j) => (
              <div key={j.id} className="job">
                <span className="spinner" /> {j.what}
                {j.progress.length > 0 && <div className="muted small">{j.progress.at(-1)}</div>}
              </div>
            ))}
          </div>
        )}
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className={`toast ${t.kind}`}>
              {t.text}
            </div>
          ))}
        </div>
      </main>

      {selection && (
        <aside className="right">
          <Inspector view={view} selection={selection} act={act} busy={busy} onSelect={setSelection} />
        </aside>
      )}
      </div>

      {newNode && (
        <NewNodeDialog
          onCancel={() => setNewNode(null)}
          onCreate={async (title) => {
            const r = await act(() => post<{ id: string }>("/api/nodes", { title, x: Math.round(newNode.x), y: Math.round(newNode.y) }));
            setNewNode(null);
            if (r) setSelection({ kind: "node", id: r.id });
          }}
        />
      )}

      {outline && (
        <div className="modal-back" onClick={() => setOutline(null)}>
          <div className="modal wide-modal" onClick={(e) => e.stopPropagation()}>
            <div className="row">
              <b>Outline</b>
              <span className="muted small">saved to {outline.file}</span>
              <span className="spacer" />
              <button onClick={() => navigator.clipboard.writeText(outline.text).then(() => toast("info", "Copied"))}>Copy</button>
              <button onClick={() => setOutline(null)}>Close</button>
            </div>
            <pre className="outline">{outline.text}</pre>
          </div>
        </div>
      )}

      {showIssues && (
        <div className="modal-back" onClick={() => setShowIssues(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <b>Project problems</b>
            {errors.map((i, k) => (
              <p key={k} className="small">
                <code>
                  {i.file}
                  {i.line ? `:${i.line}` : ""}
                </code>{" "}
                {i.message}
              </p>
            ))}
            <button onClick={() => setShowIssues(false)}>Close</button>
          </div>
        </div>
      )}
    </div>
  );
}

function NewNodeDialog(props: { onCreate(title: string): void; onCancel(): void }) {
  const [title, setTitle] = useState("");
  return (
    <div className="modal-back" onClick={props.onCancel}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <b>New moment</b>
        <input
          autoFocus
          placeholder="Title, e.g. 安可登记为第五人"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing && title.trim()) props.onCreate(title.trim());
            if (e.key === "Escape") props.onCancel();
          }}
        />
        <div className="row">
          <button className="primary" disabled={!title.trim()} onClick={() => props.onCreate(title.trim())}>
            Create
          </button>
          <button onClick={props.onCancel}>Cancel</button>
        </div>
      </div>
    </div>
  );
}

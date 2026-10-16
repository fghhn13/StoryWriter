// Left panel, second tab: saved routes, their scores (weakest edge), checking and the outline export.
import { useState } from "react";
import { enc, post } from "../api";
import type { GraphView, RouteInfo } from "../types";
import { levelOf } from "../types";

type Act = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

export function RoutesPanel(props: {
  view: GraphView;
  act: Act;
  busy: boolean;
  active: string | null;
  setActive(id: string | null): void;
  draft: string[] | null;
  startDraft(): void;
  cancelDraft(): void;
  saveDraft(name: string): void;
  undoDraft(): void;
  onOutline(text: string, file: string): void;
}) {
  const { view, act } = props;
  const [name, setName] = useState("");
  const title = (id: string) => view.nodes.find((n) => n.id === id)?.title ?? id;

  return (
    <div className="panel-scroll">
      {props.draft ? (
        <div className="route-draft">
          <b>New route</b>
          <p className="muted small">Click nodes on the board in story order. Clicking a node further down fills in the shortest path to it.</p>
          <ol className="route-nodes">
            {props.draft.map((n, i) => (
              <li key={`${n}-${i}`}>{title(n)}</li>
            ))}
          </ol>
          <input placeholder="Route name" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="row">
            <button
              className="primary"
              disabled={props.draft.length < 2}
              onClick={() => {
                props.saveDraft(name.trim() || `Route ${view.routes.length + 1}`);
                setName("");
              }}
            >
              Save route
            </button>
            <button disabled={!props.draft.length} onClick={props.undoDraft}>
              Undo
            </button>
            <button onClick={props.cancelDraft}>Cancel</button>
          </div>
        </div>
      ) : (
        <button className="wide" onClick={props.startDraft} disabled={view.edges.length === 0}>
          + New route
        </button>
      )}

      {view.routes.length === 0 && !props.draft && <p className="muted small">A route is a path through the graph. Its deviation is its weakest edge.</p>}
      {view.routes.map((r) => (
        <RouteCard key={r.id} view={view} route={r} act={act} busy={props.busy} active={props.active === r.id} onToggle={() => props.setActive(props.active === r.id ? null : r.id)} onOutline={props.onOutline} title={title} />
      ))}
    </div>
  );
}

function RouteCard(props: { view: GraphView; route: RouteInfo; act: Act; busy: boolean; active: boolean; onToggle(): void; onOutline(text: string, file: string): void; title(id: string): string }) {
  const { view, route: r, act } = props;
  const unchecked = r.edges.filter((e) => !e.checked).length;
  const stale = r.edges.filter((e) => e.stale).length;
  const level = r.edges.length ? (r.complete || r.score > 0 ? worst(view, r) : "none") : "none";
  return (
    <div className={`route ${props.active ? "active" : ""}`}>
      <button className="route-head" onClick={props.onToggle}>
        <span className={`pill lvl-${level}`}>{r.complete || r.score ? r.score : "—"}</span>
        <b>{r.name}</b>
        <span className="spacer" />
        <span className="muted small">{r.nodes.length} nodes</span>
      </button>
      {r.broken ? (
        <p className="note">⚠ {r.broken}</p>
      ) : (
        <>
          <p className="muted small route-path">{r.nodes.map(props.title).join(" → ")}</p>
          {(unchecked > 0 || stale > 0) && (
            <p className="small warn-text">
              {unchecked > 0 && `${unchecked} edge${unchecked > 1 ? "s" : ""} unchecked`}
              {unchecked > 0 && stale > 0 && " · "}
              {stale > 0 && `${stale} stale`}
              {" — the score is incomplete"}
            </p>
          )}
          {props.active && (
            <div className="route-edges">
              {r.edges.map((e) => (
                <div key={e.id} className={`route-edge ${r.weakest === e.id ? "weakest" : ""}`}>
                  <span className={`pill lvl-${e.checked ? worstEdge(view, e.axes) : "none"}`}>{e.checked ? e.score : "—"}</span>
                  <span className="small">
                    {props.title(e.from)} → {props.title(e.to)}
                  </span>
                  <span className="spacer" />
                  <span className="muted small">{Object.entries(e.axes).map(([a, v]) => `${a} ${v}`).join(" · ")}</span>
                </div>
              ))}
            </div>
          )}
          <div className="row">
            <button disabled={props.busy} onClick={() => act(() => post(`/api/routes/${enc(r.id)}/check`))}>
              Check route
            </button>
            <button
              className="primary"
              onClick={async () => {
                const out = await act(() => post<{ text: string; file: string }>(`/api/routes/${enc(r.id)}/outline`));
                if (out) props.onOutline(out.text, out.file);
              }}
            >
              Write to outline
            </button>
            <span className="spacer" />
            <button className="icon" title="Delete route" onClick={() => confirm(`Delete route "${r.name}"?`) && act(() => post(`/api/routes/${enc(r.id)}/delete`))}>
              ×
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function worstEdge(view: GraphView, axes: RouteInfo["edges"][number]["axes"]) {
  const rank = { none: 0, ok: 1, warn: 2, high: 3 } as const;
  let w: keyof typeof rank = "ok";
  for (const [a, v] of Object.entries(axes)) {
    const l = levelOf(view, a as never, v!);
    if (rank[l] > rank[w]) w = l;
  }
  return w;
}

function worst(view: GraphView, r: RouteInfo) {
  const rank = { none: 0, ok: 1, warn: 2, high: 3 } as const;
  let w: keyof typeof rank = "ok";
  for (const e of r.edges) {
    const l = worstEdge(view, e.axes);
    if (rank[l] > rank[w]) w = l;
  }
  return w;
}

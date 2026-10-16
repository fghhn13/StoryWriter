import { useState } from "react";
import { post, useProject } from "./api";
import { Canvas } from "./Canvas";
import { Dialog, type DialogState } from "./Dialogs";
import { Panel } from "./Panel";
import type { Selection } from "./types";

export function App() {
  const { view, error, jobs, reload } = useProject();
  const [selection, setSelection] = useState<Selection>(null);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [toast, setToast] = useState<{ text: string; error?: boolean } | null>(null);
  const [showPruned, setShowPruned] = useState(false);

  /** Run an operation; the file watcher refreshes the canvas, errors are shown as they come back. */
  const run = (f: () => Promise<unknown>, ok?: string) => {
    void f().then(
      () => {
        if (ok) setToast({ text: ok });
        void reload();
      },
      (e: Error) => setToast({ text: e.message, error: true }),
    );
  };

  if (error && !view) return <div className="fatal">读取项目失败：{error}</div>;
  if (!view) return <div className="fatal">加载中…</div>;
  const errors = view.issues.filter((i) => i.level === "error").length;
  const openChecks = view.checks.filter((c) => c.status === "open" && !c.isStale).length;

  return (
    <div className="app">
      <header>
        <h1 onClick={() => setSelection(null)}>{view.name}</h1>
        <div className="toolbar">
          <button onClick={() => setDialog({ kind: "start" })}>起点草稿</button>
          <button onClick={() => setDialog({ kind: "snapshot" })}>手写快照</button>
          <button onClick={() => setDialog({ kind: "thread" })}>插伏笔</button>
          <button className={view.stale.length ? "warn" : ""} onClick={() => setDialog({ kind: "rerun" })}>
            重跑过期 {view.stale.length ? `(${view.stale.length})` : ""}
          </button>
          <button onClick={() => setDialog({ kind: "export" })}>导出</button>
          <label className="inline">
            <input type="checkbox" checked={showPruned} onChange={(e) => setShowPruned(e.target.checked)} />
            显示落选候选
          </label>
        </div>
        <div className="summary" onClick={() => setSelection(null)}>
          {openChecks} 待处理 · {view.stale.length} 过期{errors ? ` · ⚠ ${errors} 个文件错误` : ""}
        </div>
      </header>

      {jobs.length > 0 && (
        <div className="jobs">
          {jobs.map((j) => (
            <div key={j.id}>
              ⏳ {j.what.replace("/api/", "")} {j.progress.at(-1) ?? "（调用模型中，可能要几分钟）"}
            </div>
          ))}
        </div>
      )}
      {toast && (
        <div className={`toast ${toast.error ? "error" : ""}`} onClick={() => setToast(null)}>
          {toast.text}
        </div>
      )}

      <main>
        <Canvas
          view={view}
          selection={selection}
          onSelect={setSelection}
          onAddPoint={(from, to) => setDialog({ kind: "candidates", from, to })}
          onNewBridge={(from, to) =>
            run(async () => {
              const r = await post<{ id: string }>("/api/bridges", { from, to });
              setSelection({ kind: "bridge", id: r.id });
            }, "桥已建，在侧栏里生成大纲")
          }
          onReorder={(order) => run(() => post("/api/lanes/order", { order }))}
          showPruned={showPruned}
        />
        <aside>
          <Panel
            view={view}
            selection={selection}
            run={run}
            onSelect={setSelection}
            onAddPoint={(from, to) => setDialog({ kind: "candidates", from, to })}
            onNewSnapshot={(t) => setDialog({ kind: "snapshot", t })}
          />
        </aside>
      </main>
      <Dialog view={view} state={dialog} close={() => setDialog(null)} run={run} />
    </div>
  );
}

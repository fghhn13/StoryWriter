// Modal forms for the canvas operations (spec §7 操作): new snapshot, start draft, candidates,
// thread, rerun, export.
import { type ReactNode, useEffect, useState } from "react";
import { get, post } from "./api";
import type { CharState, View } from "./types";

type Run = (f: () => Promise<unknown>, ok?: string) => void;

export type DialogState =
  | { kind: "snapshot"; t?: number }
  | { kind: "start" }
  | { kind: "candidates"; from: string; to: string }
  | { kind: "thread" }
  | { kind: "rerun" }
  | { kind: "export" }
  | null;

function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="modal-back" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>{title}</h3>
          <button className="link" onClick={onClose}>
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

const lines = (s: string) => s.split("\n").map((x) => x.trim()).filter(Boolean);

export function Dialog({ view, state, close, run }: { view: View; state: DialogState; close: () => void; run: Run }) {
  if (!state) return null;
  const done = (f: () => Promise<unknown>, ok: string) => {
    close();
    run(f, ok);
  };
  switch (state.kind) {
    case "snapshot":
      return <NewSnapshot view={view} t={state.t} close={close} done={done} />;
    case "start":
      return <StartDraft view={view} close={close} done={done} />;
    case "candidates":
      return <Candidates from={state.from} to={state.to} close={close} done={done} />;
    case "thread":
      return <NewThread view={view} close={close} done={done} />;
    case "rerun":
      return <Rerun close={close} done={done} />;
    case "export":
      return <Export close={close} />;
  }
}

type Done = (f: () => Promise<unknown>, ok: string) => void;

function NewSnapshot({ view, t, close, done }: { view: View; t?: number; close: () => void; done: Done }) {
  const chars = view.lanes.filter((l) => l.kind === "character");
  const [f, setF] = useState({ id: "", title: "", t: t ?? 0, t_label: "", status: "approved", world: "", notes: "" });
  const [lanes, setLanes] = useState<string[]>(view.lanes.map((l) => l.id));
  const [states, setStates] = useState<Record<string, { knows: string; wants: string; feels: string; location: string }>>({});
  const st = (id: string) => states[id] ?? { knows: "", wants: "", feels: "", location: "" };
  const submit = () => {
    const char_states: Record<string, CharState> = {};
    for (const c of chars) {
      if (!lanes.includes(c.id)) continue;
      const s = st(c.id);
      char_states[c.id] = { knows: lines(s.knows), wants: lines(s.wants), relationships: {}, ...(s.feels ? { feels: s.feels } : {}), ...(s.location ? { location: s.location } : {}) };
    }
    const data = { id: f.id, title: f.title, t: Number(f.t), ...(f.t_label ? { t_label: f.t_label } : {}), lanes, world_facts: lines(f.world), char_states, status: f.status, origin: "author" };
    done(() => post("/api/snapshots", { data, notes: f.notes }), `快照 ${f.id} 已建`);
  };
  return (
    <Modal title="手写快照" onClose={close}>
      <div className="grid2">
        <label>
          id
          <input value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} placeholder="s-xxx" />
        </label>
        <label>
          标题
          <input value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        </label>
        <label>
          t（可以是小数）
          <input type="number" step="0.1" value={f.t} onChange={(e) => setF({ ...f, t: Number(e.target.value) })} />
        </label>
        <label>
          时间标签（可空）
          <input value={f.t_label} onChange={(e) => setF({ ...f, t_label: e.target.value })} />
        </label>
        <label>
          状态
          <select value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
            <option value="approved">approved（能作桥端点）</option>
            <option value="sketch">sketch</option>
            <option value="seed">seed（想法）</option>
          </select>
        </label>
      </div>
      <div className="inline-list">
        泳道：
        {view.lanes.map((l) => (
          <label key={l.id} className="inline">
            <input type="checkbox" checked={lanes.includes(l.id)} onChange={(e) => setLanes(e.target.checked ? [...lanes, l.id] : lanes.filter((x) => x !== l.id))} />
            {l.name ?? l.id}
          </label>
        ))}
      </div>
      <label>
        世界事实（一行一条）
        <textarea rows={3} value={f.world} onChange={(e) => setF({ ...f, world: e.target.value })} />
      </label>
      {chars
        .filter((c) => lanes.includes(c.id))
        .map((c) => (
          <fieldset key={c.id}>
            <legend>{c.name ?? c.id}</legend>
            <div className="grid2">
              <label>
                知道（一行一条）
                <textarea rows={2} value={st(c.id).knows} onChange={(e) => setStates({ ...states, [c.id]: { ...st(c.id), knows: e.target.value } })} />
              </label>
              <label>
                想要（一行一条）
                <textarea rows={2} value={st(c.id).wants} onChange={(e) => setStates({ ...states, [c.id]: { ...st(c.id), wants: e.target.value } })} />
              </label>
              <label>
                情绪
                <input value={st(c.id).feels} onChange={(e) => setStates({ ...states, [c.id]: { ...st(c.id), feels: e.target.value } })} />
              </label>
              <label>
                位置
                <input value={st(c.id).location} onChange={(e) => setStates({ ...states, [c.id]: { ...st(c.id), location: e.target.value } })} />
              </label>
            </div>
          </fieldset>
        ))}
      <label>
        作者备注（约束等）
        <textarea rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
      </label>
      <p className="muted">关系、资源等其他字段：建好后在侧栏"编辑字段"里补。</p>
      <div className="actions">
        <button className="primary" disabled={!f.id || !f.title} onClick={submit}>
          建快照
        </button>
      </div>
    </Modal>
  );
}

function StartDraft({ view, close, done }: { view: View; close: () => void; done: Done }) {
  const chars = view.lanes.filter((l) => l.kind === "character");
  const [id, setId] = useState("s-start");
  const [t, setT] = useState(0);
  const [opening, setOpening] = useState("");
  const [sel, setSel] = useState(chars.map((c) => c.profile ?? c.id));
  return (
    <Modal title="起草起点快照（U2）" onClose={close}>
      <p className="muted">模型根据档案里的已定事实（不含"人物不知道"的）和你的开场设定起草，结果是 sketch，改好后批准。</p>
      <div className="grid2">
        <label>
          id
          <input value={id} onChange={(e) => setId(e.target.value)} />
        </label>
        <label>
          t
          <input type="number" value={t} onChange={(e) => setT(Number(e.target.value))} />
        </label>
      </div>
      <div className="inline-list">
        人物：
        {chars.map((c) => {
          const pid = c.profile ?? c.id;
          return (
            <label key={c.id} className="inline">
              <input type="checkbox" checked={sel.includes(pid)} onChange={(e) => setSel(e.target.checked ? [...sel, pid] : sel.filter((x) => x !== pid))} />
              {c.name ?? c.id}
            </label>
          );
        })}
      </div>
      <label>
        开场设定
        <textarea rows={5} value={opening} onChange={(e) => setOpening(e.target.value)} />
      </label>
      <div className="actions">
        <button className="primary" disabled={!id || !opening.trim()} onClick={() => done(() => post("/api/start-draft", { id, t, opening, characters: sel }), "起点草稿已生成（sketch），在侧栏里改好后批准")}>
          生成草稿
        </button>
      </div>
    </Modal>
  );
}

function Candidates({ from, to, close, done }: { from: string; to: string; close: () => void; done: Done }) {
  const [dims, setDims] = useState("谁推动，冲突在哪");
  const [k, setK] = useState(3);
  return (
    <Modal title={`加点：${from} → ${to}`} onClose={close}>
      <p className="muted">生成 2–4 个候选中间快照，放在画布下方的"候选"行。挑一个批准，其余的标为落选，以后还可以嫁接回来。</p>
      <label>
        候选之间必须不同的维度（逗号分隔）
        <input value={dims} onChange={(e) => setDims(e.target.value)} />
      </label>
      <label>
        候选数
        <select value={k} onChange={(e) => setK(Number(e.target.value))}>
          {[2, 3, 4].map((n) => (
            <option key={n}>{n}</option>
          ))}
        </select>
      </label>
      <div className="actions">
        <button className="primary" disabled={!dims.trim()} onClick={() => done(() => post("/api/candidates", { from, to, dims, k }), "候选已生成")}>
          生成候选
        </button>
      </div>
    </Modal>
  );
}

function NewThread({ view, close, done }: { view: View; close: () => void; done: Done }) {
  const points = [...view.snapshots.filter((s) => s.endpoint).map((s) => ({ id: s.id, label: `快照 ${s.id}（t=${s.t}）` })), ...view.bridges.map((b) => ({ id: b.id, label: `桥 ${b.id}` }))];
  const [f, setF] = useState({ id: "", description: "", planted_at: points[0]?.id ?? "", payoff_at: "", visibility: "reader_only" });
  const [known, setKnown] = useState<string[]>([]);
  return (
    <Modal title="插伏笔（U7）" onClose={close}>
      <div className="grid2">
        <label>
          id
          <input value={f.id} onChange={(e) => setF({ ...f, id: e.target.value })} placeholder="th-xxx" />
        </label>
        <label>
          可见性
          <select value={f.visibility} onChange={(e) => setF({ ...f, visibility: e.target.value })}>
            <option value="reader_only">读者知道，人物不知道</option>
            <option value="character">某些人物知道</option>
            <option value="hidden">埋了，读者还不该察觉</option>
          </select>
        </label>
        <label>
          埋点
          <select value={f.planted_at} onChange={(e) => setF({ ...f, planted_at: e.target.value })}>
            {points.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
        <label>
          收点（可空）
          <select value={f.payoff_at} onChange={(e) => setF({ ...f, payoff_at: e.target.value })}>
            <option value="">（未收）</option>
            {points.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {f.visibility === "character" && (
        <div className="inline-list">
          谁知道：
          {view.profiles.map((p) => (
            <label key={p.id} className="inline">
              <input type="checkbox" checked={known.includes(p.id)} onChange={(e) => setKnown(e.target.checked ? [...known, p.id] : known.filter((x) => x !== p.id))} />
              {p.name}
            </label>
          ))}
        </div>
      )}
      <label>
        这条线的内容
        <textarea rows={3} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      </label>
      <p className="muted">插入后自动跑轴 E：埋点之后每个快照和桥各调用 {view.sampling} 次。</p>
      <div className="actions">
        <button
          className="primary"
          disabled={!f.id || !f.description.trim() || !f.planted_at}
          onClick={() => done(() => post("/api/threads", { ...f, payoff_at: f.payoff_at || undefined, known_by: known }), "伏笔已插入，轴 E 已跑完")}
        >
          插入并检查
        </button>
      </div>
    </Modal>
  );
}

interface Plan {
  items: { kind: string; target: string; axes: string[]; n: number; calls: number }[];
  calls: number;
  orphans: string[];
}

function Rerun({ close, done }: { close: () => void; done: Done }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    get<Plan>("/api/rerun-plan").then(setPlan, (e: Error) => setErr(e.message));
  }, []);
  return (
    <Modal title="重跑过期检查（U8）" onClose={close}>
      {err && <p className="error">{err}</p>}
      {!plan ? (
        <p>计算中…</p>
      ) : !plan.items.length ? (
        <p>没有过期的检查。</p>
      ) : (
        <>
          <ul>
            {plan.items.map((i) => (
              <li key={i.target}>
                {i.kind === "bridge" ? "桥" : "线"} {i.target}：轴 {i.axes.join("、")} × {i.n} 次采样 ≈ {i.calls} 次调用
              </li>
            ))}
          </ul>
          {plan.orphans.length > 0 && <p className="note">对象已不存在、只能删除的检查：{plan.orphans.join("、")}</p>}
          <p>
            <b>预计约 {plan.calls} 次模型调用</b>（格式修复可能额外增加；提示没变的请求会复用录制）。
          </p>
          <div className="actions">
            <button className="primary" onClick={() => done(() => post("/api/rerun"), "过期检查已重跑")}>
              确认重跑
            </button>
          </div>
        </>
      )}
    </Modal>
  );
}

function Export({ close }: { close: () => void }) {
  const [what, setWhat] = useState<"manuscript" | "report" | "harvest">("manuscript");
  const [data, setData] = useState<{ text: string; skipped?: string[]; count?: number } | null>(null);
  useEffect(() => {
    setData(null);
    void get<{ text: string }>(`/api/export/${what}`).then(setData);
  }, [what]);
  const download = () => {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([data?.text ?? ""], { type: "text/markdown" }));
    a.download = `${what}.md`;
    a.click();
  };
  return (
    <Modal title="导出（U9）" onClose={close}>
      <div className="tabs">
        {(
          [
            ["manuscript", "稿件（locked 桥）"],
            ["report", "未处理的检查"],
            ["harvest", "收获清单"],
          ] as const
        ).map(([k, label]) => (
          <button key={k} className={what === k ? "primary" : ""} onClick={() => setWhat(k)}>
            {label}
          </button>
        ))}
      </div>
      {data?.skipped?.length ? <p className="muted">跳过（未定稿）：{data.skipped.join("、")}</p> : null}
      <textarea className="code" rows={18} readOnly value={data?.text ?? "加载中…"} />
      <div className="actions">
        <button onClick={download} disabled={!data}>
          下载 .md
        </button>
      </div>
    </Modal>
  );
}

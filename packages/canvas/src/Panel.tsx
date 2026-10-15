// Side panel (spec §7 侧栏): fields of the selected object, its checks, and the operations on it.
// Model output carries a visible "模型生成·未确认" mark until the author confirms it (spec §3.1).
import { useEffect, useState } from "react";
import { enc, get, post } from "./api";
import { Checks } from "./Checks";
import type { Bridge, CharState, Entry, Selection, Snapshot, View } from "./types";

type Run = (f: () => Promise<unknown>, ok?: string) => void;

interface Props {
  view: View;
  selection: Selection;
  run: Run;
  onAddPoint: (from: string, to: string) => void;
  onNewSnapshot: (t: number) => void;
  onSelect: (s: Selection) => void;
}

export function Panel(props: Props) {
  const { view, selection } = props;
  if (!selection) return <Overview view={view} />;
  switch (selection.kind) {
    case "snapshot": {
      const s = [...view.snapshots, ...view.branches].find((x) => x.id === selection.id);
      return s ? <SnapshotPanel {...props} s={s} /> : <Gone />;
    }
    case "bridge": {
      const b = view.bridges.find((x) => x.id === selection.id);
      return b ? <BridgePanel {...props} b={b} /> : <Gone />;
    }
    case "thread":
      return <ThreadPanel {...props} id={selection.id} />;
    case "profile":
      return <ProfilePanel view={view} id={selection.id} />;
    case "gap":
      return <GapPanel {...props} from={selection.from} to={selection.to} />;
  }
}

const Gone = () => <p className="muted">这个对象已经不在了。</p>;
const Llm = ({ show, children = "模型生成·未确认" }: { show: boolean; children?: string }) => (show ? <span className="llm-badge">{children}</span> : null);

function Overview({ view }: { view: View }) {
  const open = view.checks.filter((c) => c.status === "open" || c.isStale);
  const errors = view.issues.filter((i) => i.level === "error");
  return (
    <div>
      <h2>{view.name}</h2>
      <p className="muted">{view.root}</p>
      <p>
        {view.snapshots.length} 快照 · {view.bridges.length} 桥 · {view.threads.length} 线 · {open.length} 条待处理检查（{view.stale.length} 条过期）
      </p>
      {!view.voice && <p className="note">⚠ 没有声音样本：正文风格不可控（project.yaml 写 voice_sample）</p>}
      {errors.length > 0 && (
        <>
          <h3>文件问题</h3>
          <ul className="issues">
            {view.issues.map((i, k) => (
              <li key={k} className={i.level}>
                {i.file}
                {i.line ? `:${i.line}` : ""} {i.message}
              </li>
            ))}
          </ul>
        </>
      )}
      <h3>怎么用</h3>
      <ul className="help">
        <li>点快照、桥、伏笔线、间距区域，在这里看字段、检查和操作。</li>
        <li>两个已批准快照之间没有桥时，点虚线"＋搭桥"。</li>
        <li>间距超过阈值时，间距区域里有"＋加点"。</li>
        <li>拖左侧泳道名调整顺序；点人物名看档案。</li>
        <li>在编辑器里改文件，画布会自动刷新。</li>
      </ul>
    </div>
  );
}

function StateBlock({ id, st }: { id: string; st: CharState }) {
  return (
    <div className="state">
      <b>[{id}]</b>
      {st.knows.length > 0 && <div>知道：{st.knows.join("；")}</div>}
      {st.wants.length > 0 && <div>想要：{st.wants.join("；")}</div>}
      {st.feels && <div>情绪：{st.feels}</div>}
      {st.location && <div>位置：{st.location}</div>}
      {Object.keys(st.relationships ?? {}).length > 0 && (
        <div>
          关系：
          {Object.entries(st.relationships)
            .map(([k, v]) => `${k}——${v}`)
            .join("；")}
        </div>
      )}
    </div>
  );
}

function StateView({ world, chars }: { world: string[]; chars: Record<string, CharState> }) {
  return (
    <>
      <h4>世界事实</h4>
      {world.length ? (
        <ul>
          {world.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">（无）</p>
      )}
      <h4>人物状态</h4>
      {Object.entries(chars).map(([k, st]) => (
        <StateBlock key={k} id={k} st={st} />
      ))}
    </>
  );
}

/** Edit any object's frontmatter as YAML + its body (the escape hatch for every free-text field). */
function SourceEditor({ kind, id, run, bodyLabel }: { kind: "snapshot" | "bridge" | "thread"; id: string; run: Run; bodyLabel: string }) {
  const [src, setSrc] = useState<{ yaml: string; body: string } | null>(null);
  useEffect(() => setSrc(null), [id]);
  if (!src)
    return (
      <button onClick={() => void get<{ yaml: string; body: string }>(`/api/objects/${kind}/${enc(id)}`).then(setSrc)}>
        编辑字段
      </button>
    );
  return (
    <div className="form">
      <label>
        字段（YAML，自由文本；id 不能改）
        <textarea className="code" rows={14} value={src.yaml} onChange={(e) => setSrc({ ...src, yaml: e.target.value })} />
      </label>
      <label>
        {bodyLabel}
        <textarea rows={4} value={src.body} onChange={(e) => setSrc({ ...src, body: e.target.value })} />
      </label>
      <div className="actions">
        <button
          className="primary"
          onClick={() => run(() => post(`/api/objects/${kind}/${enc(id)}`, { yaml: src.yaml, body: src.body }).then(() => setSrc(null)), "已保存")}
        >
          保存
        </button>
        <button onClick={() => setSrc(null)}>取消</button>
      </div>
    </div>
  );
}

function SnapshotPanel({ view, s, run }: Props & { s: Snapshot }) {
  const inBranch = view.branches.some((b) => b.id === s.id);
  const threads = view.threads.filter((t) => t.affected.includes(s.id));
  return (
    <div>
      <h2>
        快照 {s.title} <Llm show={s.origin === "llm-candidate"} />
      </h2>
      <p className="muted">
        {s.id} · t={s.t}
        {s.t_label ? `（${s.t_label}）` : ""} · {s.status} · {s.origin}
        {s.pruned ? " · 落选" : ""} · {s.file}
      </p>
      <div className="actions">
        {(s.status === "seed" || s.status === "sketch" || inBranch) && (
          <button className="primary" onClick={() => run(() => post(`/api/snapshots/${enc(s.id)}/approve`), `已批准 ${s.id}`)}>
            批准
          </button>
        )}
        {inBranch && <button onClick={() => run(() => post(`/api/snapshots/${enc(s.id)}/graft`), "已嫁接回时间线（sketch）")}>嫁接回时间线</button>}
        {s.origin === "llm-candidate" && <button onClick={() => run(() => post(`/api/snapshot/${enc(s.id)}/confirm`), "已确认为作者内容")}>确认内容（去掉模型标记）</button>}
      </div>
      {s.candidate && (
        <div className="cand-info">
          {Object.entries(s.candidate.dims).map(([d, v]) => (
            <div key={d}>
              <b>{d}：</b>
              {v}
            </div>
          ))}
          {s.candidate.touches_unknowns.length > 0 && <div className="note">会触碰的留白：{s.candidate.touches_unknowns.join("、")}</div>}
        </div>
      )}
      {threads.length > 0 && <p className="note">⚠ 受伏笔影响：{threads.map((t) => `${t.id}（${t.score}）`).join("、")}</p>}
      <StateView world={s.world_facts} chars={s.char_states} />
      {s.author_notes && (
        <>
          <h4>作者备注</h4>
          <p className="pre">{s.author_notes}</p>
        </>
      )}
      <SourceEditor kind="snapshot" id={s.id} run={run} bodyLabel="作者备注" />
    </div>
  );
}

function BridgePanel({ view, b, run }: Props & { b: Bridge }) {
  const [outline, setOutline] = useState(b.outline.join("\n"));
  const [text, setText] = useState(b.text);
  const [axes, setAxes] = useState(["A", "B", "C", "D"]);
  useEffect(() => {
    setOutline(b.outline.join("\n"));
    setText(b.text);
  }, [b.id, b.outline.join("\n"), b.text]);
  const id = enc(b.id);
  const checks = view.checks.filter((c) => c.target === b.id);
  const outlineDirty = outline !== b.outline.join("\n");
  const textDirty = text !== b.text;
  return (
    <div>
      <h2>
        桥 {b.id} <Llm show={b.text_origin === "llm"} children="正文：模型生成·未确认" />
      </h2>
      <p className="muted">
        {b.from} → {b.to} · {b.status} · {b.file}
      </p>

      <h3>
        1. 大纲 <Llm show={b.outline_origin === "llm"} />
      </h3>
      <textarea rows={Math.max(4, b.outline.length + 1)} value={outline} onChange={(e) => setOutline(e.target.value)} placeholder="一行一个节拍；可以先让模型生成" />
      <div className="actions">
        <button onClick={() => run(() => post(`/api/bridges/${id}/outline`), "大纲已生成（模型），改完再写正文")}>生成大纲</button>
        <button disabled={!outlineDirty} onClick={() => run(() => post(`/api/bridges/${id}/save`, { outline: outline.split("\n") }), "大纲已保存")}>
          保存大纲
        </button>
        {b.outline_origin === "llm" && <button onClick={() => run(() => post(`/api/bridge/${id}/confirm`, { what: "outline" }), "大纲已确认")}>确认大纲</button>}
      </div>

      <h3>2. 正文</h3>
      <div className="actions">
        <button
          className="primary"
          disabled={!b.outline.length || outlineDirty}
          title={!b.outline.length ? "先有大纲" : outlineDirty ? "先保存大纲" : ""}
          onClick={() => run(() => post(`/api/bridges/${id}/draft`), "正文已生成，检查已跑完")}
        >
          {b.text ? "按大纲重写正文（旧版保留）" : "按大纲写正文"}
        </button>
      </div>
      {!view.voice && <p className="note">⚠ 没有声音样本：正文风格不可控</p>}
      <textarea className="prose" rows={14} value={text} onChange={(e) => setText(e.target.value)} placeholder="正文：生成，或者自己写" />
      <div className="actions">
        <button disabled={!textDirty} onClick={() => run(() => post(`/api/bridges/${id}/save`, { text }), "正文已保存（旧版保留），相关检查会过期")}>
          保存正文
        </button>
        {b.text_origin === "llm" && <button onClick={() => run(() => post(`/api/bridge/${id}/confirm`, { what: "text" }), "正文已确认")}>确认正文</button>}
        {b.status !== "locked" && b.text && (
          <button onClick={() => run(() => post(`/api/bridges/${id}/save`, { status: "locked" }), "已定稿")}>定稿（locked）</button>
        )}
        {b.status === "locked" && <button onClick={() => run(() => post(`/api/bridges/${id}/save`, { status: "revised" }), "已取消定稿")}>取消定稿</button>}
      </div>
      {b.versions.length > 0 && <p className="muted">历史版本：{b.versions.map((v) => `v${v.v}`).join("、")}（bridges/.versions/）</p>}

      <h3>3. 检查</h3>
      <div className="actions">
        {["A", "B", "C", "D"].map((a) => (
          <label key={a} className="inline">
            <input type="checkbox" checked={axes.includes(a)} onChange={(e) => setAxes(e.target.checked ? [...axes, a] : axes.filter((x) => x !== a))} />
            轴 {a}
          </label>
        ))}
        <button disabled={!b.text || !axes.length} onClick={() => run(() => post(`/api/bridges/${id}/check`, { axes }), "检查已跑完")}>
          跑检查
        </button>
      </div>
      <Checks view={view} checks={checks} run={run} />

      {b.derived_snapshot && (
        <>
          <h3>
            到达状态（从正文反向提取） <Llm show />
          </h3>
          <StateView world={b.derived_snapshot.world_facts} chars={b.derived_snapshot.char_states} />
          <button onClick={() => run(() => post(`/api/bridges/${id}/adopt`), `已采纳为 ${b.to} 的新状态（旧版保留）`)}>桥比计划好：采纳为终点快照</button>
        </>
      )}
      <details>
        <summary>编辑其他字段</summary>
        <SourceEditor kind="bridge" id={b.id} run={run} bodyLabel="正文" />
      </details>
    </div>
  );
}

function ThreadPanel({ view, id, run, onSelect }: Props & { id: string }) {
  const th = view.threads.find((t) => t.id === id);
  if (!th) return <Gone />;
  const checks = view.checks.filter((c) => c.target === th.id);
  const VIS = { reader_only: "读者知道，人物不知道", character: `只有 ${th.known_by.join("、")} 知道`, hidden: "埋了，读者还不该察觉" };
  return (
    <div>
      <h2>线 {th.id}</h2>
      <p className="muted">
        埋点 {th.planted_at} → 收点 {th.payoff_at ?? "（未收）"} · {VIS[th.visibility]} · {th.status}
      </p>
      <p className="pre">{th.description}</p>
      {th.unpaid && <p className="note">未收（不计入分数）</p>}
      {th.affected.length > 0 && (
        <p className="note">
          ⚠ 受影响节点：
          {th.affected.map((a) => (
            <button key={a} className="link" onClick={() => onSelect(view.bridges.some((b) => b.id === a) ? { kind: "bridge", id: a } : { kind: "snapshot", id: a })}>
              {a}
            </button>
          ))}
        </p>
      )}
      <div className="actions">
        <button onClick={() => run(() => post(`/api/threads/${enc(th.id)}/check`), "轴 E 已跑完")}>{th.checked ? "重跑轴 E" : "跑轴 E"}</button>
      </div>
      <Checks view={view} checks={checks} run={run} />
      <details>
        <summary>编辑这条线</summary>
        <SourceEditor kind="thread" id={th.id} run={run} bodyLabel="描述" />
      </details>
    </div>
  );
}

function EntryList({ title, xs }: { title: string; xs: Entry[] }) {
  return (
    <>
      <h4>{title}</h4>
      {xs.length ? (
        <ul>
          {xs.map((e) => (
            <li key={e.id} className={e.origin === "llm" ? "inferred" : ""}>
              [{e.id}] {e.text}
              {e.tag ? `〔${e.tag}〕` : ""}
              {e.permanent ? "〔永久〕" : ""}
              {e.secret ? "〔人物不知道〕" : ""}
              {e.origin === "llm" ? "〔推演，不作锚点〕" : ""}
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">（无）</p>
      )}
    </>
  );
}

function ProfilePanel({ view, id }: { view: View; id: string }) {
  const pr = view.profiles.find((p) => p.id === id);
  if (!pr) return <p className="muted">这个泳道没有档案。</p>;
  return (
    <div>
      <h2>档案 {pr.name}</h2>
      <p className="muted">
        {pr.id} · {pr.readonly ? `外部只读：${pr.source}` : pr.file}
      </p>
      {pr.core && <p className="core">{pr.core}</p>}
      {!pr.heuristics.some((h) => h.origin !== "llm") && <p className="note">⚠ 没有决策规则：轴 A 置信度上限 0.3</p>}
      <EntryList title="决策规则" xs={pr.heuristics} />
      <EntryList title="硬边界" xs={pr.boundaries} />
      <EntryList title="核心人格" xs={pr.traits} />
      <EntryList title="已定事实" xs={pr.hard_facts} />
      <EntryList title="留白" xs={pr.unknowns} />
      <p className="muted">档案在编辑器里改（{pr.readonly ? "外部文件只读，工具不改" : pr.file}）。改完画布自动刷新，下游检查会过期。</p>
    </div>
  );
}

function GapPanel({ view, from, to, onAddPoint, onNewSnapshot }: Props & { from: string; to: string }) {
  const g = view.gaps.find((x) => x.from === from && x.to === to);
  if (!g) return <Gone />;
  const a = view.snapshots.find((s) => s.id === from)!;
  const b = view.snapshots.find((s) => s.id === to)!;
  return (
    <div>
      <h2>间距 {g.score}</h2>
      <p className="muted">
        {from}（t={a.t}）→ {to}（t={b.t}）· 轴 F，代码计算，改写措辞也算变化
      </p>
      <div className="actions">
        <button className="primary" onClick={() => onAddPoint(from, to)}>
          生成候选中间点
        </button>
        <button onClick={() => onNewSnapshot((a.t + b.t) / 2)}>手写一个中间快照</button>
      </div>
      <table className="evidence">
        <thead>
          <tr>
            <th>字段</th>
            <th>之前</th>
            <th>之后</th>
            <th>权重</th>
          </tr>
        </thead>
        <tbody>
          {g.changes.map((c, i) => (
            <tr key={i}>
              <td>
                {c.character ? `${c.character}.` : ""}
                {c.field}
              </td>
              <td>{c.before.join("；") || "—"}</td>
              <td>{c.after.join("；") || "—"}</td>
              <td>{c.weight}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

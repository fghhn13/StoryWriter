// Check list with evidence and dispositions (spec §6-U6, §7 侧栏): every finding answers
// 哪里 / 依据 / 本来应该 / 最便宜的修补; accept / dismiss / fixed / revoke right here.
import { useState } from "react";
import { enc, post } from "./api";
import { AXIS_NAME, type Check, type View, level } from "./types";

const STATUS: Record<string, string> = { open: "待处理", accepted: "已接受", fixed: "已修好", dismissed: "已忽略", stale: "过期" };

export function Checks({ view, checks, run }: { view: View; checks: Check[]; run: (f: () => Promise<unknown>, ok?: string) => void }) {
  if (!checks.length) return <p className="muted">还没有检查。</p>;
  const sorted = [...checks].sort((a, b) => b.score - a.score);
  return (
    <div className="checks">
      {sorted.map((c) => (
        <CheckItem key={c.id} view={view} c={c} run={run} />
      ))}
    </div>
  );
}

function CheckItem({ view, c, run }: { view: View; c: Check; run: (f: () => Promise<unknown>, ok?: string) => void }) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"" | "accept" | "dismiss" | "fixed">("");
  const [why, setWhy] = useState("");
  const [delta, setDelta] = useState("");
  const [character, setCharacter] = useState(c.character ?? "");
  const lv = level(view, c.axis, c.score);
  const who = c.character ? ` · ${view.profiles.find((p) => p.id === c.character)?.name ?? c.character}` : "";
  const acceptance = view.acceptances.find((a) => a.check === c.id);
  const findings = c.evidence.filter((e) => e.direction === "opposite").sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
  const stale = c.isStale || c.status === "stale";

  const submit = () => {
    const id = enc(c.id);
    if (mode === "accept") run(() => post(`/api/checks/${id}/accept`, { why, delta, character: character || undefined }), "已接受：状态增量已写入，下游检查标为过期");
    if (mode === "dismiss") run(() => post(`/api/checks/${id}/dismiss`, { why }), "已忽略");
    if (mode === "fixed") run(() => post(`/api/checks/${id}/fixed`, { note: why }), "已标记修好");
    setMode("");
    setWhy("");
    setDelta("");
  };

  return (
    <div className={`check ${lv} ${c.status}`}>
      <div className="check-head" onClick={() => setOpen(!open)}>
        <span className={`score ${lv}`}>{c.score}</span>
        <span className="check-title">
          轴 {c.axis} · {AXIS_NAME[c.axis]}
          {who}
        </span>
        <span className="check-status">
          {stale ? "⏳ 过期" : STATUS[c.status]} · 置信度 {c.confidence}
        </span>
        <span className="toggle">{open ? "▾" : "▸"}</span>
      </div>
      {open && (
        <div className="check-body">
          {(c.notes ?? []).map((n) => (
            <div key={n} className="note">
              ⚠ {n}
            </div>
          ))}
          {c.samples && <div className="muted">{c.axis === "E" ? "各节点" : "样本"}：{c.samples.scores.join(" / ")}</div>}
          {findings.length ? (
            <table className="evidence">
              <thead>
                <tr>
                  <th>哪里</th>
                  <th>依据</th>
                  <th>本来应该</th>
                  <th>说明</th>
                </tr>
              </thead>
              <tbody>
                {findings.map((e, i) => (
                  <tr key={i} className={e.verified === false ? "unverified" : ""}>
                    <td>
                      {e.verified === false && <em>（引文未核实）</em>}「{e.quote}」
                    </td>
                    <td>
                      {e.rule}
                      {e.rule_text ? `：${e.rule_text}` : ""}
                    </td>
                    <td>{e.expected}</td>
                    <td>{e.note}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p className="muted">没有发现偏差。</p>
          )}
          {c.suggestion && (
            <p>
              <b>最便宜的修补：</b>
              {c.suggestion}
            </p>
          )}
          {c.justification && (
            <p>
              <b>作者理由：</b>
              {c.justification}
            </p>
          )}
          {acceptance && (
            <p>
              <b>状态增量（t={acceptance.t}，{acceptance.character}）：</b>
              {acceptance.delta}{" "}
              <button className="link" onClick={() => run(() => post(`/api/acceptances/${enc(acceptance.id)}/revoke`), "已撤销接受")}>
                撤销
              </button>
            </p>
          )}
          {c.history?.length ? (
            <details>
              <summary>历史（{c.history.length}）</summary>
              <ul className="history">
                {c.history.map((h, i) => (
                  <li key={i}>
                    {h.at.slice(0, 16).replace("T", " ")} · {h.action}
                    {h.score !== undefined ? ` · ${h.score}` : ""}
                    {h.note ? ` · ${h.note}` : ""}
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
          <div className="actions">
            <button onClick={() => setMode("accept")}>接受偏差</button>
            <button onClick={() => setMode("dismiss")}>忽略</button>
            <button onClick={() => setMode("fixed")}>已修好</button>
          </div>
          {mode && (
            <div className="form">
              <label>
                {mode === "accept" ? "理由（必填）" : mode === "dismiss" ? "原因（必填）" : "说明（可空）"}
                <textarea value={why} onChange={(e) => setWhy(e.target.value)} rows={2} />
              </label>
              {mode === "accept" && (
                <>
                  <label>
                    状态增量（可空，默认用理由；例如"从此她知道 Villy 会为了房间撒小谎"）
                    <textarea value={delta} onChange={(e) => setDelta(e.target.value)} rows={2} />
                  </label>
                  {!c.character && (
                    <label>
                      这条变化属于谁
                      <select value={character} onChange={(e) => setCharacter(e.target.value)}>
                        <option value="">（选人物）</option>
                        {view.profiles.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              )}
              <div className="actions">
                <button className="primary" onClick={submit} disabled={mode !== "fixed" && !why.trim()}>
                  确定
                </button>
                <button onClick={() => setMode("")}>取消</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

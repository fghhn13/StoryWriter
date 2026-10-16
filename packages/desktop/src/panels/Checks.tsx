// Check results for one target, with evidence and dispositions (accept with a reason / dismiss).
import { useState } from "react";
import { enc, post } from "../api";
import { AXIS_LABEL, type Check, type GraphView, levelOf } from "../types";

export function ScorePill({ view, check }: { view: GraphView; check: Pick<Check, "axis" | "score"> }) {
  return <span className={`pill lvl-${levelOf(view, check.axis, check.score)}`}>{check.score}</span>;
}

export function CheckList(props: {
  view: GraphView;
  checks: Check[];
  /** characters a deviation can be attached to when the check isn't about one person */
  cast: string[];
  act: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
}) {
  const sorted = [...props.checks].sort((a, b) => Number(isOpen(b)) - Number(isOpen(a)) || b.score - a.score);
  if (!sorted.length) return <p className="muted">Not checked yet.</p>;
  return (
    <div className="checks">
      {sorted.map((c) => (
        <CheckCard key={c.id} {...props} check={c} />
      ))}
    </div>
  );
}

const isOpen = (c: Check) => c.status === "open" || c.status === "stale";

function CheckCard(props: { view: GraphView; check: Check; cast: string[]; act: <T>(fn: () => Promise<T>) => Promise<T | undefined> }) {
  const { view, check: c } = props;
  const [open, setOpen] = useState(isOpen(c) && c.score > 0);
  const [mode, setMode] = useState<"accept" | "dismiss" | null>(null);
  const [why, setWhy] = useState("");
  const [delta, setDelta] = useState("");
  const [who, setWho] = useState(c.character ?? props.cast[0] ?? "");
  const names = new Map(view.constraints.map((o) => [o.owner, o.name]));
  const findings = c.evidence.filter((e) => e.direction === "opposite" || e.direction === undefined);

  const submit = async () => {
    if (!why.trim()) return;
    const ok =
      mode === "accept"
        ? await props.act(() => post(`/api/checks/${enc(c.id)}/accept`, { why, delta: delta || undefined, character: c.character ? undefined : who }))
        : await props.act(() => post(`/api/checks/${enc(c.id)}/dismiss`, { why }));
    if (ok !== undefined) {
      setMode(null);
      setWhy("");
      setDelta("");
    }
  };

  return (
    <div className={`check ${isOpen(c) ? "" : "closed"}`}>
      <button className="check-head" onClick={() => setOpen(!open)}>
        <ScorePill view={view} check={c} />
        <span className="check-title">
          {c.axis} · {AXIS_LABEL[c.axis]}
          {c.character ? ` · ${names.get(c.character) ?? c.character}` : ""}
        </span>
        {c.isStale && <span className="chip warn">stale</span>}
        {c.status === "accepted" && <span className="chip">accepted</span>}
        {c.status === "dismissed" && <span className="chip">dismissed</span>}
        <span className="muted small">conf {c.confidence}</span>
      </button>
      {open && (
        <div className="check-body">
          {c.notes?.map((n, i) => (
            <p key={i} className="note">
              ⚠ {n}
            </p>
          ))}
          {findings.length ? (
            findings
              .sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))
              .map((e, i) => (
                <div key={i} className="finding">
                  <blockquote className={e.verified === false ? "unverified" : ""}>{e.quote || "—"}</blockquote>
                  {e.rule && (
                    <div className="small">
                      <b>Rule</b> {e.rule}
                      {e.rule_text ? ` — ${e.rule_text}` : ""}
                    </div>
                  )}
                  {e.expected && (
                    <div className="small">
                      <b>Expected</b> {e.expected}
                    </div>
                  )}
                  {e.note && <div className="small muted">{e.note}</div>}
                </div>
              ))
          ) : (
            <p className="muted">No deviation found.</p>
          )}
          {c.suggestion && (
            <p className="small">
              <b>Cheapest fix</b> {c.suggestion}
            </p>
          )}
          {c.samples && c.samples.scores.length > 0 && <p className="muted small">samples {c.samples.scores.join(" / ")}</p>}
          {c.justification && (
            <p className="small">
              <b>Reason</b> {c.justification}
            </p>
          )}
          {isOpen(c) && c.score > 0 && !mode && (
            <div className="row">
              <button onClick={() => setMode("accept")}>Accept as a turn…</button>
              <button onClick={() => setMode("dismiss")}>Dismiss…</button>
            </div>
          )}
          {mode && (
            <div className="dispose">
              <textarea rows={2} placeholder={mode === "accept" ? "Why this deviation is intended (required)" : "Why this can be ignored (required)"} value={why} onChange={(e) => setWhy(e.target.value)} />
              {mode === "accept" && (
                <>
                  <input placeholder="What changes for the character from now on (defaults to the reason)" value={delta} onChange={(e) => setDelta(e.target.value)} />
                  {!c.character && (
                    <label className="small">
                      Applies to{" "}
                      <select value={who} onChange={(e) => setWho(e.target.value)}>
                        {props.cast.map((id) => (
                          <option key={id} value={id}>
                            {names.get(id) ?? id}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                </>
              )}
              <div className="row">
                <button className="primary" disabled={!why.trim() || (mode === "accept" && !c.character && !who)} onClick={submit}>
                  {mode === "accept" ? "Accept" : "Dismiss"}
                </button>
                <button onClick={() => setMode(null)}>Cancel</button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

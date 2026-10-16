// Right-hand inspector: edit the selected node (a moment's state) or edge (what happens between).
import { useEffect, useMemo, useState } from "react";
import { enc, post } from "../api";
import type { CharState, GraphEdge, GraphNode, GraphView, Selection } from "../types";
import { CheckList } from "./Checks";
import { ListEditor } from "./ListEditor";

type Act = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

export function Inspector(props: { view: GraphView; selection: NonNullable<Selection>; act: Act; busy: boolean; onSelect(s: Selection): void }) {
  const { view, selection } = props;
  if (selection.kind === "node") {
    const n = view.nodes.find((x) => x.id === selection.id);
    return n ? <NodeEditor key={n.id} {...props} node={n} /> : null;
  }
  const e = view.edges.find((x) => x.id === selection.id);
  return e ? <EdgeEditor key={e.id} {...props} edge={e} /> : null;
}

const emptyState = (): CharState => ({ knows: [], wants: [], relationships: {} });

function NodeEditor(props: { view: GraphView; node: GraphNode; act: Act; onSelect(s: Selection): void }) {
  const { view, node } = props;
  const [title, setTitle] = useState(node.title);
  const [facts, setFacts] = useState(node.world_facts);
  const [states, setStates] = useState<Record<string, CharState>>(node.char_states);
  const [notes, setNotes] = useState(node.author_notes);
  // the server copy changed (file edited elsewhere, or our save came back): start over from it
  useEffect(() => {
    setTitle(node.title);
    setFacts(node.world_facts);
    setStates(node.char_states);
    setNotes(node.author_notes);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content: refetches alone must not wipe edits
  }, [JSON.stringify([node.title, node.world_facts, node.char_states, node.author_notes])]);

  const characters = view.constraints.filter((o) => o.kind === "character");
  const names = new Map(characters.map((o) => [o.owner, o.name]));
  const missing = characters.filter((o) => !states[o.owner]);
  const dirty =
    title !== node.title ||
    notes !== node.author_notes ||
    JSON.stringify(facts) !== JSON.stringify(node.world_facts) ||
    JSON.stringify(states) !== JSON.stringify(node.char_states);
  const setState = (ch: string, patch: Partial<CharState>) => setStates((s) => ({ ...s, [ch]: { ...emptyState(), ...s[ch], ...patch } }));

  const save = () =>
    props.act(() => post(`/api/nodes/${enc(node.id)}`, { title, world_facts: facts, char_states: states, notes }));
  const remove = () => {
    if (confirm(`Delete "${node.title}" and every edge touching it?`)) void props.act(() => post(`/api/nodes/${enc(node.id)}/delete`)).then(() => props.onSelect(null));
  };
  const inbound = view.edges.filter((e) => e.to === node.id);
  const outbound = view.edges.filter((e) => e.from === node.id);
  const title_ = (id: string) => view.nodes.find((n) => n.id === id)?.title ?? id;

  return (
    <div className="inspector">
      <div className="insp-head">
        <span className="kind">Node</span>
        <code className="muted">{node.id}</code>
      </div>
      <label>Title</label>
      <input value={title} onChange={(e) => setTitle(e.target.value)} />

      <h4>World facts</h4>
      <ListEditor items={facts} onChange={setFacts} placeholder="Something true in the world at this moment" />

      <h4>Characters</h4>
      {Object.entries(states).map(([ch, st]) => (
        <div className="char-card" key={ch}>
          <div className="char-head">
            <b>{names.get(ch) ?? ch}</b>
            <button
              className="icon"
              title="Remove from this moment"
              onClick={() =>
                setStates((s) => {
                  const { [ch]: _gone, ...rest } = s;
                  return rest;
                })
              }
            >
              ×
            </button>
          </div>
          <label>Knows</label>
          <ListEditor items={st.knows} onChange={(knows) => setState(ch, { knows })} />
          <label>Wants</label>
          <ListEditor items={st.wants} onChange={(wants) => setState(ch, { wants })} />
          <div className="two">
            <div>
              <label>Feels</label>
              <input value={st.feels ?? ""} onChange={(e) => setState(ch, { feels: e.target.value })} />
            </div>
            <div>
              <label>Location</label>
              <input value={st.location ?? ""} onChange={(e) => setState(ch, { location: e.target.value })} />
            </div>
          </div>
          <label>Relationships</label>
          <ListEditor
            items={Object.entries(st.relationships).map(([k, v]) => `${k}: ${v}`)}
            onChange={(lines) =>
              setState(ch, {
                relationships: Object.fromEntries(
                  lines.flatMap((l) => {
                    const i = l.search(/[:：]/);
                    return i > 0 ? [[l.slice(0, i).trim(), l.slice(i + 1).trim()]] : [];
                  }),
                ),
              })
            }
            placeholder="who: how they feel about them"
          />
        </div>
      ))}
      {missing.length > 0 && (
        <select value="" onChange={(e) => e.target.value && setState(e.target.value, {})}>
          <option value="">+ Add a character to this moment…</option>
          {missing.map((o) => (
            <option key={o.owner} value={o.owner}>
              {o.name}
            </option>
          ))}
        </select>
      )}
      {!characters.length && <p className="muted small">Create characters in the Constraints panel first.</p>}

      <h4>Notes</h4>
      <textarea rows={3} value={notes} onChange={(e) => setNotes(e.target.value)} />

      <div className="row sticky">
        <button className="primary" disabled={!dirty || !title.trim()} onClick={save}>
          Save
        </button>
        <button disabled={!dirty} onClick={() => {
          setTitle(node.title);
          setFacts(node.world_facts);
          setStates(node.char_states);
          setNotes(node.author_notes);
        }}>
          Revert
        </button>
        <span className="spacer" />
        <button className="danger" onClick={remove}>
          Delete
        </button>
      </div>

      {(inbound.length > 0 || outbound.length > 0) && (
        <>
          <h4>Edges</h4>
          {inbound.map((e) => (
            <button key={e.id} className="link" onClick={() => props.onSelect({ kind: "edge", id: e.id })}>
              ← from {title_(e.from)}
            </button>
          ))}
          {outbound.map((e) => (
            <button key={e.id} className="link" onClick={() => props.onSelect({ kind: "edge", id: e.id })}>
              → to {title_(e.to)}
            </button>
          ))}
        </>
      )}
    </div>
  );
}

function EdgeEditor(props: { view: GraphView; edge: GraphEdge; act: Act; busy: boolean; onSelect(s: Selection): void }) {
  const { view, edge } = props;
  const [summary, setSummary] = useState(edge.summary ?? "");
  const [outline, setOutline] = useState(edge.outline);
  const [text, setText] = useState(edge.text);
  useEffect(() => {
    setSummary(edge.summary ?? "");
    setOutline(edge.outline);
    setText(edge.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on content, as above
  }, [JSON.stringify([edge.summary, edge.outline, edge.text])]);
  const dirty = summary !== (edge.summary ?? "") || text !== edge.text || JSON.stringify(outline) !== JSON.stringify(edge.outline);
  const from = view.nodes.find((n) => n.id === edge.from);
  const to = view.nodes.find((n) => n.id === edge.to);
  const checks = view.checks.filter((c) => c.target === edge.id && c.target_kind === "bridge");
  const cast = useMemo(() => [...new Set([...Object.keys(from?.char_states ?? {}), ...Object.keys(to?.char_states ?? {})])], [from, to]);

  const save = () => props.act(() => post(`/api/edges/${enc(edge.id)}`, { summary, outline, text }));
  const check = async () => {
    if (dirty) await save();
    await props.act(() => post(`/api/edges/${enc(edge.id)}/check`));
  };
  const remove = () => {
    if (confirm("Delete this edge and its check results?")) void props.act(() => post(`/api/edges/${enc(edge.id)}/delete`)).then(() => props.onSelect(null));
  };

  return (
    <div className="inspector">
      <div className="insp-head">
        <span className="kind">Edge</span>
        <code className="muted">{edge.id}</code>
      </div>
      <div className="edge-ends">
        <button className="link" onClick={() => props.onSelect({ kind: "node", id: edge.from })}>
          {from?.title ?? edge.from}
        </button>
        <span>→</span>
        <button className="link" onClick={() => props.onSelect({ kind: "node", id: edge.to })}>
          {to?.title ?? edge.to}
        </button>
      </div>

      <label>What happens (summary)</label>
      <textarea rows={3} value={summary} placeholder="One or two sentences. The transition check reads this." onChange={(e) => setSummary(e.target.value)} />
      <h4>Beats</h4>
      <ListEditor items={outline} onChange={setOutline} placeholder="A beat in this stretch" multiline />
      <h4>Prose</h4>
      <textarea className="prose" rows={10} value={text} placeholder="Optional. With prose, the character, continuity, unknowns and arrival checks run too." onChange={(e) => setText(e.target.value)} />

      <div className="row sticky">
        <button className="primary" disabled={!dirty} onClick={save}>
          Save
        </button>
        <button disabled={props.busy} onClick={check} title="Transition check always; text checks when there is prose">
          {dirty ? "Save & check" : "Check edge"}
        </button>
        <span className="spacer" />
        <button className="danger" onClick={remove}>
          Delete
        </button>
      </div>

      <h4>
        Checks {edge.info.checked && <span className="muted small">· worst {edge.info.score}</span>}
      </h4>
      <CheckList view={view} checks={checks} cast={cast} act={props.act} />
    </div>
  );
}

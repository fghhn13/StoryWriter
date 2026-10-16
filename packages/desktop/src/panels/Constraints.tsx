// Left panel: the constraint set (D-064). Every add / edit / delete triggers the conflict check
// and re-checks whatever went stale; the conflict card at the top shows the latest result.
import { useState } from "react";
import { enc, post } from "../api";
import type { ConstraintField, ConstraintOwner, Entry, GraphView } from "../types";
import { CheckList } from "./Checks";

type Act = <T>(fn: () => Promise<T>) => Promise<T | undefined>;

const FIELD_LABEL: Record<ConstraintField, string> = {
  traits: "Traits",
  heuristics: "Decision rules",
  boundaries: "Boundaries",
  hard_facts: "Facts",
  unknowns: "Unknowns (left open on purpose)",
  world_rules: "World rules",
};
const FIELD_HINT: Partial<Record<ConstraintField, string>> = {
  heuristics: "A question to ask when writing them",
  boundaries: "Something the story must never do with them",
  hard_facts: "Something settled about them",
  unknowns: "A question that stays unanswered",
  traits: "A core personality trait",
  world_rules: "Something always true in this world",
};
const CHARACTER_FIELDS: ConstraintField[] = ["heuristics", "traits", "boundaries", "hard_facts", "unknowns"];

export function ConstraintsPanel(props: { view: GraphView; act: Act; busy: boolean }) {
  const { view, act } = props;
  const [openOwner, setOpenOwner] = useState<string | null>(null);
  const [newId, setNewId] = useState("");
  const [newName, setNewName] = useState("");
  const world = view.constraints.find((o) => o.owner === "world")!;
  const project = view.constraints.find((o) => o.owner === "project")!;
  const characters = view.constraints.filter((o) => o.kind === "character");
  const k = view.constraintCheck;

  const create = async () => {
    const ok = await act(() => post("/api/profiles", { id: newId.trim(), name: newName.trim() }));
    if (ok !== undefined) {
      setOpenOwner(newId.trim());
      setNewId("");
      setNewName("");
    }
  };

  return (
    <div className="panel-scroll">
      <div className="conflict-card">
        <div className="row">
          <b>Conflicts between constraints</b>
          <span className="spacer" />
          <button className="small-btn" disabled={props.busy} onClick={() => act(() => post("/api/constraints/check"))}>
            Re-check
          </button>
        </div>
        {k ? (
          <CheckList view={view} checks={[k]} cast={[]} act={act} />
        ) : (
          <p className="muted small">Runs automatically whenever you change a constraint.</p>
        )}
      </div>

      <OwnerSection owner={world} fields={["world_rules"]} act={act} open />
      <OwnerSection owner={project} fields={["unknowns"]} act={act} open title="Project unknowns" />

      <h3 className="section-title">Characters</h3>
      {characters.map((o) => (
        <OwnerSection
          key={o.owner}
          owner={o}
          fields={CHARACTER_FIELDS}
          act={act}
          open={openOwner === o.owner}
          onToggle={() => setOpenOwner(openOwner === o.owner ? null : o.owner)}
        />
      ))}
      <div className="new-char">
        <input placeholder="id (e.g. tina)" value={newId} onChange={(e) => setNewId(e.target.value)} />
        <input placeholder="Name" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button disabled={!newId.trim() || !newName.trim()} onClick={create}>
          + Character
        </button>
      </div>
    </div>
  );
}

function OwnerSection(props: { owner: ConstraintOwner; fields: ConstraintField[]; act: Act; open?: boolean; onToggle?: () => void; title?: string }) {
  const { owner } = props;
  const count = props.fields.reduce((s, f) => s + (owner.fields[f]?.length ?? 0), 0);
  const isChar = owner.kind === "character";
  return (
    <div className={`owner ${isChar ? "char" : ""}`}>
      {isChar ? (
        <button className="owner-head" onClick={props.onToggle}>
          <span>{props.open ? "▾" : "▸"}</span>
          <b>{owner.name}</b>
          <code className="muted">{owner.owner}</code>
          {owner.external && <span className="chip" title={owner.external}>wiki · read-only base</span>}
          <span className="spacer" />
          <span className="muted small">{count}</span>
        </button>
      ) : (
        <h3 className="section-title">{props.title ?? owner.name}</h3>
      )}
      {props.open && (
        <div className="owner-body">
          {isChar && <CoreLine owner={owner} act={props.act} />}
          {props.fields.map((f) => (
            <FieldList key={f} owner={owner} field={f} act={props.act} label={isChar ? FIELD_LABEL[f] : undefined} />
          ))}
        </div>
      )}
    </div>
  );
}

function CoreLine({ owner, act }: { owner: ConstraintOwner; act: Act }) {
  const [core, setCore] = useState(owner.core ?? "");
  if (owner.external) return owner.core ? <p className="core">{owner.core}</p> : null;
  return (
    <input
      className="core-input"
      placeholder="Core: one line on who they are"
      value={core}
      onChange={(e) => setCore(e.target.value)}
      onBlur={() => core !== (owner.core ?? "") && act(() => post(`/api/profiles/${enc(owner.owner)}`, { core }))}
    />
  );
}

function FieldList(props: { owner: ConstraintOwner; field: ConstraintField; act: Act; label?: string }) {
  const { owner, field, act } = props;
  const entries = owner.fields[field] ?? [];
  const [draft, setDraft] = useState("");
  const [flag, setFlag] = useState(false);
  const flagName = field === "hard_facts" ? "secret" : field === "unknowns" ? "permanent" : null;
  const add = async () => {
    if (!draft.trim()) return;
    const ok = await act(() => post("/api/constraints", { owner: owner.owner, field, text: draft, ...(flagName && flag ? { [flagName]: true } : {}) }));
    if (ok !== undefined) {
      setDraft("");
      setFlag(false);
    }
  };
  return (
    <div className="field">
      {props.label && <div className="field-label">{props.label}</div>}
      {entries.map((e) => (
        <EntryRow key={e.id} owner={owner.owner} field={field} entry={e} act={act} flagName={flagName} />
      ))}
      <div className="entry add">
        <input
          value={draft}
          placeholder={FIELD_HINT[field] ?? "Add…"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && !e.nativeEvent.isComposing && add()}
        />
        {flagName && (
          <label className="small flag" title={flagName === "secret" ? "The character doesn't know this" : "Filling this unknown always scores 100"}>
            <input type="checkbox" checked={flag} onChange={(e) => setFlag(e.target.checked)} /> {flagName}
          </label>
        )}
        <button className="small-btn" disabled={!draft.trim()} onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}

function EntryRow(props: { owner: string; field: ConstraintField; entry: Entry; act: Act; flagName: "secret" | "permanent" | null }) {
  const { entry: e, act } = props;
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(e.text);
  const url = `/api/constraints/${enc(props.owner)}/${props.field}/${enc(e.id)}`;
  const save = async () => {
    setEditing(false);
    if (text.trim() && text !== e.text) await act(() => post(url, { text }));
    else setText(e.text);
  };
  const flagOn = props.flagName ? !!e[props.flagName] : false;
  return (
    <div className={`entry ${e.editable ? "" : "locked"} ${e.origin === "llm" ? "inferred" : ""}`}>
      <code className="eid">{e.id}</code>
      {editing ? (
        <input
          autoFocus
          value={text}
          onChange={(ev) => setText(ev.target.value)}
          onBlur={save}
          onKeyDown={(ev) => {
            if (ev.key === "Enter" && !ev.nativeEvent.isComposing) void save();
            if (ev.key === "Escape") {
              setText(e.text);
              setEditing(false);
            }
          }}
        />
      ) : (
        <span className="etext" onDoubleClick={() => e.editable && setEditing(true)} title={e.editable ? "Double-click to edit" : "From the wiki page: read-only here"}>
          {e.text}
          {e.origin === "llm" && <span className="chip">inferred · not a rule</span>}
          {e.tag && e.tag !== "留白" && <span className="chip">{e.tag}</span>}
        </span>
      )}
      {props.flagName && (
        <button
          className={`chip toggle ${flagOn ? "on" : ""}`}
          disabled={!e.editable}
          title={props.flagName === "secret" ? "Secret: the character doesn't know this" : "Permanent unknown"}
          onClick={() => act(() => post(url, { [props.flagName!]: !flagOn }))}
        >
          {props.flagName}
        </button>
      )}
      {e.editable ? (
        <button className="icon" title="Delete" onClick={() => confirm(`Delete "${e.text}"?`) && act(() => post(`${url}/delete`))}>
          ×
        </button>
      ) : (
        <span className="lock" title="From the wiki page: read-only here">
          🔒
        </span>
      )}
    </div>
  );
}

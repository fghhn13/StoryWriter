import { useState } from "react";

/** Editable list of free-text lines (world facts, knows, wants, beats...). */
export function ListEditor(props: { items: string[]; onChange(items: string[]): void; placeholder?: string; multiline?: boolean }) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const t = draft.trim();
    if (!t) return;
    props.onChange([...props.items, t]);
    setDraft("");
  };
  return (
    <div className="list-editor">
      {props.items.map((it, i) => (
        <div className="list-row" key={i}>
          {props.multiline ? (
            <textarea rows={2} value={it} onChange={(e) => props.onChange(props.items.map((x, k) => (k === i ? e.target.value : x)))} />
          ) : (
            <input value={it} onChange={(e) => props.onChange(props.items.map((x, k) => (k === i ? e.target.value : x)))} />
          )}
          <button className="icon" title="Remove" onClick={() => props.onChange(props.items.filter((_, k) => k !== i))}>
            ×
          </button>
        </div>
      ))}
      <div className="list-row add">
        <input
          value={draft}
          placeholder={props.placeholder ?? "Add…"}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter adds; keep IME composition (Chinese input) intact
            if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
      </div>
    </div>
  );
}

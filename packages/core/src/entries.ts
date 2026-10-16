// Entry normalisation and stable-ish id assignment (D-003, D-004).
import { ENTRY_FIELDS, type Entry, type EntryField, type EntryInput, type EntryOrigin } from "./schema";

export function normalizeEntries(
  field: EntryField | { prefix: string },
  inputs: readonly EntryInput[],
  defaultOrigin: EntryOrigin = "profile",
): Entry[] {
  const prefix = typeof field === "string" ? ENTRY_FIELDS[field] : field.prefix;
  const taken = new Set(inputs.flatMap((e) => (typeof e === "object" && e.id ? [e.id] : [])));
  return inputs.map((input, i) => {
    const obj = typeof input === "string" ? { text: input } : input;
    let id = obj.id;
    if (!id) {
      id = `${prefix}${i + 1}`;
      // positional id collides with an author-given id: suffix until free
      for (let n = 2; taken.has(id); n++) id = `${prefix}${i + 1}_${n}`;
      taken.add(id);
    }
    return { ...obj, id, text: obj.text, origin: obj.origin ?? defaultOrigin };
  });
}

/** Entries an axis may anchor on: model-inferred entries never count (spec §3.1, D-006). */
export function anchorEntries(entries: readonly Entry[]): Entry[] {
  return entries.filter((e) => e.origin !== "llm");
}

/** Facts a generation prompt may see: secret facts (the character doesn't know them) are withheld (D-033). */
export function publicEntries(entries: readonly Entry[]): Entry[] {
  return entries.filter((e) => !e.secret);
}

/** Project-level world rules get ids w1, w2, ... (D-064). */
export function worldRules(rules: readonly EntryInput[]): Entry[] {
  return normalizeEntries({ prefix: "w" }, rules);
}

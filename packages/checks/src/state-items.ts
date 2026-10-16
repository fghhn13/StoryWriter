// Flatten a snapshot's state into addressable items ("tina.wants.1") so axes D and F can diff it
// field by field (spec §5-D.2, §5-F). The items stay free text.
import type { CharState } from "@sw/core";

export interface StateLike {
  world_facts: string[];
  char_states: Record<string, CharState>;
}

export type ItemField = "world" | "knows" | "wants" | "feels" | "location" | "relationships" | "resources";

export interface StateItem {
  key: string;
  field: ItemField;
  /** lane id; undefined for world facts */
  character?: string;
  text: string;
}

export function stateItems(s: StateLike, prefix = ""): StateItem[] {
  const out: StateItem[] = s.world_facts.map((text, i) => ({ key: `${prefix}world.${i + 1}`, field: "world" as const, text }));
  for (const [c, st] of Object.entries(s.char_states)) {
    const list = (field: "knows" | "wants" | "resources", xs: string[] | undefined) =>
      (xs ?? []).forEach((text, i) => out.push({ key: `${prefix}${c}.${field}.${i + 1}`, field, character: c, text }));
    list("knows", st.knows);
    list("wants", st.wants);
    if (st.feels) out.push({ key: `${prefix}${c}.feels`, field: "feels", character: c, text: st.feels });
    if (st.location) out.push({ key: `${prefix}${c}.location`, field: "location", character: c, text: st.location });
    for (const [other, text] of Object.entries(st.relationships ?? {})) {
      out.push({ key: `${prefix}${c}.relationships.${other}`, field: "relationships", character: c, text: `对 ${other}：${text}` });
    }
    list("resources", st.resources);
  }
  return out;
}

export const FIELD_LABEL: Record<ItemField, string> = {
  world: "世界事实",
  knows: "知道",
  wants: "想要",
  feels: "情绪",
  location: "位置",
  relationships: "关系",
  resources: "资源",
};

export function renderItems(items: StateItem[]): string {
  if (!items.length) return "（无）";
  return items.map((i) => `- [${i.key}] ${i.character ? `${i.character} · ` : ""}${FIELD_LABEL[i.field]}：${i.text}`).join("\n");
}

// Axis F · 间距 (spec §5-F). Not a text check: a field diff of two snapshots, computed in code.
// Free-text items are compared after normalisation, so a reworded item counts as a change (D-035).
import type { ProjectConfig, Snapshot } from "@sw/core";
import { saturate } from "./common";
import { type ItemField, stateItems } from "./state-items";

export const GAP_WEIGHT: Record<ItemField, number> = {
  knows: 3,
  wants: 3,
  relationships: 2,
  location: 2,
  world: 2,
  feels: 1,
  resources: 1,
};
/** a character entering or leaving the scene */
export const GAP_LANE_WEIGHT = 3;
/** saturation scale: one ordinary scene's worth of change (≈19 weight) lands near 50 */
export const GAP_SCALE = 25;

export interface GapChange {
  field: ItemField | "lane";
  character?: string;
  before: string[];
  after: string[];
  /** changed units: max(removed, added) for lists, 1 for a changed single value */
  units: number;
  weight: number;
}

export interface Gap {
  from: string;
  to: string;
  score: number;
  weight: number;
  changes: GapChange[];
  suggestAddPoint: boolean;
}

const norm = (s: string) => s.replace(/\s+/g, "").replace(/[。．.！!？?；;，,、]+$/u, "");

export function gapBetween(a: Snapshot, b: Snapshot, cfg?: ProjectConfig): Gap {
  const group = (s: Snapshot) => {
    const m = new Map<string, { field: ItemField; character?: string; texts: string[] }>();
    for (const it of stateItems(s)) {
      const k = `${it.character ?? ""}|${it.field}`;
      const g = m.get(k) ?? { field: it.field, character: it.character, texts: [] };
      g.texts.push(it.text);
      m.set(k, g);
    }
    return m;
  };
  const ga = group(a);
  const gb = group(b);
  const changes: GapChange[] = [];
  for (const k of new Set([...ga.keys(), ...gb.keys()])) {
    const x = ga.get(k);
    const y = gb.get(k);
    const before = x?.texts ?? [];
    const after = y?.texts ?? [];
    const nb = new Set(before.map(norm));
    const na = new Set(after.map(norm));
    const removed = [...nb].filter((t) => !na.has(t)).length;
    const added = [...na].filter((t) => !nb.has(t)).length;
    const units = Math.max(removed, added);
    if (!units) continue;
    const field = (x ?? y)!.field;
    changes.push({ field, character: (x ?? y)!.character, before, after, units, weight: units * GAP_WEIGHT[field] });
  }
  const chars = (s: Snapshot) => new Set(Object.keys(s.char_states));
  const ca = chars(a);
  const cb = chars(b);
  for (const c of new Set([...ca, ...cb])) {
    if (ca.has(c) !== cb.has(c)) {
      changes.push({ field: "lane", character: c, before: ca.has(c) ? ["在场"] : [], after: cb.has(c) ? ["在场"] : [], units: 1, weight: GAP_LANE_WEIGHT });
    }
  }
  const weight = changes.reduce((s, c) => s + c.weight, 0);
  const score = saturate(weight, GAP_SCALE);
  const warn = cfg?.thresholds.F.warn ?? 60;
  return { from: a.id, to: b.id, score, weight, changes: changes.sort((p, q) => q.weight - p.weight), suggestAddPoint: score >= warn };
}

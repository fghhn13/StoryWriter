// Stale detection (spec §6-U8). A check records a content hash for everything it read, keyed by
// what that thing is ("profile:tina", "snapshot:s-start", "text:b-fifth"...). A check is stale as
// soon as any of those hashes differs from the project on disk, whoever changed the file (D-046).
import {
  type Check,
  ENDPOINT_STATUSES,
  type Located,
  type Project,
  contentHash,
  normalizeEntries,
  profileById,
  updateYamlFile,
  worldRules,
} from "@sw/core";

/** Current hash of one dependency key; undefined when the object no longer exists. */
export function currentHash(p: Project, key: string): string | undefined {
  const i = key.indexOf(":");
  const kind = i < 0 ? key : key.slice(0, i);
  const id = i < 0 ? "" : key.slice(i + 1);
  switch (kind) {
    case "text": {
      const b = p.bridges.find((x) => x.value.id === id)?.value;
      return b ? contentHash(b.text) : undefined;
    }
    case "snapshot": {
      const s = p.snapshots.find((x) => x.value.id === id)?.value;
      return s ? contentHash(s) : undefined;
    }
    case "profile": {
      const pr = profileById(p, id);
      return pr ? contentHash(pr) : undefined;
    }
    case "thread": {
      const th = p.threads.find((x) => x.value.id === id)?.value;
      return th ? contentHash(th) : undefined;
    }
    case "acceptances": {
      // "acceptances:<character>@<t>": every acceptance for that character at or before t
      const [ch, t] = id.split("@");
      const list = p.acceptances
        .map((a) => a.value)
        .filter((a) => a.character === ch && a.t <= Number(t))
        .sort((a, b) => a.id.localeCompare(b.id));
      return contentHash(list);
    }
    case "prior": {
      // "prior:<t>": arrival states of locked bridges ending at or before t (axis B input)
      const at = new Map(p.snapshots.map((s) => [s.value.id, s.value.t]));
      const list = p.bridges
        .map((b) => b.value)
        .filter((b) => b.status === "locked" && b.derived_snapshot && (at.get(b.to) ?? Infinity) <= Number(id))
        .map((b) => [b.id, b.derived_snapshot])
        .sort();
      return contentHash(list);
    }
    case "project-unknowns":
      return contentHash(normalizeEntries("unknowns", p.config.unknowns));
    case "summary": {
      // graph mode: an edge's one-line plot summary (axis T input)
      const b = p.bridges.find((x) => x.value.id === id)?.value;
      return b ? contentHash(b.summary ?? "") : undefined;
    }
    case "world-rules":
      return contentHash(worldRules(p.config.world_rules));
    case "constraints":
      // axis K reads every constraint at once
      return contentHash([p.profiles.map((x) => x.value), worldRules(p.config.world_rules), normalizeEntries("unknowns", p.config.unknowns)]);
    default:
      return undefined;
  }
}

export function hashAll(p: Project, keys: Iterable<string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of [...new Set(keys)].sort()) out[k] = currentHash(p, k) ?? "missing";
  return out;
}

/** Keys a bridge check depends on. Coarse on purpose: any profile, snapshot, bridge or acceptance it touched. */
export function bridgeCheckKeys(p: Project, bridge: { id: string; from: string; to: string }, characters: string[], axis: string): string[] {
  const from = p.snapshots.find((s) => s.value.id === bridge.from)?.value;
  const t = from?.t ?? 0;
  const keys = axis === "T" ? [`snapshot:${bridge.from}`] : [`text:${bridge.id}`, `snapshot:${bridge.from}`];
  if (axis === "D") keys.push(`snapshot:${bridge.to}`);
  if (axis === "B") keys.push(`prior:${t}`);
  if (axis === "C" || axis === "D" || axis === "T") keys.push("project-unknowns");
  if (axis === "T") keys.push(`snapshot:${bridge.to}`, `summary:${bridge.id}`, "world-rules");
  if (axis === "B" && p.config.mode === "graph") keys.push("world-rules");
  for (const c of characters) keys.push(`profile:${c}`, `acceptances:${c}@${t}`);
  return keys;
}

export interface StaleInfo {
  check: Located<Check>;
  /** dependency keys whose hash changed */
  changed: string[];
}

function storedInputs(c: Check): Record<string, string> {
  const raw = (c as Record<string, unknown>).inputs;
  return raw && typeof raw === "object" ? (raw as Record<string, string>) : {};
}

/** Checks whose inputs changed. Already-stale checks are reported too (with their recorded keys). */
export function findStale(p: Project): StaleInfo[] {
  const out: StaleInfo[] = [];
  for (const c of p.checks) {
    const inputs = storedInputs(c.value);
    const keys = Object.keys(inputs);
    // a check without recorded inputs can't be verified: treat it as stale
    const changed = keys.length ? keys.filter((k) => currentHash(p, k) !== inputs[k]) : ["(没有记录输入)"];
    if (changed.length || c.value.status === "stale") {
      const recorded = (c.value as Record<string, unknown>).stale_keys;
      out.push({ check: c, changed: changed.length ? changed : Array.isArray(recorded) ? (recorded as string[]) : [] });
    }
  }
  return out;
}

/** Write status: stale on every check whose inputs changed; returns them (spec §6-U8). */
export function markStale(p: Project): StaleInfo[] {
  const stale = findStale(p);
  for (const s of stale) {
    if (s.check.value.status === "stale") continue;
    updateYamlFile(p.root, s.check.file, {
      status: "stale",
      previous_status: s.check.value.status,
      stale_keys: s.changed,
      stale_since: new Date().toISOString(),
    });
  }
  return stale;
}

/** Snapshots on the timeline (approved/locked), in t order. */
export function timeline(p: Project) {
  return p.snapshots
    .map((s) => s.value)
    .filter((s) => ENDPOINT_STATUSES.includes(s.status))
    .sort((a, b) => a.t - b.t);
}

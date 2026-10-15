// Character state indexed by story time (spec §3.7, §4.6).
import { anchorEntries } from "./entries";
import type { Project } from "./project";
import { type Acceptance, type CharState, ENDPOINT_STATUSES, type Profile, type Snapshot } from "./schema";

export interface StateAt {
  character: string;
  t: number;
  /** the latest approved/locked snapshot at or before t that has a state for this character */
  snapshot?: Snapshot;
  state?: CharState;
  /** accepted deltas made before t; they modify the snapshot state (applied in order) */
  deltas: Acceptance[];
  /** accepted deviations at or before t, injected into axis A as established turns (§4.6) */
  turns: Acceptance[];
}

/** `character` is a profile id; snapshots key char_states by lane id, resolved here. */
export function stateAt(p: Project, character: string, t: number): StateAt {
  const lane = laneOfProfile(p, character);
  const snap = p.snapshots
    .map((s) => s.value)
    .filter((s) => ENDPOINT_STATUSES.includes(s.status) && s.t <= t && s.char_states[lane])
    .sort((a, b) => b.t - a.t)[0];
  const accepted = p.acceptances.map((a) => a.value).filter((a) => a.character === character).sort((a, b) => a.t - b.t);
  return {
    character,
    t,
    snapshot: snap,
    state: snap?.char_states[lane],
    // spec §4.6: a delta applies to every state after its t, whatever later snapshots say (D-019)
    deltas: accepted.filter((a) => a.t < t),
    turns: accepted.filter((a) => a.t <= t),
  };
}

/** Human-readable state for prompts. Free text in, free text out (spec §12). */
export function renderState(s: StateAt): string {
  const lines: string[] = [];
  const st = s.state;
  if (!st) lines.push("（此刻没有已批准快照记录这个人物的状态）");
  else {
    if (s.snapshot) lines.push(`来源快照：${s.snapshot.id}「${s.snapshot.title}」（t=${s.snapshot.t}）`);
    lines.push(`知道：${st.knows.length ? st.knows.join("；") : "（未列出）"}`);
    lines.push(`想要：${st.wants.length ? st.wants.join("；") : "（未列出）"}`);
    if (st.feels) lines.push(`情绪：${st.feels}`);
    if (st.location) lines.push(`位置：${st.location}`);
    const rel = Object.entries(st.relationships);
    if (rel.length) lines.push(`关系：${rel.map(([k, v]) => `${k}——${v}`).join("；")}`);
    if (st.resources?.length) lines.push(`资源：${st.resources.join("；")}`);
  }
  for (const d of s.deltas) lines.push(`（已接受的变化，t=${d.t}）${d.delta}`);
  return lines.join("\n");
}

export function profileById(p: Project, id: string): Profile | undefined {
  return p.profiles.find((x) => x.value.id === id || x.value.aliases.includes(id) || x.value.name === id)?.value;
}

/** Characters a text involves: the snapshot's character lanes plus anyone named in the text. */
export function involvedCharacters(p: Project, text: string, snapshot?: Snapshot): Profile[] {
  const laneProfile = new Map(p.config.lanes.filter((l) => l.kind === "character").map((l) => [l.id, l.profile ?? l.id]));
  const ids = new Set<string>();
  for (const l of snapshot?.lanes ?? []) {
    const pid = laneProfile.get(l);
    if (pid) ids.add(pid);
  }
  for (const { value: pr } of p.profiles) {
    if ([pr.name, ...pr.aliases].some((n) => n.length >= 2 && text.includes(n))) ids.add(pr.id);
  }
  return [...ids].flatMap((id) => {
    const pr = profileById(p, id);
    return pr ? [pr] : [];
  });
}

/** Map a lane id to its profile id and back; snapshots key char_states by lane id. */
export function laneOfProfile(p: Project, profileId: string): string {
  return p.config.lanes.find((l) => l.kind === "character" && (l.profile ?? l.id) === profileId)?.id ?? profileId;
}

export function hasAnchoredHeuristics(pr: Profile): boolean {
  return anchorEntries(pr.heuristics).length > 0;
}

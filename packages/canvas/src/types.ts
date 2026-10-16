// Shapes of GET /api/project (packages/server/src/view.ts). Kept loose: the files are free text.

export interface Lane {
  id: string;
  kind: "character" | "world";
  name?: string;
  profile?: string;
}

export interface CharState {
  knows: string[];
  wants: string[];
  feels?: string;
  relationships: Record<string, string>;
  location?: string;
  resources?: string[];
}

export interface Entry {
  id: string;
  text: string;
  tag?: string;
  origin: "author" | "profile" | "llm";
  permanent?: boolean;
  secret?: boolean;
}

export interface Profile {
  id: string;
  name: string;
  core?: string;
  traits: Entry[];
  heuristics: Entry[];
  boundaries: Entry[];
  hard_facts: Entry[];
  unknowns: Entry[];
  arc_notes: string;
  source: string;
  readonly: boolean;
  file: string;
}

export interface Snapshot {
  id: string;
  title: string;
  t: number;
  t_label?: string;
  lanes: string[];
  world_facts: string[];
  char_states: Record<string, CharState>;
  open_threads: string[];
  status: "seed" | "sketch" | "approved" | "locked";
  origin: "author" | "llm-candidate" | "derived";
  pruned?: boolean;
  candidate?: { group: string; from: string; to: string; dims: Record<string, string>; touches_unknowns: string[] };
  author_notes: string;
  file: string;
  endpoint?: boolean;
  score?: number;
  [k: string]: unknown;
}

export interface Bridge {
  id: string;
  from: string;
  to: string;
  status: "empty" | "outline" | "draft" | "revised" | "locked";
  outline: string[];
  outline_origin?: string;
  text_origin?: string;
  text: string;
  derived_snapshot?: { world_facts: string[]; char_states: Record<string, CharState> };
  versions: { v: number; at: string; path: string; note?: string }[];
  checks: string[];
  file: string;
  score: number;
  threadScore: number;
  [k: string]: unknown;
}

export interface Thread {
  id: string;
  description: string;
  planted_at: string;
  payoff_at?: string | null;
  visibility: "reader_only" | "character" | "hidden";
  known_by: string[];
  status: string;
  file: string;
  score: number;
  affected: string[];
  unpaid: boolean;
  checked: boolean;
}

export interface Evidence {
  quote: string;
  rule?: string;
  rule_text?: string;
  direction?: string;
  expected?: string;
  note?: string;
  weight?: number;
  verified?: boolean;
}

export interface Check {
  id: string;
  target: string;
  target_kind: "bridge" | "snapshot" | "thread";
  axis: "A" | "B" | "C" | "D" | "E" | "F";
  character?: string;
  score: number;
  confidence: number;
  prediction: string;
  observed: string;
  evidence: Evidence[];
  suggestion: string;
  samples?: { n: number; scores: number[] };
  status: "open" | "accepted" | "fixed" | "dismissed" | "stale";
  notes?: string[];
  justification?: string;
  history?: { at: string; action: string; note?: string; score?: number }[];
  isStale: boolean;
  file: string;
}

export interface Acceptance {
  id: string;
  check: string;
  character: string;
  t: number;
  delta: string;
  justification: string;
}

export interface Gap {
  from: string;
  to: string;
  score: number;
  suggest: boolean;
  changes: { field: string; character?: string; before: string[]; after: string[]; units: number; weight: number }[];
}

export interface Issue {
  level: "error" | "warning";
  file: string;
  line?: number;
  message: string;
}

export interface View {
  root: string;
  name: string;
  lanes: Lane[];
  thresholds: Record<string, { warn: number; high: number }>;
  sampling: number;
  voice: boolean;
  profiles: Profile[];
  snapshots: Snapshot[];
  branches: Snapshot[];
  bridges: Bridge[];
  threads: Thread[];
  checks: Check[];
  acceptances: Acceptance[];
  gaps: Gap[];
  missingBridges: { from: string; to: string }[];
  stale: { id: string; changed: string[] }[];
  issues: Issue[];
}

export type Selection =
  | { kind: "snapshot"; id: string }
  | { kind: "bridge"; id: string }
  | { kind: "thread"; id: string }
  | { kind: "profile"; id: string }
  | { kind: "gap"; from: string; to: string }
  | null;

export const AXIS_NAME: Record<string, string> = { A: "人物偏差", B: "连续性偏差", C: "留白侵入", D: "到达偏差", E: "伏笔偏差", F: "间距" };

export function level(v: View, axis: string, score: number): "high" | "warn" | "ok" {
  const t = v.thresholds[axis] ?? { warn: 40, high: 70 };
  return score >= t.high ? "high" : score >= t.warn ? "warn" : "ok";
}

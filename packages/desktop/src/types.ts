// Mirror of the backend's /api/graph document (packages/server/src/graph-api.ts, buildGraphView).
// Kept by hand so the frontend compiles without Node types.

export type Axis = "A" | "B" | "C" | "D" | "E" | "F" | "T" | "K";

export interface CharState {
  knows: string[];
  wants: string[];
  feels?: string;
  relationships: Record<string, string>;
  location?: string;
  resources?: string[];
}

export interface GraphNode {
  id: string;
  title: string;
  t: number;
  lanes: string[];
  world_facts: string[];
  char_states: Record<string, CharState>;
  author_notes: string;
  file: string;
  pos: { x: number; y: number };
}

export interface EdgeInfo {
  id: string;
  from: string;
  to: string;
  score: number;
  axes: Partial<Record<Axis, number>>;
  checked: boolean;
  stale: boolean;
  hasText: boolean;
}

export interface GraphEdge {
  id: string;
  from: string;
  to: string;
  status: string;
  summary?: string;
  outline: string[];
  text: string;
  file: string;
  info: EdgeInfo;
}

export interface RouteInfo {
  id: string;
  name: string;
  nodes: string[];
  edges: EdgeInfo[];
  score: number;
  weakest?: string;
  complete: boolean;
  broken?: string;
}

export interface Entry {
  id: string;
  text: string;
  tag?: string;
  origin: "author" | "profile" | "llm";
  secret?: boolean;
  permanent?: boolean;
  editable: boolean;
}

export type ConstraintField = "traits" | "heuristics" | "boundaries" | "hard_facts" | "unknowns" | "world_rules";

export interface ConstraintOwner {
  owner: string;
  name: string;
  kind: "character" | "world" | "project";
  core?: string;
  external?: string;
  fields: Partial<Record<ConstraintField, Entry[]>>;
}

export interface Evidence {
  quote: string;
  rule?: string;
  rule_text?: string;
  direction?: "same" | "opposite" | "irrelevant";
  expected?: string;
  note?: string;
  weight?: number;
  verified?: boolean;
}

export interface Check {
  id: string;
  target: string;
  target_kind: "bridge" | "snapshot" | "thread" | "project";
  axis: Axis;
  character?: string;
  score: number;
  confidence: number;
  prediction: string;
  observed: string;
  evidence: Evidence[];
  suggestion: string;
  samples?: { n: number; scores: number[] };
  status: "open" | "accepted" | "fixed" | "dismissed" | "stale";
  justification?: string;
  notes?: string[];
  isStale: boolean;
  file: string;
}

export interface Issue {
  level: "error" | "warning";
  file: string;
  line?: number;
  message: string;
}

export interface GraphView {
  root: string;
  name: string;
  mode: "timeline" | "graph";
  thresholds: Record<Axis, { warn: number; high: number }>;
  sampling: number;
  nodes: GraphNode[];
  edges: GraphEdge[];
  routes: RouteInfo[];
  constraints: ConstraintOwner[];
  constraintCheck: (Check & { isStale: boolean }) | null;
  checks: Check[];
  issues: Issue[];
}

export type Selection = { kind: "node"; id: string } | { kind: "edge"; id: string } | null;

export const AXIS_LABEL: Record<Axis, string> = {
  A: "Character",
  B: "Continuity",
  C: "Unknowns",
  D: "Arrival",
  E: "Threads",
  F: "Gap",
  T: "Transition",
  K: "Constraints",
};

export type Level = "ok" | "warn" | "high" | "none";

export function levelOf(view: Pick<GraphView, "thresholds">, axis: Axis, score: number): Level {
  const t = view.thresholds[axis];
  if (!t) return "none";
  return score >= t.high ? "high" : score >= t.warn ? "warn" : "ok";
}

/** An edge's level: its worst open check against that axis's thresholds. */
export function edgeLevel(view: Pick<GraphView, "thresholds">, info: EdgeInfo): Level {
  if (!info.checked) return "none";
  let worst: Level = "ok";
  const rank = { none: 0, ok: 1, warn: 2, high: 3 };
  for (const [axis, score] of Object.entries(info.axes) as [Axis, number][]) {
    const l = levelOf(view, axis, score);
    if (rank[l] > rank[worst]) worst = l;
  }
  return worst;
}

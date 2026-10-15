// Concept-level data model (spec §4). Free-text fields stay free text (spec §12):
// lists are string lists, unknown keys are preserved (D-002).
import { z } from "zod";

export const AXES = ["A", "B", "C", "D", "E", "F"] as const;
export const Axis = z.enum(AXES);
export type Axis = z.infer<typeof Axis>;

// ---------- Profile entries (D-003) ----------

export const EntryOrigin = z.enum(["author", "profile", "llm"]);
export type EntryOrigin = z.infer<typeof EntryOrigin>;

export const EntryObject = z.looseObject({
  id: z.string().min(1).optional(),
  text: z.string().min(1),
  tag: z.string().optional(),
  origin: EntryOrigin.optional(),
  source: z.string().optional(),
  // unknowns only: a permanent unknown filled by text scores 100 on axis C (spec §5-C)
  permanent: z.boolean().optional(),
  // hard_facts only: the author knows it, the character does not. Generation prompts never see
  // it; continuity checks do, to catch knowledge leaks (D-033)
  secret: z.boolean().optional(),
});
export const EntryInput = z.union([z.string().min(1), EntryObject]);
export type EntryInput = z.infer<typeof EntryInput>;

export interface Entry {
  id: string;
  text: string;
  tag?: string;
  origin: EntryOrigin;
  source?: string;
  permanent?: boolean;
  secret?: boolean;
  [k: string]: unknown;
}

export const ENTRY_FIELDS = {
  traits: "t",
  heuristics: "h",
  boundaries: "b",
  hard_facts: "f",
  unknowns: "u",
  // inferred material (〔推演〕, "推演说明"); never an anchor for any axis (D-006, D-016)
  inferred: "i",
} as const;
export type EntryField = keyof typeof ENTRY_FIELDS;
export const ENTRY_FIELD_NAMES = Object.keys(ENTRY_FIELDS) as EntryField[];

const entryList = z.array(EntryInput).default([]);

// ---------- Profile (§4.1) ----------

export const ProfileFrontmatter = z.looseObject({
  id: z.string().min(1),
  name: z.string().min(1),
  aliases: z.array(z.string()).default([]),
  core: z.string().optional(),
  traits: entryList,
  heuristics: entryList,
  boundaries: entryList,
  hard_facts: entryList,
  unknowns: entryList,
  inferred: entryList,
});

export const ProfileRef = z.looseObject({
  id: z.string().min(1).optional(),
  path: z.string().min(1),
  mapping: z.string().min(1).default("oc-wiki"),
  // project-local additions; the external file is never modified (D-012)
  extra: z
    .partialRecord(z.enum(ENTRY_FIELD_NAMES as [EntryField, ...EntryField[]]), z.array(EntryInput))
    .optional(),
});
export type ProfileRef = z.infer<typeof ProfileRef>;

export interface Profile {
  id: string;
  name: string;
  aliases: string[];
  core?: string;
  traits: Entry[];
  heuristics: Entry[];
  boundaries: Entry[];
  hard_facts: Entry[];
  unknowns: Entry[];
  inferred: Entry[];
  arc_notes: string;
  /** "inline" or the absolute path of the read-only external file */
  source: string;
  readonly: boolean;
}

// ---------- Snapshot (§4.2) ----------

export const CharState = z.looseObject({
  knows: z.array(z.string()).default([]),
  wants: z.array(z.string()).default([]),
  feels: z.string().optional(),
  relationships: z.record(z.string(), z.string()).default({}),
  location: z.string().optional(),
  resources: z.array(z.string()).optional(),
});
export type CharState = z.infer<typeof CharState>;

export const SNAPSHOT_STATUSES = ["seed", "sketch", "approved", "locked"] as const;
export const SnapshotStatus = z.enum(SNAPSHOT_STATUSES);
export type SnapshotStatus = z.infer<typeof SnapshotStatus>;
export const ENDPOINT_STATUSES: readonly SnapshotStatus[] = ["approved", "locked"];

export const SnapshotFrontmatter = z.looseObject({
  id: z.string().min(1),
  title: z.string().min(1),
  // any number: a point inserted between t=0 and t=1 gets t=0.5 (D-034)
  t: z.number(),
  t_label: z.string().optional(),
  lanes: z.array(z.string()).default([]),
  world_facts: z.array(z.string()).default([]),
  char_states: z.record(z.string(), CharState).default({}),
  open_threads: z.array(z.string()).default([]),
  status: SnapshotStatus.default("seed"),
  origin: z.enum(["author", "llm-candidate", "derived"]).default("author"),
  pruned: z.boolean().optional(),
  // set on LLM candidates (spec §6-U3): which pair they sit between and how they differ
  candidate: z
    .looseObject({
      group: z.string(),
      from: z.string(),
      to: z.string(),
      dims: z.record(z.string(), z.string()).default({}),
      touches_unknowns: z.array(z.string()).default([]),
    })
    .optional(),
});
export type Snapshot = z.infer<typeof SnapshotFrontmatter> & { author_notes: string };

// ---------- Bridge (§4.3) ----------

export const DerivedSnapshot = z.looseObject({
  world_facts: z.array(z.string()).default([]),
  char_states: z.record(z.string(), CharState).default({}),
  // provenance: model output until the author adopts it (spec §3.1)
  origin: z.literal("llm").optional(),
  text_hash: z.string().optional(),
  at: z.string().optional(),
});
export type DerivedSnapshot = z.infer<typeof DerivedSnapshot>;

export const BridgeFrontmatter = z.looseObject({
  id: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  status: z.enum(["empty", "outline", "draft", "revised", "locked"]).default("empty"),
  outline: z.array(z.string()).default([]),
  derived_snapshot: DerivedSnapshot.optional(),
  checks: z.array(z.string()).default([]),
  versions: z
    .array(z.looseObject({ v: z.number().int(), at: z.string(), path: z.string(), note: z.string().optional() }))
    .default([]),
  injected: z.record(z.string(), z.unknown()).optional(),
});
export type Bridge = z.infer<typeof BridgeFrontmatter> & { text: string };

// ---------- Thread (§4.4) ----------

export const ThreadFrontmatter = z.looseObject({
  id: z.string().min(1),
  // a snapshot id, or "<bridge-id>#<position>" for a point inside a bridge
  planted_at: z.string().min(1),
  payoff_at: z.string().nullable().optional(),
  visibility: z.enum(["reader_only", "character", "hidden"]),
  known_by: z.array(z.string()).default([]),
  status: z.enum(["open", "paid", "abandoned"]).default("open"),
});
export type Thread = z.infer<typeof ThreadFrontmatter> & { description: string };

// ---------- Check (§4.5) ----------

export const CheckDoc = z.looseObject({
  id: z.string().min(1),
  target: z.string().min(1),
  target_kind: z.enum(["bridge", "snapshot", "thread"]),
  axis: Axis,
  // per-character axes (A)
  character: z.string().optional(),
  score: z.number().min(0).max(100),
  confidence: z.number().min(0).max(1),
  prediction: z.string().default(""),
  observed: z.string().default(""),
  evidence: z
    .array(
      z.looseObject({
        quote: z.string(),
        rule: z.string().optional(),
        direction: z.enum(["same", "opposite", "irrelevant"]).optional(),
      }),
    )
    .default([]),
  suggestion: z.string().default(""),
  samples: z.looseObject({ n: z.number().int().min(1), scores: z.array(z.number()) }).optional(),
  status: z.enum(["open", "accepted", "fixed", "dismissed", "stale"]).default("open"),
  justification: z.string().optional(),
});
export type Check = z.infer<typeof CheckDoc>;

// ---------- Acceptance (§4.6) ----------

export const AcceptanceDoc = z.looseObject({
  id: z.string().min(1),
  check: z.string().min(1),
  character: z.string().min(1),
  t: z.number(),
  delta: z.string().min(1),
  justification: z.string().min(1),
  at: z.string().optional(),
});
export type Acceptance = z.infer<typeof AcceptanceDoc>;

// ---------- Import mapping (§6-U1, D-011) ----------

export const ImportMapping = z.looseObject({
  // where `core` comes from: the first blockquote of the page, or a named section
  core: z.union([z.literal("blockquote"), z.looseObject({ section: z.string() })]).default("blockquote"),
  sections: z
    .array(
      z.looseObject({
        prefix: z.string().min(1),
        field: z.union([z.enum(ENTRY_FIELD_NAMES as [EntryField, ...EntryField[]]), z.literal("arc_notes")]),
        mode: z.enum(["list", "table"]).default("list"),
        origin: EntryOrigin.optional(),
      }),
    )
    .default([]),
  // inline tags such as 〔推演〕 that mark an entry as model-inferred (D-006)
  llm_tags: z.array(z.string()).default([]),
});
export type ImportMapping = z.infer<typeof ImportMapping>;

// ---------- Project (§4.7) ----------

const DEFAULT_THRESHOLDS: Record<Axis, { warn: number; high: number }> = {
  A: { warn: 40, high: 70 },
  B: { warn: 30, high: 60 },
  C: { warn: 50, high: 100 },
  D: { warn: 35, high: 65 },
  E: { warn: 40, high: 70 },
  F: { warn: 60, high: 80 },
};

export const ProjectConfig = z.looseObject({
  name: z.string().min(1),
  language: z.string().default("zh"),
  lanes: z
    .array(
      z.looseObject({
        id: z.string().min(1),
        kind: z.enum(["character", "world"]),
        name: z.string().optional(),
        // profile id for a character lane; defaults to the lane id
        profile: z.string().optional(),
      }),
    )
    .default([]),
  thresholds: z
    .partialRecord(Axis, z.looseObject({ warn: z.number(), high: z.number() }))
    .default({})
    .transform((t) => ({ ...DEFAULT_THRESHOLDS, ...t })),
  sampling: z.number().int().min(1).default(3),
  llm: z
    .looseObject({
      provider: z.string().default("anthropic"),
      model: z.string().default("claude-opus-5-5"),
      check_model: z.string().optional(),
      temperature: z.number().optional(),
    })
    .default({ provider: "anthropic", model: "claude-opus-5-5" }),
  import_mappings: z.record(z.string(), ImportMapping).default({}),
  // project-level voice sample (QUESTIONS 8): Markdown of the author's own prose, path relative to the project
  voice_sample: z.string().optional(),
  // project-level unknowns, checked by axis C alongside every character's (spec §5-C)
  unknowns: z.array(EntryInput).default([]),
});
export type ProjectConfig = z.infer<typeof ProjectConfig>;

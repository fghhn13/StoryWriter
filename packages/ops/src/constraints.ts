// The constraints sidebar (D-064): characters' rules and facts, world rules, project unknowns.
// Inline profiles are edited in place; external (wiki) profiles only through their ref file's
// `extra`, never the wiki itself; world rules and project unknowns live in project.yaml.
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import {
  DIRS,
  ENTRY_FIELDS,
  type Entry,
  type EntryField,
  PROJECT_FILE,
  type Project,
  REF_SUFFIX,
  normalizeEntries,
  readText,
  renderMarkdownFile,
  updateObjectFile,
  updateYamlFile,
  worldRules,
  writeProjectFile,
} from "@sw/core";
import { allConstraints, checkAxisK } from "@sw/checks";
import type { LlmContext } from "@sw/llm";
import { hashAll } from "./deps";
import { ensureLanes } from "./graph";
import { saveCheck } from "./store";

export const PROFILE_FIELDS = ["traits", "heuristics", "boundaries", "hard_facts", "unknowns"] as const;
export type ProfileField = (typeof PROFILE_FIELDS)[number];
export type ConstraintField = ProfileField | "world_rules";

export interface ConstraintEntry extends Entry {
  /** false for entries that come from an external (wiki) page */
  editable: boolean;
}

export interface ConstraintOwner {
  /** profile id, "world" or "project" */
  owner: string;
  name: string;
  kind: "character" | "world" | "project";
  core?: string;
  external?: string;
  fields: Partial<Record<ConstraintField, ConstraintEntry[]>>;
}

export function listConstraints(p: Project): ConstraintOwner[] {
  const out: ConstraintOwner[] = [
    { owner: "world", name: "World", kind: "world", fields: { world_rules: worldRules(p.config.world_rules).map((e) => ({ ...e, editable: true })) } },
    { owner: "project", name: "Project", kind: "project", fields: { unknowns: normalizeEntries("unknowns", p.config.unknowns).map((e) => ({ ...e, editable: true })) } },
  ];
  for (const { value: pr } of p.profiles) {
    const fields: ConstraintOwner["fields"] = {};
    for (const f of PROFILE_FIELDS) {
      const extra = pr.readonly ? extraCount(p, pr.id, f) : 0;
      fields[f] = pr[f].map((e, i) => ({ ...e, editable: !pr.readonly || i >= pr[f].length - extra }));
    }
    out.push({ owner: pr.id, name: pr.name, kind: "character", core: pr.core, external: pr.readonly ? pr.source : undefined, fields });
  }
  return out;
}

// ---------- storage ----------

function toRaw(e: Entry): Record<string, unknown> {
  const out: Record<string, unknown> = { id: e.id, text: e.text };
  for (const k of ["tag", "source", "secret", "permanent"] as const) if (e[k] !== undefined) out[k] = e[k];
  if (e.origin !== "profile") out.origin = e.origin;
  return out;
}

function refFile(p: Project, id: string): string {
  const pr = p.profiles.find((x) => x.value.id === id);
  if (!pr) throw new Error(`找不到人物：${id}`);
  return pr.file;
}

function rawYaml(p: Project, rel: string): Record<string, unknown> {
  return (parse(readText(path.join(p.root, rel))) ?? {}) as Record<string, unknown>;
}

function extraCount(p: Project, id: string, field: EntryField): number {
  const raw = rawYaml(p, refFile(p, id)) as { extra?: Record<string, unknown[]> };
  return raw.extra?.[field]?.length ?? 0;
}

/** Current editable list for (owner, field), already normalised to entries with ids. */
function readList(p: Project, owner: string, field: ConstraintField): Entry[] {
  if (owner === "world") return worldRules(p.config.world_rules);
  if (owner === "project") return normalizeEntries("unknowns", p.config.unknowns);
  const pr = p.profiles.find((x) => x.value.id === owner)?.value;
  if (!pr) throw new Error(`找不到人物：${owner}`);
  if (field === "world_rules") throw new Error("世界规则属于 World，不属于人物");
  if (!pr.readonly) return pr[field];
  // external profile: only the project-local extras are ours to edit
  return pr[field].slice(pr[field].length - extraCount(p, owner, field));
}

function writeList(p: Project, owner: string, field: ConstraintField, list: Entry[]): void {
  const raw = list.map(toRaw);
  if (owner === "world") return void updateYamlFile(p.root, PROJECT_FILE, { world_rules: raw.length ? raw : undefined });
  if (owner === "project") return void updateYamlFile(p.root, PROJECT_FILE, { unknowns: raw.length ? raw : undefined });
  const pr = p.profiles.find((x) => x.value.id === owner)!;
  if (!pr.value.readonly) return void updateObjectFile(p.root, pr.file, { [field]: raw.length ? raw : undefined });
  const ref = rawYaml(p, pr.file) as { extra?: Record<string, unknown> };
  const extra = { ...(ref.extra ?? {}) };
  if (raw.length) extra[field] = raw.map((r) => ({ ...r, source: r.source ?? "StoryWriter" }));
  else delete extra[field];
  updateYamlFile(p.root, pr.file, { extra: Object.keys(extra).length ? extra : undefined });
}

const PREFIX: Record<ConstraintField, string> = { ...ENTRY_FIELDS, world_rules: "w" };

function freeId(p: Project, owner: string, field: ConstraintField): string {
  // ids are unique within the whole field (imported entries included) so references never shift
  const all = owner === "world" || owner === "project" ? readList(p, owner, field) : (p.profiles.find((x) => x.value.id === owner)?.value[field as ProfileField] ?? []);
  const taken = new Set(all.map((e) => e.id));
  for (let n = all.length + 1; ; n++) if (!taken.has(`${PREFIX[field]}${n}`)) return `${PREFIX[field]}${n}`;
}

export interface EntryInputFields {
  text?: string;
  secret?: boolean;
  permanent?: boolean;
}

export function addConstraint(p: Project, owner: string, field: ConstraintField, input: EntryInputFields): string {
  if (!input.text?.trim()) throw new Error("约束内容不能为空");
  const list = readList(p, owner, field);
  const e: Entry = { id: freeId(p, owner, field), text: input.text.trim(), origin: "profile" };
  if (input.secret) e.secret = true;
  if (input.permanent) e.permanent = true;
  writeList(p, owner, field, [...list, e]);
  return `${owner}.${e.id}`;
}

export function editConstraint(p: Project, owner: string, field: ConstraintField, id: string, input: EntryInputFields): string {
  const list = readList(p, owner, field);
  const i = list.findIndex((e) => e.id === id);
  if (i < 0) throw new Error(`这条约束不能在这里改（外部档案的条目只读）：${owner}.${id}`);
  const e = { ...list[i]! };
  if (input.text !== undefined) {
    if (!input.text.trim()) throw new Error("约束内容不能为空");
    e.text = input.text.trim();
  }
  if (input.secret !== undefined) e.secret = input.secret || undefined;
  if (input.permanent !== undefined) e.permanent = input.permanent || undefined;
  list[i] = e;
  writeList(p, owner, field, list);
  return `${owner}.${id}`;
}

export function removeConstraint(p: Project, owner: string, field: ConstraintField, id: string): void {
  const list = readList(p, owner, field);
  if (!list.some((e) => e.id === id)) throw new Error(`这条约束不能在这里删（外部档案的条目只读）：${owner}.${id}`);
  writeList(p, owner, field, list.filter((e) => e.id !== id));
}

export function createProfile(p: Project, input: { id: string; name: string; core?: string }): string {
  const id = input.id.trim();
  if (!/^[\w\-]+$/.test(id)) throw new Error("人物 id 只能用字母、数字、- 和 _");
  if (p.profiles.some((x) => x.value.id === id)) throw new Error(`人物 id 已存在：${id}`);
  if (!input.name.trim()) throw new Error("人物需要名字");
  const rel = path.join(DIRS.profiles, `${id}.md`);
  if (fs.existsSync(path.join(p.root, DIRS.profiles, `${id}${REF_SUFFIX}`))) throw new Error(`已有外部引用：${id}${REF_SUFFIX}`);
  const data: Record<string, unknown> = { id, name: input.name.trim() };
  if (input.core?.trim()) data.core = input.core.trim();
  writeProjectFile(p.root, rel, renderMarkdownFile(data, ""));
  ensureLanes({ ...p, profiles: [...p.profiles, { value: { id, name: input.name.trim() } as never, file: rel, lineOf: () => undefined }] }, [id]);
  return rel;
}

export function updateProfileMeta(p: Project, id: string, input: { name?: string; core?: string }): void {
  const pr = p.profiles.find((x) => x.value.id === id);
  if (!pr) throw new Error(`找不到人物：${id}`);
  if (pr.value.readonly) throw new Error(`${pr.value.name} 来自外部档案，名字和核心只能在原文件里改`);
  const patch: Record<string, unknown> = {};
  if (input.name !== undefined) {
    if (!input.name.trim()) throw new Error("人物需要名字");
    patch.name = input.name.trim();
  }
  if (input.core !== undefined) patch.core = input.core.trim() || undefined;
  updateObjectFile(p.root, pr.file, patch);
}

// ---------- axis K ----------

export const CONSTRAINTS_TARGET = "constraints";

export async function checkConstraints(p: Project, ctx: LlmContext, opts: { changed?: string[]; n?: number } = {}) {
  const r = await checkAxisK(ctx, { constraints: allConstraints(p), changed: opts.changed ?? [], n: opts.n ?? p.config.sampling });
  const saved = saveCheck(p, CONSTRAINTS_TARGET, r, hashAll(p, ["constraints"]), "project");
  return { result: r, saved };
}

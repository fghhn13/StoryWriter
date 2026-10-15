// Load a project folder into memory (spec §4.7, §9). Schema problems become issues, not throws,
// so `sw validate` can report every bad file at once.
import fs from "node:fs";
import path from "node:path";
import type { z } from "zod";
import { normalizeEntries } from "./entries";
import { parseMarkdownFile, parseYamlFile, type YamlSource } from "./frontmatter";
import { DIRS, PROJECT_FILE, REF_SUFFIX, toPosix } from "./paths";
import {
  AcceptanceDoc,
  BridgeFrontmatter,
  CheckDoc,
  ENTRY_FIELD_NAMES,
  type Acceptance,
  type Bridge,
  type Check,
  type EntryInput,
  type ImportMapping,
  type Profile,
  ProfileFrontmatter,
  ProfileRef,
  ProjectConfig,
  type Snapshot,
  SnapshotFrontmatter,
  type Thread,
  ThreadFrontmatter,
} from "./schema";
import { BUILTIN_MAPPINGS, importWikiPage } from "./wiki-import";

export interface Issue {
  level: "error" | "warning";
  /** path relative to the project root, posix separators; absolute for external files */
  file: string;
  line?: number;
  message: string;
}

/** Where an object came from, so later checks can point back at a file and line. */
export interface Located<T> {
  value: T;
  file: string;
  lineOf: YamlSource["lineOf"];
}

export interface Project {
  root: string;
  config: ProjectConfig;
  configSource?: YamlSource;
  profiles: Located<Profile>[];
  snapshots: Located<Snapshot>[];
  /** pruned candidates under branches/ (spec §6-U3); not part of the timeline */
  branchSnapshots: Located<Snapshot>[];
  bridges: Located<Bridge>[];
  threads: Located<Thread>[];
  checks: Located<Check>[];
  acceptances: Located<Acceptance>[];
  issues: Issue[];
  /** ids of files that failed schema validation; references to them are not reported twice */
  unreadableIds: Set<string>;
}

function listFiles(dir: string, pred: (name: string) => boolean): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name.startsWith(".")) continue; // .versions/ etc.
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...listFiles(p, pred));
    else if (pred(ent.name)) out.push(p);
  }
  return out.sort();
}

function zodIssues(err: z.ZodError, file: string, src: YamlSource): Issue[] {
  return err.issues.map((i) => ({
    level: "error" as const,
    file,
    line: src.lineOf(i.path),
    message: `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`,
  }));
}

export function resolveMapping(config: ProjectConfig, name: string): ImportMapping | undefined {
  return config.import_mappings[name] ?? BUILTIN_MAPPINGS[name];
}

export function loadProject(rootDir: string): Project {
  const root = path.resolve(rootDir);
  const rel = (p: string) => toPosix(path.relative(root, p));
  const issues: Issue[] = [];
  const unreadableIds = new Set<string>();
  const noteUnreadable = (data: unknown) => {
    const id = (data as { id?: unknown } | undefined)?.id;
    if (typeof id === "string") unreadableIds.add(id);
  };

  // ---- project.yaml
  const cfgPath = path.join(root, PROJECT_FILE);
  let config = ProjectConfig.parse({ name: path.basename(root) });
  let configSource: YamlSource | undefined;
  if (!fs.existsSync(cfgPath)) {
    issues.push({ level: "error", file: PROJECT_FILE, message: "缺少 project.yaml" });
  } else {
    configSource = parseYamlFile(fs.readFileSync(cfgPath, "utf8"));
    for (const e of configSource.syntaxErrors) issues.push({ level: "error", file: PROJECT_FILE, ...e });
    const parsed = ProjectConfig.safeParse(configSource.data ?? {});
    if (parsed.success) config = parsed.data;
    else if (!configSource.syntaxErrors.length) issues.push(...zodIssues(parsed.error, PROJECT_FILE, configSource));
  }

  // ---- generic markdown-object loader
  function loadMd<S extends z.ZodType, T>(
    file: string,
    schema: S,
    build: (fm: z.infer<S>, body: string) => T,
  ): Located<T> | undefined {
    const f = rel(file);
    const src = parseMarkdownFile(fs.readFileSync(file, "utf8"));
    if (!src.hasFrontmatter) {
      issues.push({ level: "error", file: f, line: 1, message: `缺少 frontmatter（文件应以 --- 开头）` });
      return undefined;
    }
    for (const e of src.syntaxErrors) issues.push({ level: "error", file: f, ...e });
    if (src.syntaxErrors.length) return undefined;
    const parsed = schema.safeParse(src.data ?? {});
    if (!parsed.success) {
      issues.push(...zodIssues(parsed.error, f, src));
      noteUnreadable(src.data);
      return undefined;
    }
    return { value: build(parsed.data, src.body.trim()), file: f, lineOf: src.lineOf };
  }

  function loadYaml<S extends z.ZodType>(file: string, schema: S): Located<z.infer<S>> | undefined {
    const f = rel(file);
    const src = parseYamlFile(fs.readFileSync(file, "utf8"));
    for (const e of src.syntaxErrors) issues.push({ level: "error", file: f, ...e });
    if (src.syntaxErrors.length) return undefined;
    const parsed = schema.safeParse(src.data ?? {});
    if (!parsed.success) {
      issues.push(...zodIssues(parsed.error, f, src));
      noteUnreadable(src.data);
      return undefined;
    }
    return { value: parsed.data, file: f, lineOf: src.lineOf };
  }

  const compact = <T>(xs: (T | undefined)[]) => xs.filter((x): x is T => x !== undefined);

  // ---- profiles: inline *.md and external *.ref.yaml (D-009)
  const profDir = path.join(root, DIRS.profiles);
  const profiles: Located<Profile>[] = [];
  for (const file of listFiles(profDir, (n) => n.endsWith(".md"))) {
    const p = loadMd(file, ProfileFrontmatter, (fm, body): Profile => {
      const entries = Object.fromEntries(
        ENTRY_FIELD_NAMES.map((k) => [k, normalizeEntries(k, fm[k] as EntryInput[])]),
      ) as Pick<Profile, (typeof ENTRY_FIELD_NAMES)[number]>;
      return { id: fm.id, name: fm.name, aliases: fm.aliases, core: fm.core, ...entries, arc_notes: body, source: "inline", readonly: false };
    });
    if (p) profiles.push(p);
  }
  for (const file of listFiles(profDir, (n) => n.endsWith(REF_SUFFIX))) {
    const ref = loadYaml(file, ProfileRef);
    if (!ref) continue;
    const p = resolveRef(ref, path.dirname(file), config, issues);
    if (p) profiles.push({ value: p, file: ref.file, lineOf: ref.lineOf });
  }

  // ---- timeline objects
  const snapBuild = (fm: z.infer<typeof SnapshotFrontmatter>, body: string): Snapshot => ({ ...fm, author_notes: body });
  const snapshots = compact(listFiles(path.join(root, DIRS.snapshots), (n) => n.endsWith(".md")).map((f) => loadMd(f, SnapshotFrontmatter, snapBuild)));
  const branchSnapshots = compact(
    listFiles(path.join(root, DIRS.branches), (n) => n.endsWith(".md")).map((f) => loadMd(f, SnapshotFrontmatter, snapBuild)),
  );
  const bridges = compact(
    listFiles(path.join(root, DIRS.bridges), (n) => n.endsWith(".md")).map((f) =>
      loadMd(f, BridgeFrontmatter, (fm, body): Bridge => ({ ...fm, text: body })),
    ),
  );
  const threads = compact(
    listFiles(path.join(root, DIRS.threads), (n) => n.endsWith(".md")).map((f) =>
      loadMd(f, ThreadFrontmatter, (fm, body): Thread => ({ ...fm, description: body })),
    ),
  );
  const checks = compact(listFiles(path.join(root, DIRS.checks), (n) => /\.ya?ml$/.test(n)).map((f) => loadYaml(f, CheckDoc)));
  const acceptances = compact(
    listFiles(path.join(root, DIRS.acceptances), (n) => /\.ya?ml$/.test(n)).map((f) => loadYaml(f, AcceptanceDoc)),
  );

  return { root, config, configSource, profiles, snapshots, branchSnapshots, bridges, threads, checks, acceptances, issues, unreadableIds };
}

function resolveRef(ref: Located<ProfileRef>, baseDir: string, config: ProjectConfig, issues: Issue[]): Profile | undefined {
  const r = ref.value;
  const ext = path.resolve(baseDir, r.path);
  if (!fs.existsSync(ext)) {
    issues.push({ level: "error", file: ref.file, line: ref.lineOf(["path"]), message: `外部档案不存在：${ext}` });
    return undefined;
  }
  const mapping = resolveMapping(config, r.mapping);
  if (!mapping) {
    issues.push({ level: "error", file: ref.file, line: ref.lineOf(["mapping"]), message: `未知的导入映射：${r.mapping}` });
    return undefined;
  }
  const imp = importWikiPage(fs.readFileSync(ext, "utf8"), mapping);
  const id = r.id ?? imp.id;
  if (!id) {
    issues.push({ level: "error", file: ref.file, message: "外部档案没有 id，请在引用文件里写 id" });
    return undefined;
  }
  const entries = Object.fromEntries(
    ENTRY_FIELD_NAMES.map((k) => {
      const extra = r.extra?.[k] ?? [];
      for (const [i, e] of extra.entries()) {
        if (typeof e === "string" || !e.source) {
          issues.push({ level: "warning", file: ref.file, line: ref.lineOf(["extra", k, i]), message: `extra.${k} 的追加条目应写 source（说明出处）` });
        }
      }
      return [k, normalizeEntries(k, [...imp.entries[k], ...extra])];
    }),
  ) as Pick<Profile, (typeof ENTRY_FIELD_NAMES)[number]>;
  return {
    id,
    name: imp.name ?? id,
    aliases: imp.aliases,
    core: imp.core,
    ...entries,
    arc_notes: imp.arc_notes,
    source: ext,
    readonly: true,
  };
}

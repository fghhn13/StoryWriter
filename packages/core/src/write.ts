// All writes go through here so nothing outside the project folder is ever touched.
import fs from "node:fs";
import path from "node:path";
import { parseDocument } from "yaml";
import { renderMarkdownFile, renderYamlFile } from "./frontmatter";
import { DIRS, PROJECT_FILE, REF_SUFFIX, assertInsideProject, readText, toPosix } from "./paths";
import type { ImportedProfile } from "./wiki-import";
import { BUILTIN_MAPPINGS } from "./wiki-import";

export function writeProjectFile(root: string, relPath: string, content: string, opts: { overwrite?: boolean } = {}): string {
  const abs = assertInsideProject(root, relPath);
  if (!opts.overwrite && fs.existsSync(abs)) throw new Error(`文件已存在：${abs}`);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, content, "utf8");
  return abs;
}

export function initProject(dir: string, opts: { name: string; mapping?: string }): void {
  const root = path.resolve(dir);
  if (fs.existsSync(path.join(root, PROJECT_FILE))) throw new Error(`${root} 已经是项目（已有 ${PROJECT_FILE}）`);
  const config: Record<string, unknown> = {
    name: opts.name,
    language: "zh",
    lanes: [{ id: "world", kind: "world", name: "世界" }],
    sampling: 3,
    llm: { provider: "anthropic", model: "claude-opus-5-5" },
  };
  // copy the mapping into the project so the author can see and edit it (spec §6-U1 "映射可保存复用")
  if (opts.mapping) {
    const m = BUILTIN_MAPPINGS[opts.mapping];
    if (!m) throw new Error(`未知的内置映射：${opts.mapping}`);
    config.import_mappings = { [opts.mapping]: m };
  }
  writeProjectFile(root, PROJECT_FILE, renderYamlFile(config));
  for (const d of Object.values(DIRS)) fs.mkdirSync(path.join(root, d), { recursive: true });
}

/** Reference an external page read-only (default import mode). */
export function writeProfileRef(root: string, externalPath: string, id: string, mapping: string): string {
  const refRel = path.join(DIRS.profiles, `${id}${REF_SUFFIX}`);
  const refDir = path.dirname(path.join(root, refRel));
  const target = path.relative(refDir, path.resolve(externalPath));
  return writeProjectFile(root, refRel, renderYamlFile({ id, path: toPosix(target), mapping }));
}

/** Copy an imported page into the project as an editable inline profile. */
export function writeInlineProfile(root: string, imp: ImportedProfile, id: string, sourcePath: string): string {
  const data: Record<string, unknown> = { id, name: imp.name ?? id, aliases: imp.aliases };
  if (imp.core) data.core = imp.core;
  for (const [k, list] of Object.entries(imp.entries)) {
    if (list.length) data[k] = list.map((e) => (e.tag || e.source || e.origin !== "profile" ? e : e.text));
  }
  data.imported_from = toPosix(path.resolve(sourcePath));
  return writeProjectFile(root, path.join(DIRS.profiles, `${id}.md`), renderMarkdownFile(data, imp.arc_notes));
}

// ---------- updating objects in place ----------

const FM_RE = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/;

/**
 * Patch a Markdown object's frontmatter (undefined deletes a key) and optionally replace its body.
 * Goes through the YAML document so the author's comments and key order survive.
 */
export function updateObjectFile(root: string, relPath: string, patch: Record<string, unknown>, body?: string): string {
  const abs = assertInsideProject(root, relPath);
  const m = FM_RE.exec(readText(abs));
  if (!m) throw new Error(`不是带 frontmatter 的对象文件：${abs}`);
  const doc = parseDocument(m[1]!);
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) doc.delete(k);
    else doc.set(k, doc.createNode(v));
  }
  const b = (body ?? m[2]!).trim();
  fs.writeFileSync(abs, `---\n${doc.toString({ lineWidth: 0 }).trimEnd()}\n---\n${b ? `\n${b}\n` : ""}`, "utf8");
  return abs;
}

export function moveProjectFile(root: string, fromRel: string, toRel: string): string {
  const from = assertInsideProject(root, fromRel);
  const to = assertInsideProject(root, toRel);
  if (fs.existsSync(to)) throw new Error(`目标文件已存在：${to}`);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.renameSync(from, to);
  return to;
}

/** Keep the current file as `<dir>/.versions/<id>/v<n>.md` before it is rewritten (spec §4.3 versions). */
export function saveVersion(root: string, dir: string, id: string, relPath: string): { v: number; path: string } {
  const vdir = path.join(dir, ".versions", id);
  const absDir = assertInsideProject(root, vdir);
  const taken = fs.existsSync(absDir) ? fs.readdirSync(absDir).map((n) => Number(/^v(\d+)\.md$/.exec(n)?.[1] ?? 0)) : [];
  const v = Math.max(0, ...taken) + 1;
  const rel = toPosix(path.join(vdir, `v${v}.md`));
  writeProjectFile(root, rel, readText(assertInsideProject(root, relPath)));
  return { v, path: rel };
}

/** A file name that does not exist yet: `<dir>/<base>.md`, else `<base>-2.md`, ... */
export function freeFileName(root: string, dir: string, base: string, ext = ".md"): string {
  const safe = base.replace(/[\/:*?"<>|\s]+/g, "-");
  for (let n = 1; ; n++) {
    const rel = toPosix(path.join(dir, `${safe}${n === 1 ? "" : `-${n}`}${ext}`));
    if (!fs.existsSync(path.join(root, rel))) return rel;
  }
}

/** Patch a YAML object file (checks, acceptances) keeping comments; undefined deletes a key. */
export function updateYamlFile(root: string, relPath: string, patch: Record<string, unknown>): string {
  const abs = assertInsideProject(root, relPath);
  const doc = parseDocument(readText(abs));
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) doc.delete(k);
    else doc.set(k, doc.createNode(v));
  }
  fs.writeFileSync(abs, doc.toString({ lineWidth: 0 }), "utf8");
  return abs;
}

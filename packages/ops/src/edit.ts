// Plain edits the canvas needs so the author never has to open a file (spec §10-M4): new
// snapshots and bridges, field edits as YAML, lane order, confirming model output (spec §3.1).
import fs from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import {
  BridgeFrontmatter,
  DIRS,
  PROJECT_FILE,
  type Project,
  SnapshotFrontmatter,
  ThreadFrontmatter,
  freeFileName,
  readText,
  renderMarkdownFile,
  saveVersion,
  updateObjectFile,
  updateYamlFile,
  writeProjectFile,
} from "@sw/core";

export function createSnapshot(p: Project, data: Record<string, unknown>, notes = ""): string {
  const parsed = SnapshotFrontmatter.safeParse(data);
  if (!parsed.success) throw new Error(`快照字段不对：${parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("；")}`);
  if ([...p.snapshots, ...p.branchSnapshots].some((s) => s.value.id === parsed.data.id)) throw new Error(`快照 id 已存在：${parsed.data.id}`);
  const file = freeFileName(p.root, DIRS.snapshots, `t${parsed.data.t}-${parsed.data.id}`);
  writeProjectFile(p.root, file, renderMarkdownFile(data, notes));
  return file;
}

/** An empty bridge between two snapshots; validation decides whether it may be generated. */
export function createBridge(p: Project, from: string, to: string, id?: string): { id: string; file: string } {
  const at = (sid: string) => {
    const s = p.snapshots.find((x) => x.value.id === sid)?.value;
    if (!s) throw new Error(`找不到快照：${sid}`);
    return String(s.t).replace(".", "_");
  };
  // short default id from the two t values ("b-0-1"); snapshot ids can be long (candidates)
  let bid = id ?? `b-${at(from)}-${at(to)}`;
  if (id && p.bridges.some((b) => b.value.id === id)) throw new Error(`桥 id 已存在：${id}`);
  for (let n = 2; p.bridges.some((b) => b.value.id === bid); n++) bid = `b-${at(from)}-${at(to)}-${n}`;
  const file = freeFileName(p.root, DIRS.bridges, bid);
  writeProjectFile(p.root, file, renderMarkdownFile({ id: bid, from, to, status: "empty" }, ""));
  return { id: bid, file };
}

const KINDS = {
  snapshot: { schema: SnapshotFrontmatter, list: (p: Project) => [...p.snapshots, ...p.branchSnapshots], body: "author_notes" },
  bridge: { schema: BridgeFrontmatter, list: (p: Project) => p.bridges, body: "text" },
  thread: { schema: ThreadFrontmatter, list: (p: Project) => p.threads, body: "description" },
} as const;
export type EditableKind = keyof typeof KINDS;

/**
 * Replace an object's frontmatter with the author's YAML (keys left out are deleted) and optionally
 * its body. The id can't change here: references would break.
 */
export function editObject(p: Project, kind: EditableKind, id: string, yamlText: string, body?: string): string {
  const k = KINDS[kind];
  const obj = (k.list(p) as { value: Record<string, unknown>; file: string }[]).find((x) => x.value.id === id);
  if (!obj) throw new Error(`找不到 ${kind}：${id}`);
  let data: unknown;
  try {
    data = parse(yamlText);
  } catch (e) {
    throw new Error(`YAML 写错了：${(e as Error).message.split("\n")[0]}`);
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("需要一个 YAML 对象（键: 值）");
  const next = { ...(data as Record<string, unknown>), id };
  const parsed = k.schema.safeParse(next);
  if (!parsed.success) throw new Error(parsed.error.issues.map((i) => `${i.path.join(".") || "(根)"}: ${i.message}`).join("；"));
  const old = Object.keys(obj.value).filter((key) => key !== k.body);
  const patch: Record<string, unknown> = Object.fromEntries(old.map((key) => [key, undefined]));
  Object.assign(patch, next);
  updateObjectFile(p.root, obj.file, patch, body);
  return obj.file;
}

/** The author accepts model output as theirs: drop the "model-generated" markers (spec §3.1). */
export function confirmModelOutput(p: Project, kind: "snapshot" | "bridge", id: string, what?: "outline" | "text"): void {
  if (kind === "snapshot") {
    const s = [...p.snapshots, ...p.branchSnapshots].find((x) => x.value.id === id);
    if (!s) throw new Error(`找不到快照：${id}`);
    // a candidate the author read and kept is now the author's
    updateObjectFile(p.root, s.file, { origin: "author" });
    return;
  }
  const b = p.bridges.find((x) => x.value.id === id);
  if (!b) throw new Error(`找不到桥：${id}`);
  const patch: Record<string, unknown> = {};
  if (!what || what === "outline") patch.outline_origin = undefined;
  if (!what || what === "text") patch.text_origin = undefined;
  updateObjectFile(p.root, b.file, patch);
}

export function reorderLanes(p: Project, order: string[]): void {
  const lanes = p.config.lanes;
  if (order.length !== lanes.length || !lanes.every((l) => order.includes(l.id))) throw new Error("泳道顺序要包含全部泳道，且不多不少");
  const raw = parse(readText(path.join(p.root, PROJECT_FILE))) as { lanes?: { id: string }[] };
  const byId = new Map((raw.lanes ?? []).map((l) => [l.id, l]));
  updateYamlFile(p.root, PROJECT_FILE, { lanes: order.map((id) => byId.get(id)) });
}

const FM = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n?([\s\S]*)$/;

/** The object's frontmatter as the author wrote it (comments included) and its body, for editing. */
export function readObjectSource(p: Project, kind: EditableKind, id: string): { yaml: string; body: string; file: string } {
  const obj = (KINDS[kind].list(p) as { value: { id: string }; file: string }[]).find((x) => x.value.id === id);
  if (!obj) throw new Error(`找不到 ${kind}：${id}`);
  const m = FM.exec(readText(path.join(p.root, obj.file)));
  return { yaml: m?.[1] ?? "", body: (m?.[2] ?? "").trim(), file: obj.file };
}

/**
 * The author edits a bridge's outline or text by hand: the edit is theirs, so the model marker is
 * dropped, a hand-edited draft becomes `revised`, and the previous text is kept as a version.
 */
export function saveBridge(p: Project, id: string, edit: { outline?: string[]; text?: string; status?: string }): void {
  const b = p.bridges.find((x) => x.value.id === id);
  if (!b) throw new Error(`找不到桥：${id}`);
  const patch: Record<string, unknown> = {};
  if (edit.outline) {
    patch.outline = edit.outline.map((s) => s.trim()).filter(Boolean);
    patch.outline_origin = undefined;
    if (b.value.status === "empty") patch.status = "outline";
  }
  let body: string | undefined;
  if (edit.text !== undefined && edit.text.trim() !== b.value.text.trim()) {
    if (b.value.text) {
      const v = saveVersion(p.root, DIRS.bridges, id, b.file);
      patch.versions = [...b.value.versions, { v: v.v, at: new Date().toISOString(), path: v.path, note: "作者手改前" }];
    }
    body = edit.text;
    patch.text_origin = undefined;
    if (["empty", "outline", "draft"].includes(b.value.status)) patch.status = "revised";
  }
  if (edit.status) {
    const ok = BridgeFrontmatter.shape.status.safeParse(edit.status);
    if (!ok.success) throw new Error(`桥状态只能是 empty / outline / draft / revised / locked`);
    patch.status = edit.status;
  }
  updateObjectFile(p.root, b.file, patch, body);
}

// Prompt templates are Markdown files the author can read and edit (spec §8).
// File format: YAML frontmatter {id, version}, then "# system" and "# user" sections. {{var}} placeholders.
import fs from "node:fs";
import { parse } from "yaml";

export interface Template {
  id: string;
  version: number;
  system: string;
  user: string;
  file: string;
}

export function loadTemplate(file: string): Template {
  // LF only: a CRLF checkout must not change prompts or recording keys (D-051)
  const text = fs.readFileSync(file, "utf8").replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!m) throw new Error(`模板缺少 frontmatter：${file}`);
  const fm = parse(m[1]!) as { id?: string; version?: number };
  const sections = new Map<string, string>();
  let cur: string | undefined;
  for (const line of m[2]!.split(/\r?\n/)) {
    const h = /^# (system|user)\s*$/.exec(line);
    if (h) {
      cur = h[1]!;
      sections.set(cur, "");
    } else if (cur) sections.set(cur, `${sections.get(cur)}${line}\n`);
  }
  if (!fm.id || !fm.version || !sections.has("user")) throw new Error(`模板需要 id、version 和 # user 小节：${file}`);
  return { id: fm.id, version: fm.version, system: (sections.get("system") ?? "").trim(), user: sections.get("user")!.trim(), file };
}

/** Replace {{name}}; an unknown placeholder is a bug in the caller, so it throws. */
export function render(tpl: string, vars: Record<string, string>): string {
  return tpl.replace(/\{\{\s*([a-zA-Z_][\w]*)\s*\}\}/g, (_, k: string) => {
    if (!(k in vars)) throw new Error(`模板变量未提供：${k}`);
    return vars[k]!;
  });
}

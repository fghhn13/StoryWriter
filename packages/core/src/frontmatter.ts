// Markdown + YAML frontmatter, keeping source positions so issues can point at a line.
import { Document, LineCounter, isNode, parseDocument, stringify } from "yaml";

export interface YamlSource {
  data: unknown;
  /** resolve a data path (e.g. ["char_states", "tina", "knows"]) to a 1-based file line */
  lineOf(path: readonly PropertyKey[]): number | undefined;
  /** YAML syntax errors, already positioned */
  syntaxErrors: { line: number; message: string }[];
}

export interface MarkdownSource extends YamlSource {
  body: string;
  hasFrontmatter: boolean;
}

function yamlSource(text: string, lineOffset: number): YamlSource {
  const lc = new LineCounter();
  const doc = parseDocument(text, { lineCounter: lc, uniqueKeys: true });
  const toLine = (offset: number) => lc.linePos(offset).line + lineOffset;
  return {
    data: doc.errors.length ? undefined : doc.toJS(),
    syntaxErrors: doc.errors.map((e) => ({
      line: toLine(e.pos[0]),
      message: e.message.split("\n")[0] ?? e.message,
    })),
    lineOf: (path) => lineOfPath(doc, path, toLine),
  };
}

function lineOfPath(doc: Document, path: readonly PropertyKey[], toLine: (o: number) => number): number | undefined {
  // walk up the path until a node exists (a missing key points at its parent)
  for (let n = path.length; n >= 0; n--) {
    const node = n === 0 ? doc.contents : doc.getIn(path.slice(0, n) as unknown[], true);
    if (isNode(node) && node.range) return toLine(node.range[0]);
  }
  return undefined;
}

export function parseYamlFile(text: string): YamlSource {
  return yamlSource(text, 0);
}

const FM_OPEN = /^---\r?\n/;
const FM_CLOSE = /^---[ \t]*$/m;

export function parseMarkdownFile(text: string): MarkdownSource {
  const src = text.replace(/^﻿/, "");
  if (!FM_OPEN.test(src)) {
    return { data: undefined, body: src, hasFrontmatter: false, syntaxErrors: [], lineOf: () => undefined };
  }
  const afterOpen = src.replace(FM_OPEN, "");
  const close = FM_CLOSE.exec(afterOpen);
  if (!close) {
    return {
      data: undefined,
      body: "",
      hasFrontmatter: true,
      syntaxErrors: [{ line: 1, message: "frontmatter 没有结束的 ---" }],
      lineOf: () => undefined,
    };
  }
  const fm = afterOpen.slice(0, close.index);
  const body = afterOpen.slice(close.index + close[0].length).replace(/^\r?\n/, "");
  // frontmatter text starts on file line 2
  return { ...yamlSource(fm, 1), body, hasFrontmatter: true };
}

export function renderMarkdownFile(data: Record<string, unknown>, body: string): string {
  const fm = stringify(data, { lineWidth: 0 }).trimEnd();
  const b = body.trim();
  return `---\n${fm}\n---\n${b ? `\n${b}\n` : ""}`;
}

export function renderYamlFile(data: unknown): string {
  return stringify(data, { lineWidth: 0 });
}

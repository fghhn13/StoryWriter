// Map a wiki character page onto Profile fields (spec §6-U1, §11; D-011).
import { parseMarkdownFile } from "./frontmatter";
import type { EntryField, EntryOrigin, ImportMapping } from "./schema";
import { ImportMapping as ImportMappingSchema } from "./schema";

export const BUILTIN_MAPPINGS: Record<string, ImportMapping> = {
  "oc-wiki": ImportMappingSchema.parse({
    core: "blockquote",
    sections: [
      { prefix: "核心人格", field: "traits" },
      { prefix: "写作指南", field: "heuristics" },
      { prefix: "写作边界", field: "boundaries" },
      { prefix: "留白", field: "unknowns" },
      { prefix: "基础档案", field: "hard_facts", mode: "table" },
      { prefix: "推演说明", field: "inferred", origin: "llm" },
      { prefix: "成长弧", field: "arc_notes" },
    ],
    llm_tags: ["推演", "Agent 建议"],
  }),
};

export type ImportedEntry = {
  text: string;
  tag?: string;
  origin: EntryOrigin;
  source?: string;
};

export interface ImportedProfile {
  id?: string;
  name?: string;
  aliases: string[];
  core?: string;
  entries: Record<EntryField, ImportedEntry[]>;
  arc_notes: string;
  /** headings that no mapping rule matched, reported so the author sees what was skipped */
  unmatched: string[];
}

interface Section {
  heading: string;
  lines: string[];
}

const TAG_RE = /〔([^〕]+)〕/;
const SOURCE_RE = /（源：([^）]+)）/;

export function stripInline(s: string): string {
  return s
    .replace(/\*\*(.+?)\*\*/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function splitSections(body: string): { preamble: string[]; sections: Section[] } {
  const preamble: string[] = [];
  const sections: Section[] = [];
  for (const line of body.split(/\r?\n/)) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) sections.push({ heading: h[1]!, lines: [] });
    else (sections.at(-1)?.lines ?? preamble).push(line);
  }
  return { preamble, sections };
}

function listItems(lines: string[]): string[] {
  const items: string[] = [];
  let cur: string[] | null = null;
  const flush = () => {
    if (cur?.length) items.push(cur.join(""));
    cur = null;
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim() || /^\s*\|/.test(line) || /^\s*>/.test(line)) {
      flush();
      continue;
    }
    const m = /^\s*(?:[-*+]|\d+[.)、])\s+(.*)$/.exec(line);
    if (m) {
      flush();
      cur = [m[1]!];
    } else if (cur && /^\s+/.test(raw)) {
      cur.push(line.trim());
    } else {
      // a plain paragraph line inside a mapped section counts as its own entry (D-011)
      flush();
      cur = [line.trim()];
    }
  }
  flush();
  return items;
}

function tableItems(lines: string[]): string[] {
  const rows = lines
    .filter((l) => /^\s*\|/.test(l))
    .map((l) =>
      l
        .trim()
        .replace(/^\||\|$/g, "")
        .split("|")
        .map((c) => c.trim()),
    );
  // drop header and separator rows
  return rows
    .filter((cells, i) => i > 0 && !cells.every((c) => /^:?-+:?$/.test(c)))
    .map((cells) => (cells.length >= 2 ? `${cells[0]}：${cells.slice(1).join(" | ")}` : cells.join("")));
}

function toEntry(raw: string, mapping: ImportMapping, sectionTag?: string, sectionSource?: string, forced?: EntryOrigin): ImportedEntry {
  let text = stripInline(raw);
  let tag: string | undefined;
  const lead = /^〔([^〕]+)〕\s*/.exec(text);
  if (lead) {
    tag = lead[1];
    text = text.slice(lead[0].length);
  } else {
    tag = TAG_RE.exec(text)?.[1] ?? sectionTag;
  }
  const source = SOURCE_RE.exec(text)?.[1] ?? sectionSource;
  const isLlm = forced === "llm" || (tag !== undefined && mapping.llm_tags.includes(tag));
  const e: ImportedEntry = { text, origin: forced ?? (isLlm ? "llm" : "profile") };
  if (tag) e.tag = tag;
  if (source) e.source = source;
  return e;
}

export function importWikiPage(markdown: string, mapping: ImportMapping): ImportedProfile {
  const src = parseMarkdownFile(markdown);
  const fm = (src.data ?? {}) as Record<string, unknown>;
  const { preamble, sections } = splitSections(src.body);

  const out: ImportedProfile = {
    id: typeof fm.id === "string" ? fm.id : undefined,
    name: typeof fm.title === "string" ? fm.title : undefined,
    aliases: Array.isArray(fm.aliases) ? fm.aliases.map(String) : [],
    entries: { traits: [], heuristics: [], boundaries: [], hard_facts: [], unknowns: [], inferred: [] },
    arc_notes: "",
    unmatched: [],
  };

  if (mapping.core === "blockquote") {
    const quote = preamble.filter((l) => /^\s*>/.test(l)).map((l) => l.replace(/^\s*>\s?/, ""));
    if (quote.length) out.core = stripInline(quote.join("")).replace(/^角色核心[：:]\s*/, "");
  }

  const arc: string[] = [];
  for (const sec of sections) {
    if (typeof mapping.core === "object" && sec.heading.startsWith(mapping.core.section)) {
      out.core = stripInline(listItems(sec.lines).join(" "));
      continue;
    }
    const rule = mapping.sections.find((r) => sec.heading.startsWith(r.prefix));
    if (!rule) {
      out.unmatched.push(sec.heading);
      continue;
    }
    if (rule.field === "arc_notes") {
      arc.push(`## ${sec.heading}\n${sec.lines.join("\n").trim()}`);
      continue;
    }
    const sectionTag = TAG_RE.exec(sec.heading)?.[1];
    const sectionSource = SOURCE_RE.exec(sec.heading)?.[1];
    // table mode still keeps the prose around the table (e.g. Tina's identity-swap paragraph)
    const raws = rule.mode === "table" ? [...tableItems(sec.lines), ...listItems(sec.lines)] : listItems(sec.lines);
    out.entries[rule.field].push(...raws.map((r) => toEntry(r, mapping, sectionTag, sectionSource, rule.origin)));
  }
  out.arc_notes = arc.join("\n\n");
  return out;
}

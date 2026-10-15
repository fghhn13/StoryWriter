// Reverse extraction of the arrival state (spec §4.3 derived_snapshot, §5-D.1).
// The target snapshot must never reach the prompt: `ExtractInput` has no field for it, and
// `extractForBridge` only ever looks up the bridge's `from` (D-037).
import { CharState, type DerivedSnapshot, type Project, type Snapshot } from "@sw/core";
import { renderUnknowns, unknownScope } from "@sw/checks";
import { type LlmContext, callStructured } from "@sw/llm";
import { z } from "zod";
import { type Cast, castOf, findSnapshot, hash, opsTemplate, renderSnapshot } from "./brief";

export const ExtractOutput = z.object({
  world_facts: z.array(z.string()).default([]),
  char_states: z.record(z.string(), CharState).default({}),
});

export interface ExtractInput {
  text: string;
  /** the bridge's start; the only snapshot extraction may see */
  from: Snapshot;
  cast: Cast[];
  unknowns: string;
}

export async function extractDerived(ctx: LlmContext, input: ExtractInput): Promise<DerivedSnapshot> {
  const lanes = input.cast.map((c) => c.lane);
  const out = await callStructured(ctx, {
    task: "extract",
    template: opsTemplate("extract"),
    schema: ExtractOutput,
    summary: `反向提取：起点 ${input.from.id} · 人物 ${lanes.join(",")} · 正文 ${input.text.length} 字（不含目标快照）`,
    vars: {
      from: renderSnapshot(input.from),
      characters: input.cast.map((c) => `- [${c.lane}] ${c.profile.name}`).join("\n") || "（无）",
      unknowns: input.unknowns,
      text: input.text,
    },
  });
  // keep only the characters asked for; the model sometimes adds bystanders
  const char_states = Object.fromEntries(Object.entries(out.char_states).filter(([k]) => lanes.includes(k)));
  return { world_facts: out.world_facts, char_states, origin: "llm", text_hash: hash(input.text), at: new Date().toISOString() };
}

/** Extraction input for a bridge. Characters = the start's lanes plus anyone named in the text. */
export function extractInputFor(p: Project, bridge: { from: string; text: string }): ExtractInput {
  const from = findSnapshot(p, bridge.from);
  const cast = castOf(p, from);
  for (const { value: pr } of p.profiles) {
    if (cast.some((c) => c.profile.id === pr.id)) continue;
    if ([pr.name, ...pr.aliases].some((n) => n.length >= 2 && bridge.text.includes(n))) {
      const lane = p.config.lanes.find((l) => l.kind === "character" && (l.profile ?? l.id) === pr.id)?.id ?? pr.id;
      cast.push({ lane, profile: pr });
    }
  }
  return { text: bridge.text, from, cast, unknowns: renderUnknowns(unknownScope(p, cast.map((c) => c.profile.id))) };
}

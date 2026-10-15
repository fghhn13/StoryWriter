// Structured output over plain text chat: ask for JSON, validate with zod, allow one repair turn.
import type { z } from "zod";
import type { CallLog } from "./log";
import { type ChatMessage, LlmError, type LlmProvider } from "./provider";
import { type Template, render } from "./template";

export interface LlmContext {
  provider: LlmProvider;
  log: CallLog;
  model: string;
  temperature?: number;
  max_tokens?: number;
  /** distinguishes repeated runs of the same check in recordings (e.g. "run2") */
  runTag?: string;
}

export function extractJson(text: string): unknown {
  const fence = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text);
  const candidate = fence ? fence[1]! : text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1);
  if (!candidate.trim()) throw new Error("输出里没有 JSON 对象");
  return JSON.parse(candidate);
}

export interface StructuredCall<S extends z.ZodType> {
  task: string;
  template: Template;
  vars: Record<string, string>;
  schema: S;
  /** short human-readable description of what was injected (spec §3.5) */
  summary: string;
  sample?: number;
}

export async function callStructured<S extends z.ZodType>(ctx: LlmContext, call: StructuredCall<S>): Promise<z.infer<S>> {
  const messages: ChatMessage[] = [];
  if (call.template.system) messages.push({ role: "system", content: render(call.template.system, call.vars) });
  messages.push({ role: "user", content: render(call.template.user, call.vars) });

  let lastError = "";
  for (let attempt = 1; attempt <= 2; attempt++) {
    const req = { model: ctx.model, messages: [...messages], max_tokens: ctx.max_tokens ?? 8000, temperature: ctx.temperature };
    const base = { task: call.task, template: `${call.template.id}@${call.template.version}`, sample: call.sample, attempt, model: ctx.model, input_summary: call.summary, messages: req.messages };
    let res;
    try {
      res = await ctx.provider.chat(req, { key: `${ctx.runTag ?? ""}#${call.task}#${call.sample ?? 0}#${attempt}` });
    } catch (e) {
      ctx.log.add({ ...base, output: "", seconds: 0, error: (e as Error).message });
      throw e;
    }
    const rec = { ...base, output: res.text, usage: res.usage, seconds: res.seconds, replayed: res.replayed, model: res.model };
    try {
      const parsed = call.schema.safeParse(extractJson(res.text));
      if (parsed.success) {
        ctx.log.add(rec);
        return parsed.data;
      }
      lastError = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(根)"}: ${i.message}`).join("\n");
    } catch (e) {
      lastError = (e as Error).message;
    }
    ctx.log.add({ ...rec, error: lastError });
    // one repair turn for malformed content; network/HTTP errors are never retried (vendor AGENTS.md)
    messages.push({ role: "assistant", content: res.text });
    messages.push({ role: "user", content: `上面的输出不符合要求的 JSON 结构：\n${lastError}\n只输出修正后的完整 JSON，不要任何其他文字。` });
  }
  throw new LlmError(`${call.task}：模型两次都没给出合法 JSON：${lastError}`, "format");
}

export interface TextCall {
  task: string;
  template: Template;
  vars: Record<string, string>;
  summary: string;
}

/** Free-text generation (bridge prose). One call, no sampling; the text is the artifact. */
export async function callText(ctx: LlmContext, call: TextCall): Promise<string> {
  const messages: ChatMessage[] = [];
  if (call.template.system) messages.push({ role: "system", content: render(call.template.system, call.vars) });
  messages.push({ role: "user", content: render(call.template.user, call.vars) });
  const req = { model: ctx.model, messages, max_tokens: ctx.max_tokens ?? 8000, temperature: ctx.temperature };
  const base = { task: call.task, template: `${call.template.id}@${call.template.version}`, attempt: 1, model: ctx.model, input_summary: call.summary, messages };
  let res;
  try {
    res = await ctx.provider.chat(req, { key: `${ctx.runTag ?? ""}#${call.task}#0#1` });
  } catch (e) {
    ctx.log.add({ ...base, output: "", seconds: 0, error: (e as Error).message });
    throw e;
  }
  ctx.log.add({ ...base, output: res.text, usage: res.usage, seconds: res.seconds, replayed: res.replayed, model: res.model });
  const fence = /^\s*```[a-z]*\s*\n([\s\S]*?)\n```\s*$/.exec(res.text);
  const text = (fence ? fence[1]! : res.text).trim();
  if (!text) throw new LlmError(`${call.task}：模型返回了空正文`, "format");
  return text;
}

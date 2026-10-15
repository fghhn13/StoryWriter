// Per-project call log (spec §3.5): input summary, full output, model, tokens, time, cost.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ChatRequest, ChatResponse } from "./provider";

export interface Pricing {
  /** price per million tokens, in whatever currency the relay bills */
  input: number;
  output: number;
}

export interface CallRecord {
  id: string;
  at: string;
  task: string;
  template: string;
  sample?: number;
  attempt: number;
  model: string;
  input_summary: string;
  input_hash: string;
  messages: ChatRequest["messages"];
  output: string;
  usage?: ChatResponse["usage"];
  seconds: number;
  cost?: number;
  replayed?: boolean;
  error?: string;
}

export class CallLog {
  readonly records: CallRecord[] = [];

  constructor(
    /** `<project>/llm-log`, or undefined to keep records in memory only */
    private readonly dir?: string,
    private readonly pricing: Record<string, Pricing> = {},
  ) {}

  add(r: Omit<CallRecord, "id" | "at" | "input_hash" | "cost">): CallRecord {
    const at = new Date().toISOString();
    const input_hash = crypto.createHash("sha256").update(JSON.stringify(r.messages)).digest("hex").slice(0, 16);
    const p = this.pricing[r.model];
    const cost =
      p && r.usage ? ((r.usage.prompt_tokens ?? 0) * p.input + (r.usage.completion_tokens ?? 0) * p.output) / 1e6 : undefined;
    const rec: CallRecord = { id: `${at.replace(/[:.]/g, "-")}-${input_hash}-${r.sample ?? 0}-${r.attempt}`, at, input_hash, cost, ...r };
    this.records.push(rec);
    // replayed calls are not real calls; don't clutter the project log with them
    if (this.dir && !r.replayed) {
      const day = path.join(this.dir, at.slice(0, 10));
      fs.mkdirSync(day, { recursive: true });
      fs.writeFileSync(path.join(day, `${rec.id}.json`), JSON.stringify(rec, null, 1));
    }
    return rec;
  }

  totals() {
    const live = this.records.filter((r) => !r.replayed);
    return {
      calls: live.length,
      replayed: this.records.length - live.length,
      tokens: live.reduce((s, r) => s + (r.usage?.total_tokens ?? 0), 0),
      seconds: live.reduce((s, r) => s + r.seconds, 0),
      cost: live.some((r) => r.cost !== undefined) ? live.reduce((s, r) => s + (r.cost ?? 0), 0) : undefined,
    };
  }
}

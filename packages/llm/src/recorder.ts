// Record / replay (spec §8, §14.4): recorded outputs are test fixtures; tests never hit the API.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { type ChatRequest, type ChatResponse, LlmError, type LlmProvider } from "./provider";

export type LlmMode = "live" | "record" | "replay";

export function requestKey(req: ChatRequest, salt = ""): string {
  const canon = JSON.stringify({ model: req.model, messages: req.messages, max_tokens: req.max_tokens, temperature: req.temperature, salt });
  return crypto.createHash("sha256").update(canon).digest("hex").slice(0, 24);
}

interface Recording {
  key: string;
  request: ChatRequest;
  response: ChatResponse;
  recorded_at: string;
}

/**
 * Wraps a provider. Record mode only calls the API for requests not yet recorded (delete a file
 * to re-record it). `meta.key` distinguishes otherwise identical requests (e.g. sample #2 of 3), so replaying a multi-sample check returns the same distinct samples every time.
 */
export class RecordingProvider implements LlmProvider {
  readonly name: string;

  constructor(
    private readonly inner: LlmProvider | undefined,
    private readonly dir: string,
    private readonly mode: LlmMode,
  ) {
    this.name = `${mode}:${inner?.name ?? "none"}`;
  }

  private file(key: string) {
    return path.join(this.dir, `${key}.json`);
  }

  async chat(req: ChatRequest, meta?: { key?: string }): Promise<ChatResponse> {
    const key = requestKey(req, meta?.key);
    const f = this.file(key);
    // record mode reuses what is already recorded and only pays for what is missing
    if (this.mode === "record" && fs.existsSync(f)) {
      return { ...(JSON.parse(fs.readFileSync(f, "utf8")) as Recording).response, replayed: true };
    }
    if (this.mode === "replay") {
      if (!fs.existsSync(f)) throw new LlmError(`回放缺少录制：${key}（提示模板或输入变了？用 SW_LLM_MODE=record 重新录制）`, "replay-miss");
      const rec = JSON.parse(fs.readFileSync(f, "utf8")) as Recording;
      return { ...rec.response, replayed: true };
    }
    if (!this.inner) throw new LlmError("live / record 模式需要真实 provider", "network");
    const response = await this.inner.chat(req, meta);
    if (this.mode === "record") {
      fs.mkdirSync(this.dir, { recursive: true });
      const rec: Recording = { key, request: req, response, recorded_at: new Date().toISOString() };
      fs.writeFileSync(this.file(key), JSON.stringify(rec, null, 1));
    }
    return response;
  }
}

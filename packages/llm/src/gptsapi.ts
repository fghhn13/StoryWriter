// TypeScript port of vendor/gptsapi-agent-starter/api.py's client: Bearer auth, browser
// User-Agent, redirects rejected (never forward the key), no automatic retries.
import type { LlmEnv } from "./config";
import { type ChatRequest, type ChatResponse, LlmError, type LlmProvider } from "./provider";

export class GptsApiProvider implements LlmProvider {
  readonly name = "gptsapi";

  constructor(
    private readonly env: LlmEnv,
    private readonly timeoutMs = 300_000,
  ) {}

  private redact(s: string): string {
    return s.split(this.env.apiKey).join("[REDACTED]");
  }

  private async post(endpoint: string, payload: unknown | undefined, accept = "application/json"): Promise<Response> {
    let res: Response;
    try {
      res = await fetch(this.env.baseUrl + endpoint, {
        method: payload === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${this.env.apiKey}`,
          "User-Agent": this.env.userAgent,
          Accept: accept,
          "Content-Type": "application/json",
        },
        body: payload === undefined ? undefined : JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // no HTTP response yet: this says nothing about whether the key is valid
      throw new LlmError(`网络错误：${this.redact(String((e as Error).cause ?? e))}`, "network");
    }
    if (!res.ok) {
      const body = await res.text();
      const detail = this.redact(body).slice(0, 1000);
      const kind = res.status === 401 ? "auth" : res.status === 403 && body.includes("1010") ? "blocked" : "http";
      throw new LlmError(`HTTP ${res.status}：${detail}`, kind);
    }
    return res;
  }

  private async request(endpoint: string, payload?: unknown): Promise<{ data: Record<string, unknown>; seconds: number }> {
    const start = performance.now();
    const res = await this.post(endpoint, payload);
    const body = await res.text();
    let data: unknown;
    try {
      data = JSON.parse(body);
    } catch {
      throw new LlmError("接口返回的不是 JSON", "http");
    }
    if (!data || typeof data !== "object") throw new LlmError("接口返回的 JSON 结构不对", "http");
    if ("error" in data) throw new LlmError(`接口错误：${this.redact(JSON.stringify((data as { error: unknown }).error)).slice(0, 1000)}`, "model");
    return { data: data as Record<string, unknown>, seconds: (performance.now() - start) / 1000 };
  }

  async models(): Promise<string[]> {
    const { data } = await this.request("/models");
    const list = data.data;
    if (!Array.isArray(list)) throw new LlmError("模型列表缺少 data[].id", "http");
    return list.map((m: { id?: unknown }) => String(m.id));
  }

  /**
   * Streams (SSE). The relay's non-streaming endpoint returns an empty `content` once the answer
   * is longer than a few hundred tokens while still billing them (measured 2026-10-15, D-029).
   */
  async chat(req: ChatRequest): Promise<ChatResponse> {
    const payload: Record<string, unknown> = {
      model: req.model,
      messages: req.messages,
      max_tokens: req.max_tokens,
      stream: true,
      stream_options: { include_usage: true },
    };
    if (req.temperature !== undefined) payload.temperature = req.temperature;
    const start = performance.now();
    const res = await this.post("/chat/completions", payload, "text/event-stream");
    const raw = await res.text();
    let text = "";
    let model = req.model;
    let usage: ChatResponse["usage"];
    let finish: string | undefined;
    for (const line of raw.split(/\r?\n/)) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let chunk: { model?: string; usage?: ChatResponse["usage"]; error?: unknown; choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[] };
      try {
        chunk = JSON.parse(data);
      } catch {
        throw new LlmError("流式响应里有无法解析的数据块", "http");
      }
      if (chunk.error) throw new LlmError(`接口错误：${this.redact(JSON.stringify(chunk.error)).slice(0, 1000)}`, "model");
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      for (const c of chunk.choices ?? []) {
        if (c.delta?.content) text += c.delta.content;
        if (c.finish_reason) finish = c.finish_reason;
      }
    }
    if (!text && (usage?.completion_tokens ?? 0) > 0) {
      throw new LlmError(`中转站返回了空正文，但计了 ${usage!.completion_tokens} 个输出 token`, "http");
    }
    return { text, model, usage, finish_reason: finish, seconds: (performance.now() - start) / 1000 };
  }

  /** Non-streaming chat, kept for `sw llm smoke` (the path the vendor repo verified). */
  async chatOnce(req: ChatRequest): Promise<ChatResponse> {
    const payload: Record<string, unknown> = { model: req.model, messages: req.messages, max_tokens: req.max_tokens, stream: false };
    if (req.temperature !== undefined) payload.temperature = req.temperature;
    const { data, seconds } = await this.request("/chat/completions", payload);
    const choice = (data.choices as { message?: { content?: unknown }; finish_reason?: string }[] | undefined)?.[0];
    const text = choice?.message?.content;
    if (typeof text !== "string") throw new LlmError("回复缺少 choices[0].message.content", "http");
    const usage = data.usage as ChatResponse["usage"];
    if (!text && (usage?.completion_tokens ?? 0) > 0) {
      throw new LlmError(`中转站返回了空正文，但计了 ${usage!.completion_tokens} 个输出 token`, "http");
    }
    return { text, model: typeof data.model === "string" ? data.model : req.model, usage, finish_reason: choice?.finish_reason, seconds };
  }
}

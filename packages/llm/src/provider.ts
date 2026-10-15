// Provider abstraction (spec §8). Only non-streaming text chat is assumed; the relay has not been
// verified for tool calling, so structured output is done by prompting for JSON (see structured.ts).

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface ChatRequest {
  model: string;
  messages: ChatMessage[];
  max_tokens: number;
  temperature?: number;
}

export interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
}

export interface ChatResponse {
  text: string;
  model: string;
  usage?: Usage;
  finish_reason?: string;
  seconds: number;
  /** true when served from a recording instead of the network */
  replayed?: boolean;
}

export interface LlmProvider {
  readonly name: string;
  chat(req: ChatRequest, meta?: { key?: string }): Promise<ChatResponse>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly kind: "network" | "http" | "auth" | "blocked" | "model" | "format" | "replay-miss",
  ) {
    super(message);
  }
}

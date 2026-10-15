import path from "node:path";
import { loadLlmEnv } from "./config";
import { GptsApiProvider } from "./gptsapi";
import { CallLog, type Pricing } from "./log";
import { type LlmMode, RecordingProvider } from "./recorder";
import type { LlmContext } from "./structured";

export interface ContextOptions {
  /** project root: llm-log/ lives here, and .env is looked up here first */
  projectRoot?: string;
  model?: string;
  temperature?: number;
  /** SW_LLM_MODE overrides; default live */
  mode?: LlmMode;
  /** where record mode writes and replay mode reads; default <projectRoot>/llm-log/recordings */
  recordings?: string;
  pricing?: Record<string, Pricing>;
  envFile?: string;
}

export function currentMode(fallback: LlmMode = "live"): LlmMode {
  const m = process.env.SW_LLM_MODE;
  if (m === "live" || m === "record" || m === "replay") return m;
  if (m) throw new Error(`SW_LLM_MODE 只能是 live / record / replay，当前是 ${m}`);
  return fallback;
}

export function createContext(opts: ContextOptions): LlmContext {
  const mode = currentMode(opts.mode);
  const root = opts.projectRoot;
  const recordings = opts.recordings ?? (root ? path.join(root, "llm-log", "recordings") : undefined);
  // replay needs no credentials at all
  const env = mode === "replay" ? undefined : loadLlmEnv({ envFile: opts.envFile, dirs: [root, process.cwd()].filter((d): d is string => !!d), model: opts.model });
  const live = env ? new GptsApiProvider(env) : undefined;
  if (mode !== "live" && !recordings) throw new Error(`${mode} 模式需要录制目录`);
  const provider = mode === "live" ? live! : new RecordingProvider(live, recordings!, mode);
  return {
    provider,
    log: new CallLog(root ? path.join(root, "llm-log") : undefined, opts.pricing),
    model: opts.model ?? env?.model ?? "claude-opus-5-5",
    temperature: opts.temperature,
  };
}

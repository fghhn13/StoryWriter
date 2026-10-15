// Credentials and endpoint for the GPTsAPI relay. Same rules as vendor/gptsapi-agent-starter/api.py:
// CLI flags > process env > config file > defaults; both dotenv and "Base URL: ..." formats.
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_BASE_URL = "https://api2.gptsapi.net/v1";
export const DEFAULT_MODEL = "claude-opus-5-5";
// The relay's Cloudflare rejects default library user agents (HTTP 403 / 1010).
export const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";

const VARS = ["GPTSAPI_API_KEY", "GPTSAPI_BASE_URL", "GPTSAPI_MODEL", "GPTSAPI_USER_AGENT"] as const;
const LABELS: Record<string, (typeof VARS)[number]> = {
  "Base URL": "GPTSAPI_BASE_URL",
  "API Key": "GPTSAPI_API_KEY",
  Model: "GPTSAPI_MODEL",
};

export interface LlmEnv {
  apiKey: string;
  baseUrl: string;
  model: string;
  userAgent: string;
  /** which file the values came from, for error messages (never the key itself) */
  configFile?: string;
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.replace(/^﻿/, "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    let name: string;
    let value: string;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (m) {
      name = m[1]!;
      value = m[2]!;
    } else {
      const i = line.indexOf(":");
      const label = i < 0 ? "" : line.slice(0, i).trim();
      if (!LABELS[label]) throw new Error("配置文件里有无法识别的行；格式见 .env.example");
      name = LABELS[label];
      value = line.slice(i + 1);
    }
    value = value.trim();
    if (value.length >= 2 && /^["']/.test(value) && value.at(-1) === value[0]) value = value.slice(1, -1);
    else value = value.split(/\s+#/)[0]!.trim();
    out[name] = value;
  }
  return out;
}

export function normalizeBaseUrl(url: string): string {
  const u = new URL(url.replace(/\/+$/, ""));
  if (u.protocol !== "https:" || u.username || u.password || u.search || u.hash || !["", "/", "/v1"].includes(u.pathname)) {
    throw new Error("Base URL 必须是 HTTPS 站点根地址，可以带一个 /v1");
  }
  return `${u.origin}/v1`;
}

/** Look for an explicit file, else `.env` in each of `dirs` (first hit wins). */
export function loadLlmEnv(opts: { envFile?: string; dirs?: string[]; model?: string; baseUrl?: string } = {}): LlmEnv {
  let file: string | undefined;
  if (opts.envFile) {
    if (!fs.existsSync(opts.envFile)) throw new Error(`配置文件不存在：${opts.envFile}`);
    file = opts.envFile;
  } else {
    file = (opts.dirs ?? [process.cwd()]).map((d) => path.join(d, ".env")).find((f) => fs.existsSync(f));
  }
  const values = file ? parseEnvFile(fs.readFileSync(file, "utf8")) : {};
  for (const v of VARS) if (process.env[v]) values[v] = process.env[v]!;
  const apiKey = values.GPTSAPI_API_KEY ?? "";
  if (!apiKey || apiKey === "sk-your-key-here") {
    throw new Error(`没有找到 GPTSAPI_API_KEY。请在 .env 里填写（模板见 .env.example）${file ? `；已读取 ${file}` : ""}`);
  }
  return {
    apiKey,
    baseUrl: normalizeBaseUrl(opts.baseUrl ?? values.GPTSAPI_BASE_URL ?? DEFAULT_BASE_URL),
    model: opts.model ?? values.GPTSAPI_MODEL ?? DEFAULT_MODEL,
    userAgent: values.GPTSAPI_USER_AGENT ?? DEFAULT_USER_AGENT,
    configFile: file,
  };
}

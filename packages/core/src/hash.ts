import crypto from "node:crypto";

/** Short content hash used for stale detection (spec §6-U8). Objects hash by their JSON. */
export function contentHash(value: unknown): string {
  const s = typeof value === "string" ? value : JSON.stringify(value ?? null);
  return crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);
}

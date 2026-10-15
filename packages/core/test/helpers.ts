import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const REPO = path.resolve(__dirname, "../../..");
export const MINIMAL = path.join(REPO, "fixtures/minimal-project");

/** Copy a fixture into a fresh temp dir so a test can break it. */
export function tempCopy(src: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sw-test-"));
  fs.cpSync(src, dir, { recursive: true });
  return dir;
}

export function edit(file: string, from: string | RegExp, to: string): void {
  const s = fs.readFileSync(file, "utf8");
  const out = s.replace(from, to);
  if (out === s) throw new Error(`edit had no effect on ${file}: ${from}`);
  fs.writeFileSync(file, out);
}

/** 1-based line of the first line containing `needle`. */
export function lineOf(file: string, needle: string): number {
  const i = fs.readFileSync(file, "utf8").split(/\r?\n/).findIndex((l) => l.includes(needle));
  if (i < 0) throw new Error(`${needle} not in ${file}`);
  return i + 1;
}

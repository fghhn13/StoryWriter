import path from "node:path";

export const PROJECT_FILE = "project.yaml";

export const DIRS = {
  profiles: "profiles",
  snapshots: "snapshots",
  bridges: "bridges",
  threads: "threads",
  checks: "checks",
  acceptances: "acceptances",
  branches: "branches",
  llmLog: "llm-log",
} as const;

export const REF_SUFFIX = ".ref.yaml";

/** Throws unless `target` lies inside `root`. External profiles are read-only (spec §6-U1). */
export function assertInsideProject(root: string, target: string): string {
  const abs = path.resolve(root, target);
  const rel = path.relative(path.resolve(root), abs);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(`拒绝写入项目外的文件：${abs}`);
  }
  return abs;
}

export function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

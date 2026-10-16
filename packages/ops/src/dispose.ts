// U6 处置: accept (with a reason → state delta), dismiss, mark fixed. Every action is appended to
// the check's history (spec §6-U6). Fixing a bridge or a snapshot is a file edit; the stale scan
// picks it up (D-046).
import fs from "node:fs";
import path from "node:path";
import { DIRS, type Check, assertInsideProject, type Located, type Project, loadProject, renderYamlFile, toPosix, updateYamlFile, writeProjectFile } from "@sw/core";
import { hashAll, markStale, type StaleInfo } from "./deps";
import { type HistoryEntry, findCheck } from "./store";

function history(c: Check): HistoryEntry[] {
  const h = (c as Record<string, unknown>).history;
  return Array.isArray(h) ? (h as HistoryEntry[]) : [];
}

function record(p: Project, c: Located<Check>, patch: Record<string, unknown>, entry: Omit<HistoryEntry, "at">) {
  updateYamlFile(p.root, c.file, { ...patch, history: [...history(c.value), { at: new Date().toISOString(), ...entry }] });
}

/** Story time of a check's target: a bridge's start, a snapshot's t, a thread's planting point. */
export function targetTime(p: Project, c: Check): number {
  const snapT = (id: string) => p.snapshots.find((s) => s.value.id === id)?.value.t;
  if (c.target_kind === "snapshot") return snapT(c.target) ?? 0;
  if (c.target_kind === "bridge") {
    const b = p.bridges.find((x) => x.value.id === c.target)?.value;
    return (b && snapT(b.from)) ?? 0;
  }
  const th = p.threads.find((x) => x.value.id === c.target)?.value;
  const at = th?.planted_at.split("#")[0];
  const b = p.bridges.find((x) => x.value.id === at)?.value;
  return (at && (snapT(at) ?? (b && snapT(b.from)))) || 0;
}

export interface AcceptResult {
  acceptance: string;
  file: string;
  t: number;
  /** other checks the new delta made stale (spec §4.6) */
  stale: StaleInfo[];
}

/**
 * Accept a deviation (spec §4.6): the delta applies to the character's state after t and is
 * injected into later axis-A checks as an established turn. The delta defaults to the reason.
 */
export function acceptCheck(p: Project, id: string, opts: { justification: string; delta?: string; character?: string }): AcceptResult {
  const c = findCheck(p, id);
  if (!opts.justification.trim()) throw new Error("接受偏差必须写理由（--why）");
  const character = opts.character ?? c.value.character;
  if (!character) throw new Error(`检查 ${id} 不针对单个人物：用 --character 指定这条变化属于谁`);
  if (!p.profiles.some((x) => x.value.id === character)) throw new Error(`找不到人物：${character}`);
  const t = targetTime(p, c.value);
  let accId = `acc-${id}`;
  for (let n = 2; p.acceptances.some((a) => a.value.id === accId); n++) accId = `acc-${id}-${n}`;
  const file = toPosix(path.join(DIRS.acceptances, `${accId}.yaml`));
  const delta = opts.delta?.trim() || opts.justification.trim();
  writeProjectFile(
    p.root,
    file,
    renderYamlFile({
      id: accId,
      check: id,
      character,
      t,
      // graph mode: the delta hangs on the edge and flows downstream of it (D-059)
      ...(p.config.mode === "graph" && c.value.target_kind === "bridge" ? { on: c.value.target } : {}),
      delta,
      justification: opts.justification.trim(),
      at: new Date().toISOString(),
      origin: "author",
    }),
  );
  record(p, c, { status: "accepted", justification: opts.justification.trim(), acceptance: accId }, { action: "accept", note: delta });

  // the acceptance answers this check, so it must not make the check itself stale
  refreshInputs(p.root, id);
  return { acceptance: accId, file, t, stale: markStale(loadProject(p.root)) };
}

/** Re-hash a check's recorded inputs without rerunning it: only its own acceptance changed. */
function refreshInputs(root: string, id: string) {
  const p = loadProject(root);
  const c = findCheck(p, id);
  const inputs = (c.value as Record<string, unknown>).inputs as Record<string, string> | undefined;
  if (inputs) updateYamlFile(root, c.file, { inputs: hashAll(p, Object.keys(inputs)) });
}

export function dismissCheck(p: Project, id: string, reason: string): void {
  if (!reason.trim()) throw new Error("忽略也要写一句原因（--why）");
  const c = findCheck(p, id);
  record(p, c, { status: "dismissed", dismissed_reason: reason.trim() }, { action: "dismiss", note: reason.trim() });
}

export function markFixed(p: Project, id: string, note = ""): void {
  const c = findCheck(p, id);
  record(p, c, { status: "fixed" }, { action: "fixed", ...(note ? { note } : {}) });
}

/** Undo an acceptance (QUESTIONS 9: accept applies at once but can be revoked). */
export function revokeAcceptance(p: Project, accId: string): StaleInfo[] {
  const a = p.acceptances.find((x) => x.value.id === accId);
  if (!a) throw new Error(`找不到接受记录：${accId}`);
  fs.rmSync(assertInsideProject(p.root, a.file));
  const c = p.checks.find((x) => x.value.id === a.value.check);
  if (c) {
    record(p, c, { status: "open", acceptance: undefined, justification: undefined }, { action: "revoke", note: accId });
    refreshInputs(p.root, c.value.id);
  }
  return markStale(loadProject(p.root));
}

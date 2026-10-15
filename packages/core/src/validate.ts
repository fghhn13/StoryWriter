// Cross-object validation (D-014). Schema issues are already collected by loadProject.
import { anchorEntries } from "./entries";
import { PROJECT_FILE } from "./paths";
import type { Issue, Located, Project } from "./project";
import { ENDPOINT_STATUSES, type Snapshot } from "./schema";

export function validateProject(p: Project): Issue[] {
  const issues: Issue[] = [...p.issues];
  const err = (o: Located<unknown>, path: PropertyKey[], message: string) =>
    issues.push({ level: "error", file: o.file, line: o.lineOf(path), message });
  // a reference to an object whose own file failed to parse: that file's error already says it
  const missing = <K>(m: Map<K, unknown>, id: K) => !m.has(id) && !p.unreadableIds.has(id as string);
  const warn = (o: Located<unknown>, path: PropertyKey[], message: string) =>
    issues.push({ level: "warning", file: o.file, line: o.lineOf(path), message });

  // ---- duplicate ids per kind
  function index<T extends { id: string }>(kind: string, xs: Located<T>[]): Map<string, Located<T>> {
    const m = new Map<string, Located<T>>();
    for (const x of xs) {
      const prev = m.get(x.value.id);
      if (prev) err(x, ["id"], `${kind} id 重复：${x.value.id}（另见 ${prev.file}）`);
      else m.set(x.value.id, x);
    }
    return m;
  }
  const profiles = index("档案", p.profiles);
  const snapshots = index("快照", [...p.snapshots, ...p.branchSnapshots]);
  const bridges = index("桥", p.bridges);
  const threads = index("线", p.threads);
  const checks = index("检查", p.checks);
  index("接受", p.acceptances);

  // ---- lanes (project.yaml)
  const lanes = new Map(p.config.lanes.map((l) => [l.id, l]));
  const cfgLine = (path: PropertyKey[]) => p.configSource?.lineOf(path);
  p.config.lanes.forEach((l, i) => {
    if (p.config.lanes.findIndex((x) => x.id === l.id) !== i) {
      issues.push({ level: "error", file: PROJECT_FILE, line: cfgLine(["lanes", i, "id"]), message: `泳道 id 重复：${l.id}` });
    }
    if (l.kind === "character" && !profiles.has(l.profile ?? l.id)) {
      issues.push({ level: "warning", file: PROJECT_FILE, line: cfgLine(["lanes", i]), message: `人物泳道 ${l.id} 没有对应档案 ${l.profile ?? l.id}` });
    }
  });
  const characterOfLane = (id: string) => {
    const l = lanes.get(id);
    return l?.kind === "character" ? (l.profile ?? l.id) : undefined;
  };

  // ---- profiles
  const aliasOwner = new Map<string, string>();
  for (const pr of p.profiles) {
    const v = pr.value;
    if (anchorEntries(v.heuristics).length === 0) {
      warn(pr, ["heuristics"], `${v.name} 没有决策规则（heuristics），轴 A 置信度上限 0.3，人物偏差不可信`);
    }
    for (const a of [v.name, ...v.aliases]) {
      const owner = aliasOwner.get(a);
      if (owner && owner !== v.id) warn(pr, ["aliases"], `别名「${a}」同时属于 ${owner} 和 ${v.id}`);
      else aliasOwner.set(a, v.id);
    }
  }

  // ---- snapshots
  for (const s of [...p.snapshots, ...p.branchSnapshots]) {
    const v = s.value;
    v.lanes.forEach((l, i) => {
      if (!lanes.has(l)) err(s, ["lanes", i], `快照引用了不存在的泳道：${l}`);
    });
    for (const ch of Object.keys(v.char_states)) {
      if (!v.lanes.includes(ch)) err(s, ["char_states", ch], `char_states 里的 ${ch} 不在本快照的 lanes 中`);
      else if (lanes.has(ch) && !characterOfLane(ch)) err(s, ["char_states", ch], `${ch} 是世界泳道，不能有人物状态`);
      for (const other of Object.keys(v.char_states[ch]?.relationships ?? {})) {
        if (missing(profiles, other) && !aliasOwner.has(other)) {
          warn(s, ["char_states", ch, "relationships", other], `relationships 里的 ${other} 不是已知人物`);
        }
      }
    }
    v.open_threads.forEach((t, i) => {
      if (missing(threads, t)) err(s, ["open_threads", i], `open_threads 引用了不存在的线：${t}`);
    });
  }

  // timeline = snapshots/ only; candidates under branches/ are off the line
  const timeline = [...p.snapshots].sort((a, b) => a.value.t - b.value.t);
  const endpoint = (s: Snapshot) => ENDPOINT_STATUSES.includes(s.status);
  for (let i = 1; i < timeline.length; i++) {
    const a = timeline[i - 1]!;
    const b = timeline[i]!;
    if (a.value.t === b.value.t) {
      const msg = `快照 ${a.value.id} 与 ${b.value.id} 的 t 相同（${b.value.t}），MVP 只支持单时间线`;
      if (endpoint(a.value) && endpoint(b.value)) err(b, ["t"], msg);
      else warn(b, ["t"], msg);
    }
  }

  // ---- bridges: approved/locked endpoints, adjacent only (spec §4.2, §7)
  for (const br of p.bridges) {
    const v = br.value;
    const from = snapshots.get(v.from)?.value;
    const to = snapshots.get(v.to)?.value;
    if (!from && missing(snapshots, v.from)) err(br, ["from"], `桥的起点快照不存在：${v.from}`);
    if (!to && missing(snapshots, v.to)) err(br, ["to"], `桥的终点快照不存在：${v.to}`);
    if (from && !endpoint(from)) err(br, ["from"], `起点快照 ${from.id} 状态为 ${from.status}，只有 approved / locked 能作桥端点`);
    if (to && !endpoint(to)) err(br, ["to"], `终点快照 ${to.id} 状态为 ${to.status}，只有 approved / locked 能作桥端点`);
    if (from && to) {
      if (from.t >= to.t) err(br, ["to"], `桥必须从较早的快照连到较晚的快照（${from.t} → ${to.t}）`);
      const between = timeline.filter((s) => endpoint(s.value) && s.value.t > from.t && s.value.t < to.t);
      if (between.length) {
        err(br, ["to"], `桥只能连相邻快照；${from.id} 与 ${to.id} 之间还有 ${between.map((s) => s.value.id).join("、")}`);
      }
    }
    v.checks.forEach((c, i) => {
      if (missing(checks, c)) err(br, ["checks", i], `桥引用了不存在的检查：${c}`);
    });
    if (v.status !== "empty" && !v.text && v.status !== "outline") warn(br, ["status"], `桥状态为 ${v.status} 但没有正文`);
  }

  // ---- threads
  const pointExists = (ref: string) => {
    const id = ref.split("#")[0]!;
    return snapshots.has(id) || bridges.has(id) || p.unreadableIds.has(id);
  };
  for (const th of p.threads) {
    const v = th.value;
    if (!pointExists(v.planted_at)) err(th, ["planted_at"], `埋点不存在：${v.planted_at}`);
    if (v.payoff_at && !pointExists(v.payoff_at)) err(th, ["payoff_at"], `收点不存在：${v.payoff_at}`);
    if (v.visibility === "character" && v.known_by.length === 0) {
      warn(th, ["known_by"], `visibility 为 character 时应列出哪些人物知道（known_by）`);
    }
    v.known_by.forEach((c, i) => {
      if (missing(profiles, c)) err(th, ["known_by", i], `known_by 引用了不存在的人物：${c}`);
    });
    if (v.status === "paid" && !v.payoff_at) warn(th, ["status"], `线标为 paid 但没有收点`);
  }

  // ---- checks / acceptances
  const targetExists = { bridge: bridges, snapshot: snapshots, thread: threads } as const;
  for (const c of p.checks) {
    if (missing(targetExists[c.value.target_kind], c.value.target)) {
      err(c, ["target"], `检查对象不存在：${c.value.target_kind} ${c.value.target}`);
    }
    if (c.value.status === "accepted" && !c.value.justification) warn(c, ["justification"], `已接受的检查应写理由`);
  }
  for (const a of p.acceptances) {
    if (missing(checks, a.value.check)) err(a, ["check"], `接受引用了不存在的检查：${a.value.check}`);
    if (missing(profiles, a.value.character)) err(a, ["character"], `接受引用了不存在的人物：${a.value.character}`);
  }

  return issues;
}

# ARCHITECTURE

需求来源：`F:\fghn_works\fghn's oc universe\experiments\story-engine-spec.md`（v0.1，下称"规格"）。
本文件把规格 §4–§9 映射成模块。语义变更先记 `DECISIONS.md`。

## 模块总览

| 包 | 职责 | 对应规格 | 里程碑 |
|---|---|---|---|
| `@sw/core` | 数据模型（zod schema）、项目文件读写、外部档案只读解析、wiki 导入、格式与交叉引用校验 | §4 §9 §6-U1 | M0 |
| `@sw/core`（续） | 按时间取人物状态 `stateAt`、内容 hash 与 stale 依赖图 | §3.7 §4.6 §6-U8 | M1 / M3 |
| `@sw/llm` | provider 抽象、提示模板、结构化输出、多采样聚合、调用日志、record/replay | §3.2–3.6 §8 | M1 |
| `@sw/checks` | 偏差轴 A–F，每轴一个模块，统一报告格式 | §5 | M1–M3 |
| `@sw/ops` | 用例编排：候选快照、搭桥、反向提取、处置、重算、导出、收获 | §6 | M2–M3 |
| `@sw/cli` | 命令行入口 `sw` | §10 | M0 起 |
| `@sw/server` | 本地 HTTP API，复用 ops，监听文件变化 | §7 | M4 |
| `@sw/canvas` | 画布前端 | §7 | M4 |

M0 建了 `core` 和 `cli`；M1 加 `llm` 和 `checks`；M2 加 `ops`；其余包到对应里程碑再建，不留空壳。

## `@sw/core` 内部

| 文件 | 内容 | 规格 |
|---|---|---|
| `schema.ts` | 七类对象的 zod schema。自由文本字段一律 `string` / `string[]`；条目（Entry）可写成字符串或 `{text, id?, tag?, origin?, ...}` | §4 §12 |
| `entries.ts` | Entry 归一化与稳定 id 分配 | §4.1 |
| `frontmatter.ts` | Markdown + YAML frontmatter 的读写，保留源码位置用于报错行号 | §9 |
| `project.ts` | 加载整个项目文件夹 → 内存中的 `Project` | §4.7 §9 |
| `profile-ref.ts` | 外部档案引用（`*.ref.yaml`）：按映射解析外部 Markdown，只读 | §4.1 §6-U1 |
| `wiki-import.ts` | 把 wiki 人物页按小节映射为 Profile 字段 | §6-U1 §11 |
| `validate.ts` | 单文件 schema 校验 + 跨对象引用校验，输出 `{file, line, message}` | §10-M0 |
| `paths.ts` | 项目目录约定 | §9 |

## 项目文件夹约定

```
<project>/
  project.yaml               项目配置（§4.7）
  profiles/<id>.md           内嵌档案：frontmatter = 结构字段，正文 = arc_notes
  profiles/<id>.ref.yaml     外部档案引用：path + mapping + 可选 extra（项目内追加条目）
  snapshots/<任意名>.md      frontmatter = 结构字段，正文 = author_notes
  bridges/<任意名>.md        frontmatter = 结构字段，正文 = text
  bridges/.versions/<id>/    正文历史版本
  threads/<任意名>.md        frontmatter = 结构字段，正文 = description
  checks/**/*.yaml
  acceptances/*.yaml
  branches/                  落选候选（结构同 snapshots / bridges）
  llm-log/
```

文件名不承载语义，对象身份只看 frontmatter 里的 `id`；作者可以随意改文件名。

## 数据流（M0）

```
project.yaml ─┐
profiles/*.md ├─► loadProject() ─► Project ─► validateProject() ─► Issue[]
*.ref.yaml ───┤        │                                      
  └─► 外部 wiki 页（只读）─► wikiToProfile(mapping)
snapshots/ bridges/ threads/ checks/ acceptances/ ─┘
```

写入只发生在项目文件夹内；`core` 的写函数遇到项目外路径直接抛错（外部档案只读）。

## `@sw/llm`（M1）

| 文件 | 内容 | 规格 |
|---|---|---|
| `config.ts` | 读 `.env`（`GPTSAPI_*`，两种格式），规范化 Base URL | §8，D-023 |
| `gptsapi.ts` | 中转站客户端：`/models`、`/chat/completions`（非流式），出错时隐去密钥 | §8 |
| `recorder.ts` | record / replay 包装 | §8 §14.4，D-027 |
| `structured.ts` | 要求 JSON → zod 校验 → 最多 1 次修复 | §3.2，D-024 |
| `sample.ts` | 多采样、中位数、离散度置信度、代表样本 | §3.3，D-021 |
| `log.ts` | 项目内调用日志 | §3.5 |
| `template.ts` | Markdown 提示模板加载与渲染 | §8 |

## `@sw/checks`（M1）

| 文件 | 内容 | 规格 |
|---|---|---|
| `prompts/*.md` | 共用工作原则 + 各轴模板（中文，可直接改） | §3.1 §3.2 §3.6 §8 |
| `common.ts` | 结果结构、引文核对、饱和打分、阈值分级 | §5 共同输出，D-020 D-025 |
| `axis-a.ts` `axis-b.ts` `axis-c.ts` | 三个轴：结构化输出定义 + 从结构算分 | §5-A/B/C |
| `run.ts` | 场景文本 + 起点快照 → 涉及人物 → 三轴 | §10-M1 |
| `report.ts` | Markdown 报告：哪里 / 依据 / 本来应该 / 最便宜修补 | §5 |

## M2 新增

### `@sw/checks`

| 文件 | 内容 | 规格 |
|---|---|---|
| `state-items.ts` | 把快照状态拆成可寻址的条目（`tina.wants.1`、`world.2`），轴 D/F 共用 | §4.2 |
| `axis-d.ts` + `prompts/axis-d.md` | 到达偏差：模型逐个目标字段判对上/缺失/冲突，代码算"多出"和分数，输出逐字段 diff 表 | §5-D，D-036 |
| `axis-f.ts` | 间距：两快照逐字段比较，纯代码，不调用模型 | §5-F，D-035 |

### `@sw/ops`（用例编排）

| 文件 | 内容 | 规格 |
|---|---|---|
| `brief.ts` | 生成类提示的最小注入：两端快照 + 每个人物的核心/规则/人格/边界/公开事实/留白/此刻状态/已接受转折；`secret` 事实不注入；声音样本 | §3.4 §3.6 §6-U5，D-033 D-043 |
| `bridge.ts` | `outlineBridge` → 作者改 → `draftBridge`（旧正文进 versions）→ `checkBridge`（A/B/C + 提取 + D，结果写 checks/） | §6-U5，D-038 |
| `extract.ts` | 反向提取到达状态；输入类型里没有目标快照 | §5-D.1，D-037 |
| `candidates.ts` | 相邻两快照之间生成 2–4 个候选，写进 `branches/`；检查各维度是否区分开 | §6-U3，D-044 |
| `snapshots.ts` | 批准 / 嫁接候选，采纳到达状态为新目标，起草起点快照 | §6-U2 U3 U6，D-040 D-041 |
| `store.ts` | 检查结果落盘 | §4.5，D-038 |
| `prompts/*.md` | 生成用的工作原则与模板（大纲、正文、提取、候选、起点草稿） | §8 |

`@sw/cli` 的 M2 命令在 `packages/cli/src/m2.ts`。

## 数据流（M2）

```
快照 A ─┐                                    ┌─► checks/<桥>/A-*.yaml B C
快照 B ─┼─► outline ─(作者改)─► draft ─► 正文 ┼─► 提取（只给 A + 正文）─► derived_snapshot ─┐
档案  ──┘                                    │                                            ├─► 轴 D ─► checks/<桥>/D.yaml
                                              └────────────────────── 快照 B（目标）────────┘
相邻快照 ─► 轴 F（代码）─► 间距 ≥60 ─► candidates ─► branches/ ─► approve ─► snapshots/
```

## M3 新增

| 文件 | 内容 | 规格 |
|---|---|---|
| `checks/src/axis-e.ts` + `prompts/axis-e.md` | 伏笔偏差：线作为新事实，逐节点判矛盾 / 泄漏 / 是否兑现 | §5-E，D-045 |
| `core/src/hash.ts` | 内容 hash | §6-U8 |
| `ops/src/deps.ts` | 检查的依赖键与 hash、过期扫描 | §6-U8，D-046 |
| `ops/src/threads.ts` | 插线、埋点之后的节点、跑轴 E | §6-U7 |
| `ops/src/dispose.ts` | 接受（→ 增量）/ 撤销 / 忽略 / 已修好，写历史 | §6-U6，D-047 D-048 |
| `ops/src/rerun.ts` | 重跑计划（预计调用数）与执行 | §6-U8，D-049 |
| `ops/src/export.ts` | 稿件 / 报告 / 收获清单 | §6-U9，D-050 |
| `cli/src/m3.ts` | `thread` `status` `rerun` `accept` `revoke` `dismiss` `fixed` `export` | |

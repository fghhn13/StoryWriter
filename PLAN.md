# 故事生成器 · 搭建计划

> 依据：`F:\fghn_works\fghn's oc universe\experiments\story-engine-spec.md`（v0.1，下称"规格"）
> 本计划只做"怎么搭"。语义以规格为准；本计划里的技术选择开工后转写进 `DECISIONS.md`，疑问转写进 `QUESTIONS.md`。

---

## 1. 技术选型（提议，待写入 DECISIONS.md）

| 层 | 选择 | 理由 |
|---|---|---|
| 语言 | **TypeScript（Node 22，本机已装 v22.20）** | CLI、LLM 层、M4 画布可共用一套类型；不必在 M4 换栈。 |
| 包结构 | pnpm workspace 单仓：`core` / `llm` / `checks` / `cli` / `server` / `canvas` | 对应规格 §4–§9 的模块边界，画布最后接入。 |
| 文件格式 | Markdown + YAML frontmatter（`gray-matter` + `yaml`）；`project.yaml` 纯 YAML | 规格 §9：人类可读、git 友好、一个对象一个文件。 |
| 校验 | `zod` | 同一份 schema 既校验文件，又生成 LLM 结构化输出定义（规格 §8）。schema 保持宽松：字段多为 `string[]`（规格 §12）。 |
| LLM | `@anthropic-ai/sdk`，默认 `claude-opus-5-5`（可配 `claude-sonnet-5-5` 跑检查降本）；tool-use 方式取结构化输出 | 规格 §8 provider 抽象，默认 Claude 最新模型。 |
| CLI | `commander` | M0–M3 全部功能先走命令行。 |
| 测试 | `vitest` + 录制回放夹具 | 规格 §14.4：测试不打真实 API。 |
| 画布（M4） | Vite + React，本地 `server`（Hono）读写项目文件夹；泳道 / 时间轴用自绘 SVG | 规格 §7 要求的是"时间×泳道"的受限布局，不是自由连线，通用图库反而要处处去限制。 |

---

## 2. 仓库结构

```
StoryWriter/
  ARCHITECTURE.md  DECISIONS.md  QUESTIONS.md  PLAN.md
  packages/
    core/      数据模型、文件读写、状态时间索引、stale 依赖图      ← 规格 §4 §9 §3.7
    llm/       provider 抽象、提示模板、多采样聚合、调用日志、回放  ← 规格 §8 §3.2–3.5
    checks/    轴 A–F 实现，每轴一个模块                            ← 规格 §5
    ops/       用例编排：导入、候选、搭桥、处置、重算、导出         ← 规格 §6
    cli/       命令行入口
    server/    M4：本地 HTTP API（复用 ops）
    canvas/    M4：前端
  fixtures/
    minimal-project/   规格 §11 的最小夹具（Tina / 安可 / Villy / 第五个人）
    recordings/        录制的 LLM 输出
```

### 项目文件夹（规格 §9 落地）
```
<project>/
  project.yaml                 name, language, lanes, thresholds, sampling, llm, import_mappings
  profiles/<id>.md             内嵌档案；或 <id>.ref.yaml 指向外部路径（只读）
  snapshots/<t>-<id>.md        frontmatter = 结构字段，正文 = author_notes
  bridges/<from>__<to>.md      frontmatter = status/outline/injected，正文 = text；versions 存 bridges/.versions/
  threads/<id>.md
  checks/<target>/<axis>-<id>.yaml
  acceptances/<id>.yaml        {character, t, delta, check_id, justification}
  branches/                    pruned 候选
  llm-log/<date>/<call-id>.json
  harvest.md                   U9 收获清单（生成物）
```

---

## 3. 贯穿性机制（先于各轴实现）

1. **来源标记（§3.1）**：每个可由 LLM 产生的字段/条目带 `origin`（author / profile / llm），作者确认前 llm 条目在 CLI 与画布中都有显著标记。
2. **时间索引的人物状态（§3.7 / §4.6）**：`core.stateAt(character, t)` = 档案初始状态 + 所有 `t' < t` 的已批准快照 char_state + 已接受增量。所有检查只通过它取状态。
3. **多采样（§3.3）**：`llm.sampleStructured(task, input, n)` → 每个样本先给结构化中间结果，再由代码从结构计算分数（不让模型吐数）；聚合取中位数，置信度 = f(样本方差, 档案完整度)，无 heuristics 时上限 0.3。
4. **最小注入 + 留白禁填（§3.4 / §3.6）**：每个模板的上下文由 `buildInjection(targets)` 统一组装，固定包含：优先级原则、涉及人物 unknowns 列表 + 禁填指令、先结构后分数指令。注入内容摘要写入 `bridge.injected` 和调用日志。
5. **调用日志与回放（§3.5 / §8）**：日志键 = hash(模板版本 + 输入)；`LLM_MODE=replay` 时从 `fixtures/recordings` 读，缺失即测试失败；`record` 模式打真实 API 并落盘。
6. **stale 依赖图（§6 U8）**：检查记录其输入对象的内容 hash；任何文件 hash 变化 → 依赖它的检查标 stale。作者手改文件也能被发现（启动或 `sw status` 时扫描）。

---

## 4. 里程碑拆解

每个里程碑一个 PR，PR 描述逐条对照规格 §10 验收标准。

### M0 · 骨架
- [ ] 初始化 git、pnpm workspace、tsconfig、vitest、lint
- [ ] 写 `ARCHITECTURE.md`（模块 ↔ 规格章节映射）、`QUESTIONS.md`、`DECISIONS.md`
- [ ] `core`：Profile / Snapshot / Bridge / Thread / Check / Acceptance / Project 的 zod schema 与读写
- [ ] 外部档案引用：`.ref.yaml` 指向外部 Markdown，按 `import_mappings` 解析，**只读**（写操作对外部路径直接报错）
- [ ] wiki 导入器（U1）：按小节标题前缀映射——实测 wiki 的标题带后缀（如"写作指南（源：Tina Bible §ⅩⅩⅩ）""核心人格（就现有文档所见）"），所以按前缀匹配；行内〔已定/暂定/留白/推演/Agent 建议〕标签保留为条目属性
- [ ] 快照 status 规则：只有 approved/locked 能作桥端点
- [ ] CLI：`sw init`、`sw list <kind>`、`sw validate`、`sw show <id>`、`sw import <wiki-page> --mapping <name>`
- [ ] 手写 `fixtures/minimal-project`：Tina、安可两份档案，"第五个人"起止两个快照，一座空桥
- **验收**：`sw validate fixtures/minimal-project` 通过；故意写坏一个字段能报出文件与行。

### M1 · 人物校验器（轴 A + B + C）
- [ ] `llm`：provider、模板加载、tool-use 结构化输出、多采样聚合、日志、record/replay
- [ ] 轴 A：heuristic 逐问回答 → 行为/台词枚举 → 行为×问题方向判定（附原文）→ boundaries 单判 → 代码算分；接受的增量作为"已建立转折"注入
- [ ] 轴 B：前提枚举 → 对照起点状态（真/假/未提及）→ 按类别加权（知识泄漏 > 时空 > 物品/关系）
- [ ] 轴 C：逐条 unknown 判 明示/强暗示/无 → 承重加权；"永久留白"填即 100
- [ ] 共同报告格式：哪里 / 依据哪条规则 / 本来应该怎样 / 改哪句最便宜
- [ ] CLI：`sw check <scene.md> --profiles tina,ancore --from <snapshot>` 输出 Markdown 报告
- [ ] 准备验收用场景文本：按约束写的 Tina 场景 + 两处植入逆向行为；植入安可知晓身世的台词
- [ ] 中文模板在真实 API 上调通后录制夹具
- **验收**（规格 §10 M1）：①抓到 Tina 两处逆向并引原文；②轴 C 报明示填留白；③安可轴 A 标"无决策规则，置信度受限"；④同输入跑 3 次分数波动 ±10 内（此项需真实 API 跑，结果附在 PR 里，CI 用回放）。

### M2 · 快照与桥闭环（轴 D + F + 候选）
- [x] 搭桥（U5）：先 outline → 作者可改 → text；注入两端快照、heuristics/boundaries/unknowns、已接受增量、可选声音样本（无样本时报告提示）
- [x] 反向提取 derived_snapshot：**提示中不出现目标快照**（规格 §5 D.1），代码层面保证该输入不可达
- [x] 轴 D：逐字段 diff（冲突 > 缺失 > 多出），多出进收获；"采纳为新目标"操作
- [x] 轴 F：两快照字段 diff 加权 → 间距值；≥60 建议加点
- [x] 候选快照（U3）：给定维度生成 2–4 个，附带会触碰的留白；落选进 `branches/` 标 pruned，可嫁接
- [x] 起点快照草稿（U2）：从 hard_facts + 开场设定生成，origin = llm-candidate
- [x] 桥生成后自动跑 A/B/C/D；桥正文重写保留 versions
- [x] CLI：`sw bridge outline|draft`、`sw extract`、`sw gap`、`sw candidates --dims "谁推动,冲突在哪"`、`sw approve`
- **验收**：轴 D 逐字段对得上；改目标快照一个 wants 后 diff 反映该字段；3 个候选在指定维度上可区分。

### M3 · 伏笔与过期重算（轴 E + stale）
- [x] Thread 读写；轴 E：线内容作为新增事实对埋点后各节点重跑轴 B；visibility 泄漏检查；未收单独显示
- [x] 处置（U6）：修桥 / 改快照 / 接受（写理由 → 生成 acceptance 增量）/ 忽略；全部记入对象历史
- [x] stale 传播：档案、快照、桥、接受改动 → 下游检查 stale
- [x] `sw rerun --stale`：先给出预估调用次数与成本，确认后执行
- [x] 导出（U9）：稿件（locked 桥按 t 拼接）、open 检查报告、收获清单（不自动回写档案）
- **验收**：t=1 插一条与 t=3 矛盾的线，轴 E 标出 t=3；改档案一条 hard_fact，下游检查全变 stale，一键重跑。

### M4 · 画布
- [ ] `server`：把 `ops` 暴露成本地 API，监听文件变化（作者在编辑器里改文件，画布实时更新）
- [ ] 画布：横轴 t、泳道（可拖动排序，含"世界"泳道）、快照节点跨泳道、桥边、伏笔细线、间距着色 + "加点"按钮
- [ ] 侧栏：对象字段 + 检查列表，展开证据，直接处置
- [ ] 操作：加点、生成候选、搭桥、插伏笔、接受偏差、重跑 stale、导出
- [ ] LLM 产物在界面上有未确认标记
- **验收**：不碰文件，只用界面走完 U2–U7。

---

## 5. 开工前需作者回答（转入 QUESTIONS.md）

### 阻塞
1. **测试数据路径**：规格 §11 说路径在 QUESTIONS.md 给出。我看到 `F:\fghn_works\fghn's oc universe\wiki\characters\` 下有人物页，是否就用它？导入时工具对这个目录只读。
2. **导入映射细节**：wiki 里同时有"推演说明"小节和行内〔推演〕〔Agent 建议〕标签。这些条目是否导入？如果导入，算不算锚点？（建议：导入但标 `origin=llm`，不作为轴 A 锚点。）
3. **API 与预算**：用哪个 Anthropic API key / 每个里程碑的调用成本上限？默认模型用 Opus，还是检查类任务用 Sonnet？
4. **代码仓库位置**：工具代码放 `F:\ai\StoryWriter`，测试项目文件夹放哪？是否允许在 `experiments/` 下建一个项目？

### 不阻塞（先按默认做，记入 DECISIONS.md）
- 规格 §13 的五个开放问题：默认单时间线、t 用整数序号、阈值用规格默认值且暂不按人物设置、声音样本项目级一份、接受即应用（但可撤销）。
- 代码注释与提交信息用英文，文档与提示模板用中文。
- 轴 A/B/D 里的权重先用常量写在 `project.yaml` 的 `weights`，方便作者调。

---

## 6. 风险与对策

| 风险 | 对策 |
|---|---|
| M1 验收④（±10 波动）不稳 | 分数由代码从结构计算而不是模型给；温度固定；采样数提高到 5 做对照；把方差大的条目列入报告。 |
| 反向提取"对齐作弊" | 提取任务的输入类型里根本没有目标快照字段，从类型层面隔离。 |
| 中文长文本上下文成本高 | 严格最小注入；检查类任务可降到 Sonnet；`rerun` 前给成本预估。 |
| 作者手改文件导致状态不一致 | 以文件为唯一真相，内容 hash 驱动 stale；`sw validate` 随时可跑。 |
| schema 越做越严 | 规格 §12 明确禁止；zod schema 里自由文本字段一律 `string` / `string[]`，评审时专门检查。 |

---

## 7. 第一步

确认本计划和 §5 的阻塞问题后，从 M0 开始：初始化仓库 → 写 ARCHITECTURE / QUESTIONS / DECISIONS → 落数据模型和最小夹具。

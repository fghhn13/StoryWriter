# StoryWriter · 故事生成器

需求：`F:\fghn_works\fghn's oc universe\experiments\story-engine-spec.md`。计划见 [PLAN.md](PLAN.md)，模块见 [ARCHITECTURE.md](ARCHITECTURE.md)。

当前进度：**M0 骨架**完成；**M1 人物校验器**（轴 A 人物、B 连续性、C 留白）验收通过，见 `reports/m1-*.md`。

```bash
npm install
npm test
npm run sw -- -p fixtures/minimal-project validate
npm run sw -- -p fixtures/minimal-project list snapshots
npm run sw -- -p fixtures/minimal-project show tina
npm run sw -- init my-project --mapping oc-wiki
npm run sw -- -p my-project import "<wiki>/characters/tina.md"   # 只读引用；加 --copy 复制成可编辑档案
```

## 画布（M4）

```bash
npm run sw -- -p <项目> serve            # 打开 http://127.0.0.1:4173
```

横轴是故事时间，纵向是泳道。点快照、桥、伏笔线、间距区域，在右侧栏看字段、检查和操作；所有操作（起点草稿、手写快照、加点、搭桥、大纲 / 正文、检查、接受 / 忽略、插伏笔、重跑过期、导出）都能在界面里做。在编辑器里改文件，画布会自动刷新。

## M2：搭桥与加点

```bash
npm run sw -- -p <项目> gap --detail                    # 轴 F 间距（不调用模型）
npm run sw -- -p <项目> bridge outline <桥>              # 大纲写进桥文件，可以手改
npm run sw -- -p <项目> bridge draft <桥> --out r.md     # 写正文，然后跑轴 A/B/C/D
npm run sw -- -p <项目> bridge check <桥> --axes D       # 只重跑某些轴
npm run sw -- -p <项目> adopt <桥>                       # 桥比计划好：到达状态采纳为终点快照
npm run sw -- -p <项目> candidates <快照1> <快照2> --dims "谁推动,冲突在哪" -k 3
npm run sw -- -p <项目> approve <候选 id>                # 其余候选标 pruned；sw graft 可嫁接回来
npm run sw -- -p <项目> start-draft s0 --opening @opening.md
```

已定事实写成 `{ text: …, secret: true }` 表示"作者知道、人物不知道"：生成时不告诉模型，检查时照常用。`project.yaml` 里写 `voice_sample: voice.md` 可提供声音样本。

## M3：伏笔、处置、重算、导出

```bash
npm run sw -- -p <项目> thread add th-key --planted s-registered --desc "…" --visibility character --known-by tina   # 插线并跑轴 E
npm run sw -- -p <项目> status                       # 扫描过期检查（档案、快照、桥、接受改过之后）
npm run sw -- -p <项目> rerun --stale                # 先看计划和预计调用次数；加 --yes 执行
npm run sw -- -p <项目> accept <检查> --why "…" [--delta "…"]   # 接受偏差 → 状态增量；sw revoke 撤销
npm run sw -- -p <项目> dismiss <检查> --why "…"
npm run sw -- -p <项目> export manuscript|report|harvest --out x.md
```

夹具 `fixtures/m3-project`：四个快照、三座已定稿的桥。

## LLM（GPTsAPI 中转站）

复制 `.env.example` 为 `.env`，填 `GPTSAPI_API_KEY`。Base URL 用 `https://api2.gptsapi.net/v1`（`api.gptsapi.net` 从本机连不上）。

```bash
npm run sw -- llm models          # 不计费
npm run sw -- llm smoke           # 计费，16 token
npm run sw -- -p fixtures/minimal-project check fixtures/minimal-project/scenes/fifth-person.planted.md
```

`SW_LLM_MODE=record` 打真实接口并把输出录进 `--recordings` 目录；`replay` 只读录制（测试用这个，不花钱）。每次调用记录在项目的 `llm-log/` 下。提示模板在 `packages/checks/prompts/`，是可以直接改的 Markdown。

夹具：
- `fixtures/minimal-project` — 规格 §11 的最小夹具，不依赖外部文件。
- `fixtures/wiki-project` — 只读引用作者 wiki 的五个人物；只在有该 wiki 的机器上能校验通过。

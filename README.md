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

# M4 画布 · 验收准备

规格 §10 M4 的验收是"不看文件，只用界面完成 U2 到 U7 全流程"，需要作者本人在界面上走一遍。下面是我已经验证过的部分。

## 已验证

- `packages/server/test/server.test.ts`：只通过 HTTP 接口（画布用的同一套）从空项目走完 U2 → U9：起点草稿 → 确认 → 批准 → 手写终点 → 生成候选 → 批准候选 → 搭桥 → 生成大纲 → 手改大纲 → 写正文并自动跑 A/B/C/D → 接受偏差 → 忽略 → 插伏笔并跑轴 E → 手改正文 → 过期 → 重跑 → 定稿 → 导出稿件。结束时项目校验无错误。另测了 YAML 编辑、泳道排序、错误提示、编辑器改文件时画布收到推送。
- 用无头 Chrome 驱动真实界面（假模型、不计费）点完同一流程，没有前端报错。截图：
  - `m4/candidates.png`：间距面板与三个候选
  - `m4/bridge-panel.png`：桥的大纲 / 正文 / 检查侧栏，伏笔线，模型产物标记
  - `m4/thread-and-evidence.png`：M3 夹具上伏笔高亮 t=3，侧栏展开证据
  - `m4/export-harvest.png`：导出收获清单

## 作者验收步骤（建议）

```bash
npm run sw -- init my-test --mapping oc-wiki
# 复制 fixtures/minimal-project/profiles 和 project.yaml 的 lanes 进去，或用 import 引用 wiki
npm run sw -- -p my-test serve
```

然后只在浏览器里：起点草稿 → 批准 → 手写终点快照 → 间距"加点"生成候选 → 批准一个 → "＋搭桥" → 生成大纲、改、写正文 → 处理检查（接受 / 忽略） → 插伏笔 → 重跑过期 → 导出。真实模型下一轮大约 30–40 次调用。

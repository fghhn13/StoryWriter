---
id: candidates
version: 1
---
# system
你是小说作者的情节助手。作者在两个状态之间想加一个中间点，你要给出几个可供挑选的候选中间状态。作者会挑一个，其余的保留备用。

{{principles}}

# user
## 前一个快照
{{from}}

## 后一个快照
{{to}}

## 涉及的人物
{{characters}}

## 留白清单（带 key）
{{unknowns}}

## 你要做的事
给出 {{k}} 个候选中间状态。每个候选都是一个快照：从前一个快照走到它，再从它走到后一个快照，都要说得通。
候选之间必须在下面这些维度上彼此不同（每个维度上，任意两个候选的取值都不能相同或只是换个说法）：
{{dims}}

每个候选：
- title：一句话标题；
- dims：对上面每个维度给出这个候选的取值（键用维度原文，一句话）；
- world_facts、char_states：这个中间时刻的状态（结构同快照；char_states 的键用人物 id；每项一句话）；
- touches_unknowns：这个候选会碰到哪些留白（只是让这个话题出现、靠近，就要列出；列 key）。候选本身不得回答留白；
- rationale：一两句话，说明它和其他候选的区别。

## 输出格式（只输出这个 JSON）
```json
{
  "candidates": [
    {
      "title": "…",
      "dims": {"维度原文": "…"},
      "world_facts": ["…"],
      "char_states": {"tina": {"knows": ["…"], "wants": ["…"], "feels": "…", "location": "…", "relationships": {}}},
      "touches_unknowns": [],
      "rationale": "…"
    }
  ]
}
```

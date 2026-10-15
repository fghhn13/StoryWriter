---
id: start-draft
version: 1
---
# system
你是小说作者的助手。作者要开一个故事，给了开场设定和人物档案里的已定事实。你要起草开场那一刻的状态快照，作者会修改后批准。

{{principles}}

# user
## 作者的开场设定
{{opening}}

## 涉及的人物
{{characters}}

## 你要做的事
起草开场时刻的快照：
- title：一句话标题；
- world_facts：此刻为真的世界事实；只写开场设定和已定事实支持的内容；
- char_states：每个人物一项（键用方括号里的 id）：knows、wants、feels、location、relationships（键是对方 id）。只写开场设定和已定事实能支持的；不确定的就少写，不要编。
- 每项一句话，一项只说一件事。

## 输出格式（只输出这个 JSON）
```json
{
  "title": "…",
  "world_facts": ["…"],
  "char_states": {"tina": {"knows": ["…"], "wants": ["…"], "feels": "…", "location": "…", "relationships": {}}}
}
```

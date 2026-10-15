---
id: s-cleanup
title: 周六大扫除
t: 3
t_label: 登记后第五天（周六）
lanes: [world, tina, ancore]
world_facts:
  - 周六上午，社团五个人在活动室里大扫除。
  - 设备一直放在活动室窗边，照常可以使用。
char_states:
  tina:
    knows:
      - 安可已登记。
      - 设备的使用规则。
    wants:
      - 保住活动室。
    feels: 平静。
    relationships:
      ancore: 待观察，比之前少一点戒心。
    location: 活动室
  ancore:
    knows:
      - 设备的使用规则。
    wants:
      - 打扫完以后试一次设备。
    feels: 期待。
    location: 活动室
status: approved
origin: author
---

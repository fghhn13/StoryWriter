---
id: s-library
title: 去图书馆找说明书
t: 2
t_label: 登记后第二天
lanes: [world, tina, ancore]
world_facts:
  - 设备的旧说明书收在学院图书馆的期刊室。
char_states:
  tina:
    knows:
      - 安可已登记。
      - 设备说明书在图书馆期刊室。
    wants:
      - 保住活动室。
      - 让新成员弄清设备的使用规则。
    feels: 平静，事务性。
    relationships:
      ancore: 待观察。
    location: 学院图书馆
  ancore:
    knows:
      - 社团可以进入虚拟世界、体验另一种人生。
      - 设备有一本旧说明书。
    wants:
      - 亲自体验另一种人生。
    feels: 好奇，有点不耐烦。
    location: 学院图书馆
status: approved
origin: author
---

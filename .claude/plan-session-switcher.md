# 会话列表：序号 + 快速切换

## 背景（实测数据）

- **35 个活跃会话**（30 Claude + 3 Codex + 2 Grok），另有 35 个已关闭
- 侧栏 280px，每项约 70px → **一屏只放得下 8~9 个**，找一个会话要滚 4 屏
- 列表是 `sessions.map` 裸平铺：无序号、无搜索、无排序
- **全局快捷键一个都没有**（`App.jsx` 里只有终端内复制那一处按键处理）

## 一处需要修正的前提

我最初说"14 个会话显示 `session-178…` 无法辨认"——**这条不成立，已撤回**。
`App.jsx:1443` 已经是 `session.projectName || session.name`，而 `projectName`
全都有值。实测 35 个会话**没有一个**显示自动名：

```
AIPsychology / AetherEDA / AgentCDSem / … / cadance / mathviz / phyviz / zt-monitor
```

所以你选的第 4 项「自动名显示项目目录名」**已经是现状**，本次不需要做。
唯一的辨识问题是一组重名：`RustCandance` 有 codex 和 claude 两个会话。

## 真实痛点

名字都清晰，问题纯粹是**数量**：34 个可辨认的名字堆在一起，一屏放不下，只能滚。

## 方案（按你的选择）

序号固定 + 显示顺序可切换；保持现有密度；做 4 项中的 3 项（第 4 项已实现）。

### ① 稳定序号

**排序键用 `created_at`** —— 实测 35 个会话全部唯一、无空值，可直接当稳定序号依据，
**不需要加数据库字段**。

顺带修一个真问题：`SessionManager.listSessions()` 返回的是 **Map 插入顺序**，
而恢复查询 `SELECT * FROM sessions WHERE status = ?`（`SessionManager.js:1272`）
**没有 ORDER BY**。所以当前列表顺序取决于加载顺序、重启后可能变。
序号要稳定，这里必须补 `ORDER BY created_at`。

序号语义是**门牌号**：钉在会话上，切换显示顺序时跟着会话走，不重排。
置顶的会话排到最前但**保留自己的门牌号**（你选的"两者并存"）。

### ② ⌘1~⌘9 直达

只覆盖门牌号 1~9（一屏刚好 8~9 个，自洽）。其余 26 个靠 ⌘K 和 ⌘↓ 到达。

**关键约束**：xterm 装了 `attachCustomKeyEventHandler`（`App.jsx:984`），
终端聚焦时按键**先过它**。⌘K / ⌘数字 / ⌘↓ 必须在那里 `return true` 放行，
否则会被当作终端输入发给 CLI。这是最容易出错的一处。

Windows/Linux 用 `Ctrl` 对应（`e.metaKey || e.ctrlKey`）。

### ③ ⌘K 模糊搜索

- 匹配**会话名 + 项目名 + 工作目录**（目录能救重名的 RustCandance）
- 输入即过滤，`↑↓` 选，`Enter` 进，`Esc` 关
- 结果行显示门牌号，边搜边记住号码
- 子序列匹配（`wtx` 能命中 `WebTmux`），不是纯 `includes`

### ④ 待处理优先 + ⌘↓ 循环

- 侧栏顶部固定一条摘要：`⚠ 3 个等确认`，点击跳第一个
- `⌘↓` 依次循环所有 `needsAction && !autoActionEnabled` 的会话
- 判据复用现成的 `aiStatusMap[id].needsAction`（`App.jsx:1437` 已在用）
- 没有待处理时这条不显示，不占空间

### ⑤ 置顶（支撑"序号固定"）

右键菜单加「置顶 / 取消置顶」——菜单已存在（`App.jsx:2769`，现有"开启自动操作"
和"关闭会话"两项），加一项即可。

置顶列表存 **localStorage**（`sessions` 本来就从 localStorage 缓存初始化，
同一套机制），不动数据库。

## 改动清单

| 文件 | 改动 |
|---|---|
| `server/services/SessionManager.js` | 恢复查询补 `ORDER BY created_at`（修顺序不稳定） |
| `src/App.jsx` | 序号计算 + 全局快捷键监听 + ⌘K 搜索面板 + 待处理摘要 + 右键置顶项 |
| `src/index.css` | 序号徽章、搜索面板、摘要条样式 |
| `tests/test-session-switcher.mjs` | 新建：排序稳定性、子序列匹配、门牌号不随排序变 |

前端改动集中在 `App.jsx`，按 CLAUDE.md 约定分次编辑（每次 ≤100 行）。

## 验证方式

1. **序号稳定**：重启服务后门牌号不变；切到"最近活跃"排序后号码跟着会话走
2. **快捷键不串到终端**：终端里正常打字，⌘K/⌘数字 不会把字符发给 CLI
3. **搜索命中**：`rust` 能同时列出两个 RustCandance 并按目录区分；`wtx` 命中 WebTmux
4. **待处理**：制造一个待确认会话，摘要计数正确、⌘↓ 能跳到它
5. `npm test` 29→30 个文件全过

## 不做的

- 不改列表密度（你选了保持现有）
- 不做分组折叠
- 不动自动名显示逻辑（已是现状）

# 自动上下文管理 —— 对齐 Auto Memory 手册的三步闭环

## 背景
手册 `auto_memory_presentation.html` 的核心主线是一个跨压缩闭环：
**①收尾写记忆 → ②带目标 /compact → ③新上下文先读 MEMORY.md 再续**。
判据一句话：「删掉它之后，下一步是否仍能准确继续？」

现状（contextWaterline.js，v1.2.96）只做了第①步的一半：到线发一次收尾指令，
之后被动等 Claude 自己 auto-compact，压缩后也不引导重读 MEMORY.md。

用户决策：**补全三步闭环** + **收尾确认写完后才自动 /compact**。

## 设计：把布尔标记升级成阶段状态机

现在 `session._waterlineHandedOff`(bool) → 改为 `session._waterlinePhase`：
`idle | handoff_sent | compact_sent | resumed`

阶段流转（每轮监控在"本该发继续（空闲）"时推进一格，运行中/确认框中一律不碰）：

| 当前阶段 | 触发条件 | 动作 | 转入 |
|---|---|---|---|
| idle | 水位≥88% 且空闲 | 发 HANDOFF_PROMPT（收尾七项，文本两阶段发送） | handoff_sent |
| handoff_sent | 屏幕出现"记忆写完"信号 且空闲 | 发 `/compact <带目标>`（slash，send-keys+Enter） | compact_sent |
| compact_sent | 压缩结束（isCompacting 由真→假）且空闲 | 发 RESUME_PROMPT（先读 MEMORY.md 定位主题再续） | resumed |
| resumed | 水位回落 <80%（压缩生效） | 重置 | idle |

**"记忆写完"信号**：handoff 发出后，会话会去写文件再回到空闲。判据取
`getLastClaudeReply()` 里出现写记忆完成的措辞（已更新/已写入/记忆/MEMORY.md/写完）
**或** 距 handoff 发出已过 N 轮兜底（防止 CLI 措辞不匹配卡死，对齐熔断的兜底思路）。
拿不准就宁可多等一轮，不抢跑 compact（用户选的"确认后才 compact"）。

## 改动点

1. **contextWaterline.js**（纯逻辑，配单测）
   - 新增 `RESUME_PROMPT`（对齐手册"新对话开始"段：先读 MEMORY.md 索引→读相关子文件
     →两三句报进度/决定/下一步→再续；无记录就明说"没有记录"不猜）。
   - 强化 `HANDOFF_PROMPT` 到手册收尾七项（进度/结论/决定/原因/失败方案/关键文件/下一步）。
   - 新增 `COMPACT_COMMAND`（`/compact` + 手册的带目标压缩语：只留目标/已完成未完成/
     已改文件/关键决定及原因/失败方案及证据/测试/风险/下一步验证计划）。
   - 把 `decideWaterlineAction` 从"单发收尾"改为**阶段推进纯函数** `decideWaterlinePhase({
     usedPercent, isIdle, phase, memoryWritten, isCompacting, roundsSincePhase })`
     → 返回 `{ level:'none'|'warn'|'handoff'|'compact'|'resume', nextPhase, reason }`。
   - 保留 off/warn/auto 三态与阈值（80/88）不变；warn 模式全程只告警不按键。

2. **server/index.js** 接入点（4605-4647 那段）
   - 用 `session._waterlinePhase` 驱动状态机；三种动作分派：
     - handoff / resume → 改写 `preResult.suggestedAction`，走既有文本两阶段发送路径。
     - compact → **不能走文本路径**（斜杠命令），比照 `/quit`（4310）用
       `send-keys "/compact …"` + 延迟 Enter 直发；发完置 compact_sent，本轮不再走继续。
   - `memoryWritten` 由 `getLastClaudeReply()` + 轮数兜底算出，传入决策函数。
   - `isCompacting` 复用 AIEngine 已有判据（Evaporat/Compact/Summariz/Churning + 计时器）。
   - 前端 `ai:waterline` 事件加 `phase` 字段，右栏能显示"收尾中/压缩中/已恢复"。

3. **末端保护复用**：所有发送仍走既有 isRunning/esc-to-interrupt 拦截，运行中不打断。
   compact 直发前也要再确认 isIdle（!isRunning），避免压到正在跑的任务上。

## 风险与边界
- 只对能读到水位的 Claude CLI 生效；Codex/Grok 读不到百分比 → 全程 none，不动。
- compact 是 Claude 会话级操作、较重：仅在"收尾确认写完 + 空闲"双条件下发，且阶段机
  保证一个压缩周期只发一次。warn 模式用户可完全禁用自动 compact。
- 兜底：任一阶段卡住超时（如 memoryWritten 一直判不出）→ 记 warn 告警，交还用户，不硬推。

## 验证
- contextWaterline 单测扩展：覆盖四阶段流转 + off/warn 封顶 + 水位回落重置 + 兜底超时。
- `node --check` + 重启本机监控服务观察日志，确认 handoff→compact→resume 顺序正确、
  不误触发（尤其运行中不碰）。
- 升版本 1.2.96 → 1.2.97（改核心监控逻辑，按规则必须升）。
- 更新记忆 context-waterline-handoff.md 记录三步闭环落地。

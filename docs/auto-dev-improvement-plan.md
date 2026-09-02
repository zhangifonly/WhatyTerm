# 自动开发改进规划：Loop Engineering × Graph Engineering

> 2026-09-02 调研产出。三路输入：本仓库自动化机制摸底（AIEngine 监控 + Ralph 自主模式 + HookServer）、
> Loop Engineering 外部调研、Graph Engineering 外部调研。本文档是改进路线图，按 P0→P3 排期。

> **落地进度（2026-09-02）**：
> - ✅ P0-1 确认菜单验活闸（v1.2.81，liveMenu.js，验收=台账空转率归零，观察中）
> - ✅ P0-2 清理 85 个死 prompt md + 测试退出码修真（v1.2.82）
> - ✅ P1 全部（v1.2.83）：硬验证 validationCommands / 失败历史回灌 / 相同失败早熔断 /
>   开发失败计 retry / 连续5轮全局熔断 / ralph-rounds.jsonl 台账 + 输出留档 / commit 证据 /
>   开场定位仪式 / 禁删测试强措辞 / aiOperationStats 持久化
> - ✅ P2 条目 8/9/11（v1.2.84）：DISCOVERED 入图（谱系/去重/队尾）/ 失败≥2 拆小重规划
>   （parent-child 链式依赖，子任务不再拆）/ expandGoal 接通归档（patterns 跨轮保留）；
>   条目 10 由"仅失败时升级拓扑"隐式满足；条目 12（worktree 并行）仍未做
> - ✅ P3 条目 14/15/16（v1.2.85/86）：hook 载荷（tool/file）注入 AI 判定 prompt +
>   hook 日志 512KB 轮转 / Ralph 上下文加轻量仓库地图（目录树+scripts，5min 缓存）/
>   npm test 统一入口（tests/run-all.mjs）
> - ✅ 计划外重大修复（v1.2.87）：自动化输入静默丢失——session.write 依赖的
>   tmux attach 客户端半死时 pty.write 丢键（实测某会话回车 4 连丢、卡 10 小时）。
>   监控/Ralph 程序化输入全部改走 sendInput/sendNamedKey（send-keys 直达 server）
> - ⬜ 有意缓做（数据触发）：
>   * P2-12 worktree 并行：等 ralph-rounds.jsonl 显示「同时可跑任务 ≥2」高频出现再做
>     （典型计划是依赖链，第二车道多数时间空转；Co-Coder：盲并行会亏）
>   * P3-13 preAnalyzeStatus 数据化：回归风险最高，等 v1.2.81/87 后的新台账
>     积累几天、确认两类空转归零后单独立项
> - 测试：test-ralph-loop.mjs 17 条、test-live-confirm-menu.mjs 10 条、test-send-input.mjs 4 条

## 0. 一页结论

- **Loop Engineering**（Huntley 2025-07 Ralph 循环 → Addy Osmani 2026-06 命名）公认支柱：
  **每轮全新上下文 × 状态外置到文件/git × 每轮一小事 × 独立可执行验证 × 可判定停止条件 × 熔断兜底**。
- **Graph Engineering**（2026-07 Steinberger/Hamel Husain 引爆）：把多个循环接成显式图——
  节点=专门化 agent/步骤，边=路由（分支/并行/回环），加验证器节点、检查点、人审与停止条件。
  行业落地样板是 Yegge 的 Beads（git 内依赖图任务库）+ Gas Town（多 agent 编排）。
- **我们的位置**：Ralph 已具备正典循环的骨架（headless 每任务新上下文、progress.json 状态外置、
  单任务推进、依赖字段 dependsOn、patterns 学习），监控侧 ActionOutcome 台账是全系统最好的反馈闭环。
  **但循环的"验证/停止/回灌/归档"四个环节全是短板**，图结构只有一层且拆完定死。
- **最优先的事不是引概念，是修数据已经指着的失效**：确认菜单自动按键空转率 99.5%~100%（625 次纯烧成本）。

## 1. 现状对照：正典原则 vs 我们

| 正典原则 | 我们现状 | 差距 |
|---|---|---|
| 每轮全新上下文 | ✅ Ralph headless 每任务新会话 | 无 |
| 状态外置（JSON 优于 md） | ✅ progress.json 原子写 | patterns 只增不减无上限；无版本历史 |
| 每轮一小事 | ✅ getNextTask 单任务推进 | 任务拆完定死，无重拆 |
| 独立可执行验证（硬验证优先） | ❌ Validator=LLM + `VALIDATION: PASS` 正则 | 验收命令应由编排器自己跑 |
| 双条件退出 / 完成暗号 | ❌ 单正则判 PASS，可被正文复述误触 | 无 |
| 失败信息回灌下一次尝试 | ❌ validationNotes 不进 Developer prompt | 5 次重试=原样重做，信息增益≈0 |
| 轮末干净收尾（commit+冒烟） | ❌ 无每任务 commit、无开场定位仪式 | 无 |
| 熔断/费用上限 | ⚠️ 监控侧有（继续熔断+空转熔断）；Ralph 侧只有 maxIterations | 超时不计 retry 可静默死循环 |
| 结构化轮次台账 | ⚠️ 监控侧 ActionOutcome ✅；Ralph 侧几乎为零 | 输出被 unlink，答不上"哪个任务为何失败" |
| 任务依赖图 + 运行中发现新任务 | ⚠️ 一层 dependsOn，无 discovered-from | 无重规划、无并行 |
| 归档→多轮循环 | ❌ archiveRound 零调用（死代码） | 闭环断裂 |
| 独立评审节点 | ❌ EvaluatorService.evaluate 零调用（死代码） | — |

## 2. 改进路线

### P0 修失效与清死码（先做，1~2 天量级）

1. **确认菜单按键重做**：台账实测 `Claude Code确认界面` 414 次/空转 99.5%、`自动选择选项 1`
   211 次/空转 100%——方向键+Enter 的 `execSync tmux send-keys` 路径基本没被 Ink 收到。
   重做发送方式（逐键、键间延迟、send-keys 参数核对），修完用 ActionOutcome 台账验证空转率归零。
   Codex 侧 81.5% 有效可作对照参考。
2. **死代码处置**：`archiveRound`（P2 接通）、`EvaluatorService.evaluate`（并入 P1 验证节点或删）、
   17×5≈85 个从未拼进 prompt 的 `MonitorPlugins/prompts/*.md`（接通或删，不许继续躺着）。

### P1 把 Ralph 循环补成正典循环（Loop Engineering 落地，核心投入）

3. **硬验证门禁**：拆分时要求每个任务给出可执行的 `validationCommands`（编译/测试/lint/冒烟），
   由 RalphEngine 编排器自己跑、不经 agent 之手（ralphex 模式）。LLM Validator 降级为软验证，
   PASS 判定改双条件：命令全绿 + 显式完成暗号（frankbria 双条件退出门）。禁删测试写进 prompt 强措辞。
4. **失败回灌**：validationNotes 改为只追加历史；重试时把上次失败原因 + `git diff` 摘要
   注入 Developer prompt；Validator 上下文加 git diff/log（现在与 Developer 逐字相同，等于盲验）。
5. **轮末收尾 + 开场仪式**：每任务完成自动 commit；每轮开场固定注入 进度摘要+git log 尾部+冒烟结果
   （Anthropic harness 文的"定位仪式"）；先修坏状态再做新任务。
6. **停止与熔断升级**：超时计入 retryCount（堵静默死循环）；重试按"有无信息增益"熔断
   （连续两次产出 diff 为空/哈希不变即停，VRR-Stop 思想：报告通过率上升≠真实正确率上升）；
   maxIterations 之外加 token/费用预算上限。
7. **Ralph 轮次台账**：仿 ActionOutcome 落 JSONL——每轮记 task/耗时/tokens/outcome/失败原因/重试序号；
   Developer/Validator 输出归档到会话目录而非 unlink。配套把 `aiOperationStats` 持久化。

### P2 任务图升级（Graph Engineering 落地）

8. **progress.json → 任务图（Beads 模式）**：依赖类型扩展为 blocks / parent-child / discovered-from；
   允许 Developer 运行中上报新发现任务入图（`DISCOVERED: xxx` 标记，类似现有 PATTERN 抓取）；
   任务 ID 改哈希防多轮合并冲突。参考 https://github.com/gastownhall/beads
9. **重规划节点**：Validator FAIL≥2 时不再原样重试，而是走"拆小"节点——把任务分解为子任务挂回图里
   （parent-child），blocked 只留给真正外部受阻的任务。这是学术搜索（AFlow/ADAS）收敛出的
   固定拓扑：生成 → 并行验证器 → 修复环，直接手抄拓扑，不做在线图搜索。
10. **按难度选择拓扑**：简单任务走单 loop（现状），复杂任务才启用 完整图（重规划+多验证器），
    对应 MaAS/FlowBank 的"按 query 难度出图"结论。
11. **接通 archiveRound 实现多轮**：跑完一轮 → 归档 → 重新拆分下一轮（存量项目"每晚一小步"模式，
    HumanLayer 教训：夜跑 50 个重构必烂尾）。
12. **（可选）独立子图并行**：git worktree 隔离并行执行无依赖任务。前提是按代码内聚性切分
    （Co-Coder：依赖感知切分 +14% pass / 2.1x 提速；盲目按文件并行会亏），先支持 2 路再扩。

### P3 长线（做完 P1/P2 再看）

13. **preAnalyzeStatus 数据化**：1400 行单函数的分支表迁移到声明式规则（DeclarativePlugin 已证明可行），
    用 ActionOutcome 空转率驱动规则的增删——这是"效果数据反哺策略"的闭环。
14. **Hook 载荷进决策**：tool_name/file_path 等高质量信号目前只做展示；让监控知道"CLI 刚在编辑哪个
    文件/跑了什么命令"，减少对截图正则的依赖。hook-events.log 200 行上限同步放开为 JSONL 轮转。
15. **轻量代码图**：aider 式 repo map（tree-sitter+PageRank）注入 Ralph 任务上下文，替代
    CLAUDE.md 粗暴截断 4000 字符。重型 GraphRAG 不适合代码，不做。
16. **补 Ralph 测试**：`_loop`/超时/retry/熔断全无覆盖；P1 改造时同步补，并给 package.json 加 test script。

## 3. 明确不做的事（和理由）

- **不整体迁移 LangGraph/Mastra 等图框架**：我们的差异化在 tmux 读屏+真实 CLI 托管，框架管不了这层；
  且 Diagrid 指出这些框架的 checkpoint ≠ durable execution。只借模式（验证器节点/检查点/人审节点）。
- **不做在线图结构搜索**（AFlow/ADAS/GPTSwarm）：学术热工程冷，搜索成本高且收敛拓扑就那几种，手抄即可。
- **不上重编排**（Gas Town 20-30 并行）：反方"Your Agent Orchestrator Is Too Clever"有理，
  我们的规模先做好 2 路并行的正确性。

## 4. 关键参考

- Loop Engineering 命名文（Osmani）：https://addyosmani.com/blog/loop-engineering/
- Ralph 原文（Huntley）：https://ghuntley.com/ralph/ ；史料：https://www.humanlayer.dev/blog/brief-history-of-ralph
- Anthropic 长程 harness（定位仪式/JSON 清单/禁删测试）：https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
- 双条件退出实现：https://github.com/frankbria/ralph-claude-code ；评审流水线：https://github.com/umputun/ralphex
- 正典 PRD 循环：https://github.com/snarktank/ralph
- 停止理论（VRR-Stop）：https://arxiv.org/abs/2607.17641 ；无限循环检测：https://arxiv.org/abs/2607.01641
- 上下文腐烂：https://www.trychroma.com/research/context-rot ；ACE 增量更新：https://arxiv.org/abs/2510.04618
- Graph Engineering 三层框架：https://www.marktechpost.com/2026/07/29/prompt-engineering-vs-loop-engineering-vs-graph-engineering/
- 任务图样板：https://github.com/gastownhall/beads + https://github.com/gastownhall/gastown
- 依赖感知并行（Co-Coder）：https://arxiv.org/abs/2606.00953
- 图搜索论文：AFlow https://arxiv.org/abs/2410.10762 ；MaAS https://github.com/bingreeky/MaAS
- 代码图谱：codegraph https://github.com/colbymchenry/codegraph ；Serena https://github.com/oraios/serena

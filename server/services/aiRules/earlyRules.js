/**
 * 声明式早期规则表（v1.2.88，P3-13 第一阶段骨架）。
 *
 * 目标：把 preAnalyzeStatus 里按注释编号排布的 if-return 分支逐步搬成数据——
 * 每条规则带稳定 id（写进判定结果 _rule 与 ActionOutcome 台账），让
 * `node scripts/monitor-effectiveness.mjs` 的空转率能精确归因到单条规则，
 * 空转率高就改判据或删规则，而不是在 1400 行单函数里考古。
 *
 * 约定：
 * - 数组顺序即求值顺序（顺序即语义，与原分支位置一致）
 * - match(ctx) 返回 falsy=不命中；对象=命中（可带 log 字段补充日志）
 * - ctx: { tail: 尾部1200清洁文本, clean: 全屏清洁文本, aiType, helpers }
 * - 状态串与迁移前逐字一致（fixture 回归锁定）；新规则再起新串
 *
 * 首批迁移：CLI 内置对话框族（原「高优先级：CLI 内置对话框开着」分支）。
 */

export const EARLY_RULES = [
  {
    id: 'cli-dialog-esc',
    // 这类面板是 CLI 自己的模态界面（/status、/config、/model…），开着时屏幕全是
    // 设置内容，AI 只能判「状态不明确」而无限空转（实测挂过 20+ 分钟）。
    // Esc 无副作用：对话框取消，不提交任何设置变更。
    state: 'CLI 设置对话框开着（/status 等），屏幕被面板占满无法判断工作状态',
    recentAction: '打开了 CLI 内置对话框',
    action: { type: 'key', key: 'Escape' },
    reason: '对话框遮挡了真实终端内容，AI 无法判断会话进展。按 Esc 取消对话框（无副作用，不提交任何设置），下一轮即可正常判定',
    match({ tail, helpers }) {
      const hasEscToCancel = /Esc to cancel/i.test(tail);
      if (!hasEscToCancel) return false;
      // 面板特征：settings/status/config 面板的 Tab 行，或 /model 的选择列表标题
      const looksLikeDialog = /Settings\s+Status\s+Config/i.test(tail)
        || /^\s*(Version|Session ID|Setting sources|Login method|Auth token):/m.test(tail)
        || /Select (Model|Style|Theme)/i.test(tail);
      // 确认菜单也带 Esc 提示，必须排除——那是要选 1/2 的，另有专门分支处理
      const isConfirmMenu = /Do you want to|Would you like to/i.test(tail)
        && /^\s*[❯>]?\s*1\.\s/m.test(tail);
      if (isConfirmMenu) return false;
      if (looksLikeDialog) return {};
      // 结构化兜底：标题白名单认不出的面板（/agents、/output-style，以及以后新增的），
      // 只要"编号选项 + 明确写着 Esc to cancel"，就同样按 Esc 关掉。
      // Esc 提示本身就是 CLI 在声明"这个面板可以无副作用地取消"，比标题可靠得多。
      const menu = helpers.detectOptionMenu(tail);
      if (menu && !menu.hasYes && menu.hasEscHint) {
        return { log: `结构识别到未知选项面板（${menu.items} 项，标题「${menu.title}」）` };
      }
      return false;
    }
  },
  {
    id: 'panel-no-escape',
    // 编号面板开着，但既不是 Yes/No 确认、也没写 Esc 可取消 —— 不知道怎么安全脱身。
    // 绝不能发「继续」：往 Ink 的 SelectInput 里打字既选不中任何项，也推不动工作
    // （这正是白名单漏掉面板后的老毛病）。标记交给 AI 读屏决定按哪个键；
    // AI 不可用时 analyzeStatus 会交出"请人工处理"状态，同样不会瞎按。
    match({ tail, helpers }) {
      const menu = helpers.detectOptionMenu(tail);
      if (menu && !menu.hasYes && !menu.hasEscHint) {
        return { menu, log: `屏上开着选项面板（${menu.items} 项，标题「${menu.title}」）但无已知脱身方式，交给 AI 判断` };
      }
      return false;
    },
    fields({ menu }) {
      return {
        currentState: `CLI 选项面板开着（${menu.title || '未知面板'}）`,
        recentAction: '等待选择',
        actionType: 'warning',
        suggestedAction: null,
        actionReason: `屏上是一个 ${menu.items} 项的选项面板，没有 Yes/No 语义也没提供 Esc 取消，无法判断该按哪个键`,
        requireConfirmation: true,
        _needsAiJudgement: true
      };
    }
  }
];

/** 依序求值，返回 { rule, extras } 或 null。单条规则抛异常不拖垮整表。 */
export function evalEarlyRules(ctx) {
  for (const rule of EARLY_RULES) {
    let m = false;
    try { m = rule.match(ctx); } catch (e) {
      console.error(`[aiRules] 规则 ${rule.id} match 异常: ${e.message}`);
    }
    if (m) return { rule, extras: typeof m === 'object' ? m : {} };
  }
  return null;
}

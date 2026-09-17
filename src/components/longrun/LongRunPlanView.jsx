import React from 'react';

/**
 * 预检结果。只解析、不启动；把启动时会拦下或需要人知情的东西提前摆出来：
 *   · 沙箱已存在：新建不静默覆盖（里面可能是上一轮成果）—— 要么续跑，要么明确勾「删掉重建」
 *   · 外部参考目录对执行者**可写**（--add-dir 不是只读）
 *   · 无法使用的参考路径：默认停止，勾「忽略」才放行
 */
const LongRunPlanView = ({ plan, form, set }) => {
  const resume = form.mode === 'resume';
  const p = plan.prior;
  return (
    <div className="lr-plan">
      <div>沙箱 <code>{plan.sandboxRoot}</code></div>
      {plan.runningTaskId && <div className="lr-err">这个沙箱上已有任务在跑（{plan.runningTaskId}），同一沙箱同时只能跑一个。</div>}

      {!resume && plan.sandboxExists && (
        <div className="lr-note wait">
          沙箱已存在{plan.resumable ? '，有记忆文件' : ''}。新建不会静默覆盖（里面可能是上一轮的成果）。
          {plan.resumable && (
            <button type="button" className="lr-link" onClick={() => set({ mode: 'resume', sandboxName: plan.sandboxName, fresh: false })}>
              改为续跑它
            </button>
          )}
          <label className="lr-check-row">
            <input type="checkbox" checked={form.fresh} onChange={(e) => set({ fresh: e.target.checked })} />
            删掉重建（不可恢复）
          </label>
        </div>
      )}
      {resume && !plan.resumable && <div className="lr-err">这个沙箱没有记忆文件，可能从未成功跑过初始化，用「新建」更合适。</div>}

      {p && (p.legs != null || p.memoryCount > 0) && (
        <div className="lr-kv">
          {p.legs != null && <>上次运行：调用 {p.legs} 次 · 交接 {p.handoffs ?? '?'} 次 · 花费 ${Number(p.spentUsd || 0).toFixed(4)} · </>}
          记忆文件 {p.memoryCount} 个
          {p.memoryIndex?.length > 0 && <pre className="lr-pre">{p.memoryIndex.join('\n')}{p.moreIndex ? `\n…… 另有 ${p.moreIndex} 条` : ''}</pre>}
        </div>
      )}

      <div className="lr-kv">需求 {plan.requirementChars} 字 · 提示词 {plan.promptSource}（{plan.promptSlots.length} 段）</div>
      {plan.refs.length > 0 && (
        <div className="lr-kv">
          参考资料 {plan.refs.length} 条（执行者直接读取，不复制）：
          <pre className="lr-pre">{plan.refs.map((r) => r.path + (r.isDir ? '/' : '')).join('\n')}</pre>
          <div className="lr-est">⚠ 下列目录对执行者可写，不只是可读：</div>
          <pre className="lr-pre">{plan.extraDirs.join('\n')}</pre>
        </div>
      )}
      {plan.urls.length > 0 && <div className="lr-kv">参考链接 {plan.urls.length} 个（交给执行者自行抓取）</div>}
      {plan.rejected.length > 0 && (
        <div className="lr-note bad">
          以下 {plan.rejected.length} 条参考路径无法使用：
          <pre className="lr-pre">{plan.rejected.map(([ref, why]) => `✗ ${ref}\n    ${why}`).join('\n')}</pre>
          {form.allowMissingRefs ? '已勾选忽略，会继续启动。'
            : '参考资料缺失会让执行者按不完整的信息开工，启动会被拦下。修正路径，或在高级参数里勾选忽略。'}
        </div>
      )}
    </div>
  );
};

export default LongRunPlanView;

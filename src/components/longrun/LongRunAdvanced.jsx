import React from 'react';

/** 水位预设。原版默认值按较小窗口定，跑 1M 窗口的模型偏保守 */
export const THRESHOLD_PRESETS = {
  standard: { label: '标准（按 400k 窗口）', handoffFloor: 200000, handoffCeiling: 350000, hardKill: 400000 },
  long: { label: '1M 窗口（少交接、更贵）', handoffFloor: 500000, handoffCeiling: 800000, hardKill: 900000 },
};

export const ADVANCED_DEFAULTS = {
  model: '', totalBudgetUsd: '', maxLegs: 200, ...THRESHOLD_PRESETS.standard, maintenanceEvery: 3,
  taskWait: 1800, noAsk: false, noSupervisor: false, allowMissingRefs: false, supervisorPrompt: '', promptsFile: '',
};

/** 三档水位是否有序（服务端还会再挡一道） */
export function thresholdError({ handoffFloor, handoffCeiling, hardKill }) {
  const [f, c, h] = [handoffFloor, handoffCeiling, hardKill].map(Number);
  if (![f, c, h].every((x) => Number.isFinite(x) && x > 0)) return '三档水位都要填正整数';
  if (!(f < c && c < h)) return '必须 交接下限 < 主动打断 < 硬上限（写反会让每发刚开跑就被打断）';
  return '';
}

const Num = ({ label, hint, value, onChange, step = 1 }) => (
  <div className="form-group half">
    <label title={hint}>{label}</label>
    <input type="number" step={step} value={value} onChange={(e) => onChange(e.target.value)} placeholder={hint} />
  </div>
);
const Check = ({ label, hint, checked, onChange }) => (
  <label className="lr-check-row" title={hint}>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {label}
    <span className="lr-dim"> —— {hint}</span>
  </label>
);

/** 高级参数：与原版 start.py / resume.py 的命令行参数一一对应。 */
const LongRunAdvanced = ({ form, set }) => {
  const err = thresholdError(form);
  return (
    <div className="lr-adv">
      <div className="lr-row">
        <span className="lr-dim">水位预设</span>
        {Object.entries(THRESHOLD_PRESETS).map(([k, p]) => (
          <button key={k} type="button" className="btn btn-secondary btn-small"
            onClick={() => set({ handoffFloor: p.handoffFloor, handoffCeiling: p.handoffCeiling, hardKill: p.hardKill })}>{p.label}</button>
        ))}
      </div>
      <div className="lr-grid">
        <Num label="交接下限" hint="正常结束且水位过此值则交接" value={form.handoffFloor} onChange={(v) => set({ handoffFloor: v })} />
        <Num label="主动打断" hint="运行中水位过此值，在工具间隙主动打断" value={form.handoffCeiling} onChange={(v) => set({ handoffCeiling: v })} />
        <Num label="硬上限" hint="到此直接结束这一发" value={form.hardKill} onChange={(v) => set({ hardKill: v })} />
        <Num label="记忆维护间隔" hint="每 N 次交接前跑一轮记忆维护，0 关闭" value={form.maintenanceEvery} onChange={(v) => set({ maintenanceEvery: v })} />
        <Num label="总预算（美元）" hint="留空 = 不限" value={form.totalBudgetUsd} step={0.5} onChange={(v) => set({ totalBudgetUsd: v })} />
        <Num label="调用次数上限" hint="执行者最多被调用多少发" value={form.maxLegs} onChange={(v) => set({ maxLegs: v })} />
        <Num label="后台任务等待（秒）" hint="主线说完后等后台 subagent 收尾的上限；0 = 不等，在飞的 agent 会连坐死掉" value={form.taskWait} onChange={(v) => set({ taskWait: v })} />
        <div className="form-group half">
          <label>执行者模型</label>
          <input value={form.model} onChange={(e) => set({ model: e.target.value })} placeholder="留空 = CLI 默认" />
        </div>
      </div>
      {err && <div className="lr-err">{err}</div>}
      <Check label="需要人时不等，直接停机" hint="无人值守过夜时用：等一个不在场的人等于永久挂死" checked={form.noAsk} onChange={(v) => set({ noAsk: v })} />
      <Check label="不启用监督者" hint="执行者每次结束都停机等人判断" checked={form.noSupervisor} onChange={(v) => set({ noSupervisor: v })} />
      <Check label="忽略无法使用的参考路径" hint="默认停止：参考资料缺失会让执行者按不完整的信息开工" checked={form.allowMissingRefs} onChange={(v) => set({ allowMissingRefs: v })} />
      <div className="form-group">
        <label>监督者判定提示词文件</label>
        <input value={form.supervisorPrompt} onChange={(e) => set({ supervisorPrompt: e.target.value })}
          placeholder="留空 = 内置默认。换掉它等于换掉全部判定规则；给了路径就必须读得到" />
      </div>
      <div className="form-group">
        <label>执行者提示词文件</label>
        <input value={form.promptsFile} onChange={(e) => set({ promptsFile: e.target.value })}
          placeholder="留空 = 内置提示词.txt（缺任何一段都拒绝启动）" />
      </div>
    </div>
  );
};

export default LongRunAdvanced;

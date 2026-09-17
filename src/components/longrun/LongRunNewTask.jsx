import React, { useState, useEffect } from 'react';
import LongRunAdvanced, { ADVANCED_DEFAULTS, thresholdError } from './LongRunAdvanced.jsx';
import LongRunPlanView from './LongRunPlanView.jsx';

/**
 * 「长程开发」弹窗（样式与新建会话弹窗一致）。
 *   新建 = 原版 start.py：发初始化提示词 + 需求全文
 *   续跑 = 原版 resume.py：不重跑初始化，先发新对话开始提示词，需求按"新增"包装
 * 预检只解析不启动；启动时服务端还会把所有能在动沙箱之前查出的问题先查一遍。
 */
const LongRunNewTask = ({ lr, preset, onClose, onStarted, onOpenLegacy }) => {
  const [form, setForm] = useState(() => ({
    mode: preset?.mode || 'start', source: 'paste', requirementText: '', docPath: '',
    sandboxName: preset?.sandboxName || '', fresh: false, providerId: '', ...ADVANCED_DEFAULTS,
  }));
  const [providers, setProviders] = useState([]);
  const [plan, setPlan] = useState(null);
  const [showAdv, setShowAdv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setError(''); };
  const resume = form.mode === 'resume';

  useEffect(() => {
    let aborted = false;
    fetch('/api/cc-switch/providers?app=claude').then((r) => r.json()).then((res) => {
      if (!aborted) setProviders(res?.data?.providers || res?.providers || []);
    }).catch(() => {});
    lr.refreshLists();
    return () => { aborted = true; };
  }, []);

  const reqPayload = () => (form.source === 'path' ? { docPath: form.docPath.trim() } : { requirementText: form.requirementText });
  const doPlan = async () => {
    setBusy(true); setError('');
    const r = await lr.call('longrun:plan', { ...reqPayload(), sandboxName: form.sandboxName.trim() || undefined,
      promptsFile: form.promptsFile.trim() || undefined });
    setBusy(false);
    if (!r.ok) { setPlan(null); setError(r.error); return; }
    setPlan(r);
    if (!form.sandboxName.trim() && !resume) set({ sandboxName: r.sandboxName });
  };

  const start = async () => {
    const te = thresholdError(form);
    if (te) { setError(te); setShowAdv(true); return; }
    setBusy(true); setError('');
    const { source, requirementText, docPath, ...rest } = form;
    const r = await lr.call('longrun:start', { ...rest, ...reqPayload(), sandboxName: form.sandboxName.trim() || undefined,
      providerId: form.providerId || undefined });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onStarted(r.task);
  };

  const resumable = lr.sandboxes.filter((s) => s.resumable);
  const hasReq = form.source === 'path' ? form.docPath.trim() : form.requirementText.trim();

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal lr-modal" onClick={(e) => e.stopPropagation()}>
        <h2>长程开发</h2>
        <div className="lr-row lr-mb">
          <label><input type="radio" checked={!resume} onChange={() => { set({ mode: 'start' }); setPlan(null); }} /> 新建项目</label>
          <label><input type="radio" checked={resume} onChange={() => { set({ mode: 'resume', fresh: false }); setPlan(null); }} /> 续跑已有沙箱（追加需求）</label>
        </div>

        {resume && (
          <div className="form-group">
            <label>要续跑的沙箱</label>
            <select className="lr-select" value={form.sandboxName} onChange={(e) => { set({ sandboxName: e.target.value }); setPlan(null); }}>
              <option value="">选择沙箱…</option>
              {resumable.map((s) => (
                <option key={s.name} value={s.name} disabled={!!s.runningTaskId}>
                  {s.name}{s.prior?.legs != null ? ` · 上次 ${s.prior.legs} 发 / $${Number(s.prior.spentUsd || 0).toFixed(2)}` : ''}{s.runningTaskId ? '（正在跑）' : ''}
                </option>
              ))}
            </select>
            {!resumable.length && <div className="lr-dim">没有可续跑的沙箱（需要有记忆文件）</div>}
          </div>
        )}

        <div className="form-group">
          <label>
            {resume ? '新增需求（只写增量即可，执行者会先读记忆确认进度）' : '需求'}
            <span className="lr-seg">
              <button type="button" className={form.source === 'paste' ? 'on' : ''} onClick={() => set({ source: 'paste' })}>粘贴文本</button>
              <button type="button" className={form.source === 'path' ? 'on' : ''} onClick={() => set({ source: 'path' })}>本机文档路径</button>
            </span>
          </label>
          {form.source === 'paste' ? (
            <textarea className="lr-req-input" value={form.requirementText} onChange={(e) => { set({ requirementText: e.target.value }); setPlan(null); }}
              placeholder="Markdown 或纯文本。文中写到的本机路径会作为参考资料挂给执行者（可写！），链接交给执行者自行抓取。" />
          ) : (
            <input value={form.docPath} onChange={(e) => { set({ docPath: e.target.value }); setPlan(null); }} placeholder="/Users/you/需求.md" />
          )}
        </div>

        {!resume && (
          <div className="form-group">
            <label>沙箱名（留空按需求标题/文档名派生）</label>
            <input value={form.sandboxName} onChange={(e) => { set({ sandboxName: e.target.value }); setPlan(null); }} />
          </div>
        )}

        <div className="form-group">
          <label>监督者供应商（CC Switch）</label>
          <select className="lr-select" value={form.providerId} onChange={(e) => set({ providerId: e.target.value })}>
            <option value="">跟随当前 Claude 供应商</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}{p.isCurrent ? '（当前）' : ''}</option>)}
          </select>
        </div>

        <button type="button" className="lr-link" onClick={() => setShowAdv(!showAdv)}>{showAdv ? '▾' : '▸'} 高级参数（水位、预算、维护、等待、监督者…）</button>
        {showAdv && <LongRunAdvanced form={form} set={set} />}

        {plan && <LongRunPlanView plan={plan} form={form} set={set} />}
        {error && <pre className="lr-err lr-pre">{error}</pre>}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button className="btn btn-secondary" disabled={busy || !hasReq} onClick={doPlan}>预检</button>
          <button className="btn btn-primary" disabled={busy || !hasReq || (resume && !form.sandboxName)} onClick={start}>
            {busy ? '处理中…' : resume ? '开始续跑' : '开始'}
          </button>
        </div>
        {onOpenLegacy && (
          <button className="lr-link lr-legacy" onClick={onOpenLegacy}>旧版：拆任务逐个做，在你的项目目录里跑（自主开发）›</button>
        )}
      </div>
    </div>
  );
};

export default LongRunNewTask;

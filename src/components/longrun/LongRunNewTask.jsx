import React, { useState, useEffect, useMemo } from 'react';
import LongRunAdvanced, { ADVANCED_DEFAULTS, thresholdError } from './LongRunAdvanced.jsx';
import LongRunPlanView from './LongRunPlanView.jsx';

const MODE_TEXT = { start: '新建', takeover: '接管已有项目', resume: '续跑' };
const MODE_HINT = {
  start: '发初始化提示词建记忆库，再发需求全文',
  takeover: '不删不改已有代码与配置；先发初始化提示词建记忆库，需求按"在已有进度上继续"交给执行者；原有 Claude 记忆复制进 .memory',
  resume: '跳过初始化：先发「新对话开始提示词」让执行者从记忆接上，再给新增需求',
};

/**
 * 「长程开发」弹窗（样式与新建会话弹窗一致）。项目与传统会话同一个根（~/Documents/ClaudeCode）：
 *   新项目   —— 填名字，在项目根下新建
 *   已有项目 —— 从会话与跑过长程的项目里选；按目录现状自动定：跑过长程 → 续跑，已有代码 → 接管
 * 预检只解析不启动；启动时服务端还会把所有能在动目录之前查出的问题先查一遍。
 */
const LongRunNewTask = ({ lr, preset, sessions = [], onClose, onStarted, onOpened, onOpenLegacy }) => {
  const [form, setForm] = useState(() => ({
    kind: preset?.projectRoot ? 'existing' : 'new', projectName: '', projectRoot: preset?.projectRoot || '',
    mode: preset?.mode || 'start', source: 'paste', requirementText: '', docPath: '', fresh: false, providerId: '',
    ...ADVANCED_DEFAULTS,
  }));
  const [dir, setDir] = useState(null);        // 已有项目的现状（longrun:projectState）
  const [providers, setProviders] = useState([]);
  const [plan, setPlan] = useState(null);
  const [showAdv, setShowAdv] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setError(''); };

  useEffect(() => {
    let aborted = false;
    fetch('/api/cc-switch/providers?app=claude').then((r) => r.json()).then((res) => {
      if (!aborted) setProviders(res?.data?.providers || res?.providers || []);
    }).catch(() => {});
    lr.refreshLists();
    return () => { aborted = true; };
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  // 已有项目候选：会话的工作目录 + 跑过长程的项目（含旧沙箱），按路径去重
  const existing = useMemo(() => {
    const map = new Map();
    for (const s of sessions) if (s.workingDir) map.set(s.workingDir, { root: s.workingDir, name: s.projectName || s.name, from: '会话' });
    for (const p of lr.sandboxes) if (!map.has(p.root)) map.set(p.root, { root: p.root, name: p.name, from: p.legacy ? '旧沙箱' : '长程项目' });
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }, [sessions, lr.sandboxes]);

  // 选中已有项目 → 取现状，按现状定接管还是续跑（没跑过长程的目录没法续跑，所以不沿用 preset 的方式）
  useEffect(() => {
    if (form.kind !== 'existing' || !form.projectRoot) { setDir(null); return; }
    let alive = true;
    lr.call('longrun:projectState', { projectRoot: form.projectRoot }).then((r) => {
      if (!alive) return;
      if (!r.ok) { setDir(null); setError(r.error); return; }
      setDir(r);
      set({ mode: r.suggestedMode });
    });
    return () => { alive = false; };
  }, [form.kind, form.projectRoot]);   // eslint-disable-line react-hooks/exhaustive-deps

  const where = () => (form.kind === 'existing' ? { projectRoot: form.projectRoot } : { projectName: form.projectName.trim() || undefined });
  const reqPayload = () => (form.source === 'path' ? { docPath: form.docPath.trim() } : { requirementText: form.requirementText });
  const mode = form.kind === 'existing' ? form.mode : 'start';

  const doPlan = async () => {
    setBusy(true); setError('');
    const r = await lr.call('longrun:plan', { ...reqPayload(), ...where(), promptsFile: form.promptsFile.trim() || undefined });
    setBusy(false);
    if (!r.ok) { setPlan(null); setError(r.error); return; }
    setPlan(r);
    if (form.kind === 'new' && !form.projectName.trim()) set({ projectName: r.projectName });
  };

  const start = async () => {
    const te = thresholdError(form);
    if (te) { setError(te); setShowAdv(true); return; }
    setBusy(true); setError('');
    const { kind, source, requirementText, docPath, projectName, projectRoot, mode: chosen, ...rest } = form;
    const r = await lr.call('longrun:start', { ...rest, ...reqPayload(), ...where(), mode,
      fresh: mode === 'start' && form.fresh, providerId: form.providerId || undefined });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onStarted(r.task);
  };

  // 跑过长程的项目（含旧沙箱）只看记录：打开成条目，主区回放上一轮，不启动任何东西
  const openOnly = async () => {
    setBusy(true); setError('');
    const r = await lr.call('longrun:openProject', { projectRoot: form.projectRoot });
    setBusy(false);
    if (!r.ok) { setError(r.error); return; }
    onOpened(r.sessionId);
  };

  const hasReq = form.source === 'path' ? form.docPath.trim() : form.requirementText.trim();
  const blocked = form.kind === 'existing' && (!form.projectRoot || !dir || dir.runningTaskId
    || (mode === 'resume' && !dir.resumable) || dir.dirState === 'missing');

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal lr-modal" onClick={(e) => e.stopPropagation()}>
        <h2>长程开发</h2>
        <div className="lr-row lr-mb">
          <label><input type="radio" checked={form.kind === 'new'} onChange={() => { set({ kind: 'new', mode: 'start' }); setPlan(null); }} /> 新项目</label>
          <label><input type="radio" checked={form.kind === 'existing'} onChange={() => { set({ kind: 'existing' }); setPlan(null); }} /> 已有项目（接管或续跑）</label>
        </div>

        {form.kind === 'new' ? (
          <div className="form-group">
            <label>项目名（建在项目根下，与终端会话同一个目录；留空按需求标题派生）</label>
            <input value={form.projectName} onChange={(e) => { set({ projectName: e.target.value }); setPlan(null); }} placeholder="例如 jsonfmt2" />
          </div>
        ) : (
          <div className="form-group">
            <label>项目</label>
            <select className="lr-select" value={form.projectRoot} onChange={(e) => { set({ projectRoot: e.target.value }); setPlan(null); }}>
              <option value="">选择项目…</option>
              {existing.map((p) => <option key={p.root} value={p.root}>{p.name}（{p.from}）· {p.root}</option>)}
            </select>
            {dir && (
              <div className="lr-note wait">
                将以「{MODE_TEXT[mode]}」方式启动：{MODE_HINT[mode]}
                {dir.prior?.legs != null && <div>上次长程：调用 {dir.prior.legs} 次 · 交接 {dir.prior.handoffs ?? 0} 次 · ${Number(dir.prior.spentUsd || 0).toFixed(2)}</div>}
                {dir.runningTaskId && <div className="lr-err">这个项目上已有长程在跑。</div>}
                {mode === 'resume' && !dir.resumable && <div className="lr-err">没有记忆文件，无法续跑。</div>}
                {dir.dirState === 'longrun' && onOpened && (
                  <div><button type="button" className="lr-link" disabled={busy} onClick={openOnly}>只看上一轮记录 ›</button></div>
                )}
              </div>
            )}
            <div className="lr-dim lr-small">这个项目的会话里 claude 若正在运行，需要先在终端里退出，长程才能启动。</div>
          </div>
        )}

        <div className="form-group">
          <label>
            {mode === 'start' ? '需求' : '新增需求（只写增量即可，执行者会先读记忆确认进度）'}
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

        <div className="form-group">
          <label>监督者供应商（CC Switch）</label>
          <select className="lr-select" value={form.providerId} onChange={(e) => set({ providerId: e.target.value })}>
            <option value="">跟随 CC Switch 当前 Claude 配置（经 claude CLI，与执行者同一套地址、登录与代理）</option>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}{p.isCurrent ? '（当前）' : ''}</option>)}
          </select>
        </div>

        <button type="button" className="lr-link" onClick={() => setShowAdv(!showAdv)}>{showAdv ? '▾' : '▸'} 高级参数（水位、预算、维护、等待、监督者…）</button>
        {showAdv && <LongRunAdvanced form={form} set={set} />}

        {plan && <LongRunPlanView plan={plan} form={{ ...form, mode }} set={set} />}
        {error && <pre className="lr-err lr-pre">{error}</pre>}

        <div className="modal-actions">
          <button className="btn btn-secondary" onClick={onClose}>取消</button>
          <button className="btn btn-secondary" disabled={busy || !hasReq || blocked} onClick={doPlan}>预检</button>
          <button className="btn btn-primary" disabled={busy || !hasReq || blocked} onClick={start}>
            {busy ? '处理中…' : `开始${MODE_TEXT[mode]}`}
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

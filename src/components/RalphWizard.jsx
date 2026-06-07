import React, { useState, useEffect } from 'react';
import './RalphWizard.css';

/**
 * 自主开发一键向导：两步
 * Step1 填需求 → 自动建目录/git/拆分 → Step2 确认任务清单 → 开跑
 */
const RalphWizard = ({ socket, onClose, onStarted }) => {
  const [step, setStep] = useState(1);
  const [mode, setMode] = useState('new');        // new | existing
  const [projectName, setProjectName] = useState('');
  const [parentDir, setParentDir] = useState('~/Documents/ClaudeCode');
  const [existingDir, setExistingDir] = useState('');
  const [requirement, setRequirement] = useState('');
  const [aiType, setAiType] = useState('claude');
  const [pauseEach, setPauseEach] = useState(false);

  // API 供应商（每会话独立，不影响全局）
  const [providers, setProviders] = useState([]);
  const [providerId, setProviderId] = useState('');

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [sessionId, setSessionId] = useState(null);
  const [features, setFeatures] = useState([]);
  const [enabled, setEnabled] = useState({});      // id -> bool
  const [dirtyFiles, setDirtyFiles] = useState(null);

  // 已有项目列表（来自各 CLI 的最近项目，供选择）
  const [recentProjects, setRecentProjects] = useState([]);

  useEffect(() => {
    if (!socket) return;
    const handleList = (data) => {
      // 合并各 CLI、按路径去重、按最近使用排序
      const merged = [
        ...(data.claude || []), ...(data.codex || []),
        ...(data.gemini || []), ...(data.grok || [])
      ];
      const byPath = new Map();
      for (const p of merged) {
        const ex = byPath.get(p.path);
        if (!ex || (p.lastUsed || 0) > (ex.lastUsed || 0)) byPath.set(p.path, p);
      }
      setRecentProjects([...byPath.values()].sort((a, b) => (b.lastUsed || 0) - (a.lastUsed || 0)));
    };
    socket.on('recentProjects:list', handleList);
    socket.emit('recentProjects:get');
    return () => socket.off('recentProjects:list', handleList);
  }, [socket]);

  // 随 CLI 联动拉取供应商列表，默认选当前激活项（跟随全局）
  useEffect(() => {
    let aborted = false;
    setProviders([]);
    setProviderId('');
    fetch(`/api/cc-switch/providers?app=${aiType}`)
      .then(r => r.json())
      .then(res => {
        if (aborted) return;
        const list = res?.data?.providers || res?.providers || [];
        setProviders(list);
        const cur = list.find(p => p.isCurrent);
        setProviderId(cur ? cur.id : ''); // '' = 跟随默认
      })
      .catch(() => { if (!aborted) setProviders([]); });
    return () => { aborted = true; };
  }, [aiType]);

  // Step1 提交：触发拆分
  const doPlan = () => {
    setError('');
    if (mode === 'new' && (!projectName.trim() || !parentDir.trim())) { setError('请填写项目名和位置'); return; }
    if (mode === 'existing' && !existingDir.trim()) { setError('请选择已有项目目录'); return; }
    if (requirement.trim().length < 5) { setError('请用一句话描述你想做什么（至少 5 个字）'); return; }
    setLoading(true);
    socket.emit('ralph:wizard:plan', {
      projectName: projectName.trim(),
      parentDir: parentDir.trim(),
      existingDir: mode === 'existing' ? existingDir.trim() : undefined,
      requirement: requirement.trim(),
      aiType,
      providerId: providerId || undefined
    }, (res) => {
      setLoading(false);
      if (res.error === 'premium_required') {
        setError('🔒 自主开发是专业版功能。' + (res.subscriptionUrl ? '点这里订阅：' + res.subscriptionUrl : '请订阅后使用'));
        return;
      }
      if (res.error) { setError(res.error); return; }
      // 会话已建好：立即关闭弹窗、切到会话窗口；拆分在后台进行，进度显示在会话窗口
      if (res.sessionId) {
        onStarted?.(res.sessionId);
        onClose();
      }
    });
  };

  // Step2 提交：确认开跑
  const doStart = (ignoreDirty = false) => {
    setError('');
    setLoading(true);
    const ids = features.filter(f => enabled[f.id]).map(f => f.id);
    socket.emit('ralph:wizard:start', { sessionId, enabledTaskIds: ids, pauseAfterEachTask: pauseEach, ignoreDirty }, (res) => {
      setLoading(false);
      if (res.error === 'premium_required') { setError('🔒 自主开发是专业版功能，请订阅后使用'); return; }
      if (res.blocked === 'dirty') { setDirtyFiles(res.files || []); return; }
      if (res.error) { setError(res.error); return; }
      if (res.started) { onStarted?.(sessionId); onClose(); }
    });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal ralph-wizard" onClick={(e) => e.stopPropagation()}>
        {step === 1 ? renderStep1() : renderStep2()}
      </div>
    </div>
  );

  function renderStep1() {
    return (
      <>
        <h2>🏭 自主开发</h2>
        <p className="rw-sub">描述你想做什么，AI 会自动拆成可执行任务并逐个完成、逐条验证。</p>
        <div className="rw-tabs">
          <button className={mode === 'new' ? 'active' : ''} onClick={() => setMode('new')}>新建项目</button>
          <button className={mode === 'existing' ? 'active' : ''} onClick={() => setMode('existing')}>已有项目</button>
        </div>
        {mode === 'new' ? (
          <>
            <div className="form-group">
              <label>项目名</label>
              <input value={projectName} onChange={e => setProjectName(e.target.value)} placeholder="my-todo-app" />
            </div>
            <div className="form-group">
              <label>位置（父目录）</label>
              <input value={parentDir} onChange={e => setParentDir(e.target.value)} placeholder="~/Documents/ClaudeCode" />
            </div>
          </>
        ) : (
          <div className="form-group">
            <label>选择已有项目</label>
            {recentProjects.length > 0 && (
              <div className="rw-projects">
                {recentProjects.map(p => (
                  <button
                    type="button"
                    key={p.path}
                    className={`rw-project ${existingDir === p.path ? 'active' : ''}`}
                    onClick={() => setExistingDir(p.path)}
                    title={p.path}
                  >
                    <span className={`rw-project-badge ${p.aiType}`}>{p.aiType}</span>
                    <span className="rw-project-name">{p.name}</span>
                    <span className="rw-project-path">{p.path}</span>
                  </button>
                ))}
              </div>
            )}
            <input
              value={existingDir}
              onChange={e => setExistingDir(e.target.value)}
              placeholder="或手动输入绝对路径 /Users/you/Code/myproject"
            />
          </div>
        )}
        <div className="form-group">
          <label>想做什么？（大白话即可）</label>
          <textarea value={requirement} onChange={e => setRequirement(e.target.value)} rows={4}
            placeholder="例如：做一个待办事项 Web 应用，React 前端 + Node 后端，能增删改查、标记完成、按状态筛选" />
        </div>
        <div className="form-group rw-row">
          <label>CLI</label>
          <select value={aiType} onChange={e => setAiType(e.target.value)}>
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
            <option value="gemini">Gemini</option>
            <option value="grok">Grok</option>
          </select>
          <label className="rw-check">
            <input type="checkbox" checked={pauseEach} onChange={e => setPauseEach(e.target.checked)} />
            每个任务完成后暂停
          </label>
        </div>
        <div className="form-group rw-row">
          <label>API 供应商</label>
          {providers.length > 0 ? (
            <select value={providerId} onChange={e => setProviderId(e.target.value)} style={{ flex: 1 }}>
              <option value="">跟随当前默认</option>
              {providers.map(p => (
                <option key={p.id} value={p.id}>{p.name}{p.isCurrent ? '（当前）' : ''}</option>
              ))}
            </select>
          ) : (
            <span className="rw-hint">该 CLI 无可选供应商，使用默认</span>
          )}
        </div>
        <div className="rw-provider-note">仅本次会话生效，不影响全局设置</div>
        {error && <div className="rw-error">{error}</div>}
        <div className="rw-actions">
          <button onClick={onClose} disabled={loading}>取消</button>
          <button className="rw-primary" onClick={doPlan} disabled={loading}>
            {loading ? '⏳ 正在拆分任务...' : '下一步'}
          </button>
        </div>
      </>
    );
  }

  function renderStep2() {
    if (dirtyFiles) {
      return (
        <>
          <h2>⚠️ 工作区有未提交改动</h2>
          <p className="rw-sub">检测到以下未提交文件，建议先提交避免和自主改动混在一起：</p>
          <div className="rw-dirty">{dirtyFiles.map((f, i) => <div key={i}>{f}</div>)}</div>
          {error && <div className="rw-error">{error}</div>}
          <div className="rw-actions">
            <button onClick={() => setDirtyFiles(null)} disabled={loading}>返回</button>
            <button className="rw-primary" onClick={() => doStart(true)} disabled={loading}>忽略并继续</button>
          </div>
        </>
      );
    }
    const count = features.filter(f => enabled[f.id]).length;
    return (
      <>
        <h2>✓ 拆成 {features.length} 个任务</h2>
        <p className="rw-sub">勾选要执行的任务，确认后开始自主开发（将在专属分支上进行）。</p>
        <div className="rw-tasks">
          {features.map(f => (
            <label key={f.id} className={`rw-task ${f.status === 'completed' ? 'done' : ''}`}>
              <input type="checkbox" checked={!!enabled[f.id]}
                disabled={f.status === 'completed'}
                onChange={e => setEnabled({ ...enabled, [f.id]: e.target.checked })} />
              <div className="rw-task-body">
                <div className="rw-task-name">
                  <span className="rw-task-id">{f.id}</span> {f.name}
                  {f.status === 'completed' && <span className="rw-task-tag">已完成</span>}
                </div>
                {f.acceptanceCriteria?.length > 0 && (
                  <div className="rw-task-ac">验收: {f.acceptanceCriteria.slice(0, 2).join('；')}{f.acceptanceCriteria.length > 2 ? ' …' : ''}</div>
                )}
              </div>
            </label>
          ))}
        </div>
        {error && <div className="rw-error">{error}</div>}
        <div className="rw-actions">
          <button onClick={() => { setStep(1); setError(''); }} disabled={loading}>返回改需求</button>
          <button className="rw-primary" onClick={() => doStart(false)} disabled={loading || count === 0}>
            {loading ? '⏳ 启动中...' : `🚀 开始自主开发 (${count})`}
          </button>
        </div>
      </>
    );
  }
};

export default RalphWizard;

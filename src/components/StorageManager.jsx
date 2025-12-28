/**
 * 存储管理组件
 * 管理终端历史回放和监控日志的存储设置
 */

import { useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '../i18n';
import './StorageManager.css';

export default function StorageManager({ socket, onPlayback }) {
  const { t } = useTranslation();

  // 存储统计
  const [stats, setStats] = useState({
    recordings: { size: 0, count: 0, oldestTime: null },
    logs: { size: 0, count: 0, oldestTime: null }
  });

  // 按会话分组的录制
  const [sessionRecordings, setSessionRecordings] = useState([]);

  // 设置
  const [settings, setSettings] = useState({
    recordingsMaxSize: 500,
    recordingsRetentionDays: 7,
    logsMaxSize: 100,
    logsRetentionDays: 30
  });

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState({ type: '', text: '' });
  const [deleteMenu, setDeleteMenu] = useState(null); // { sessionId, x, y }

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [statsRes, settingsRes, sessionsRes] = await Promise.all([
        fetch('/api/storage/stats'),
        fetch('/api/storage/settings'),
        fetch('/api/storage/recordings/by-session')
      ]);

      if (statsRes.ok) setStats(await statsRes.json());
      if (settingsRes.ok) {
        const data = await settingsRes.json();
        setSettings(prev => ({ ...prev, ...data }));
      }
      if (sessionsRes.ok) setSessionRecordings(await sessionsRes.json());
    } catch (err) {
      console.error('加载存储数据失败:', err);
    }
    setLoading(false);
  };

  const saveSettings = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/storage/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings)
      });
      setMessage({ type: res.ok ? 'success' : 'error', text: res.ok ? '设置已保存' : '保存失败' });
    } catch (err) {
      setMessage({ type: 'error', text: '保存失败' });
    }
    setSaving(false);
    setTimeout(() => setMessage({ type: '', text: '' }), 3000);
  };

  const deleteSessionRecording = async (sessionId, minutes = 0) => {
    setDeleteMenu(null);
    try {
      const res = await fetch(`/api/storage/recordings/${sessionId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes })
      });
      if (res.ok) {
        const data = await res.json();
        setMessage({ type: 'success', text: `已删除 ${data.deleted || 0} 条记录` });
        loadData();
      }
    } catch (err) {
      setMessage({ type: 'error', text: '删除失败' });
    }
    setTimeout(() => setMessage({ type: '', text: '' }), 3000);
  };

  const showDeleteMenu = (e, session) => {
    e.stopPropagation();
    const rect = e.target.getBoundingClientRect();
    // 计算时间跨度（毫秒）
    const duration = Date.now() - (session.startTime || Date.now());
    setDeleteMenu({
      sessionId: session.sessionId,
      x: rect.left,
      y: rect.bottom + 4,
      duration
    });
  };

  // 根据时间跨度动态生成删除选项
  const getTimeRanges = (durationMs) => {
    const minutes = durationMs / (60 * 1000);
    const hours = durationMs / (60 * 60 * 1000);
    const days = durationMs / (24 * 60 * 60 * 1000);

    const ranges = [];

    if (minutes <= 60) {
      // 1小时内：按分钟
      if (minutes > 5) ranges.push({ label: '5分钟前', minutes: 5 });
      if (minutes > 15) ranges.push({ label: '15分钟前', minutes: 15 });
      if (minutes > 30) ranges.push({ label: '30分钟前', minutes: 30 });
    } else if (hours <= 24) {
      // 24小时内：按小时
      if (hours > 1) ranges.push({ label: '1小时前', minutes: 60 });
      if (hours > 3) ranges.push({ label: '3小时前', minutes: 180 });
      if (hours > 6) ranges.push({ label: '6小时前', minutes: 360 });
      if (hours > 12) ranges.push({ label: '12小时前', minutes: 720 });
    } else {
      // 超过24小时：按天
      if (days > 1) ranges.push({ label: '1天前', minutes: 1440 });
      if (days > 7) ranges.push({ label: '7天前', minutes: 10080 });
      if (days > 30) ranges.push({ label: '30天前', minutes: 43200 });
      if (days > 90) ranges.push({ label: '90天前', minutes: 129600 });
    }

    ranges.push({ label: '全部', minutes: 0 });
    return ranges;
  };

  // 删除不再需要的静态 timeRanges

  const cleanData = async (type, hours = 0) => {
    const timeLabel = hours === 0 ? '全部' : timeRanges.find(r => r.hours === hours)?.label || `${hours}小时`;
    const typeLabel = type === 'recordings' ? '终端回放' : '监控日志';
    if (!confirm(`确定要清理${timeLabel}的${typeLabel}数据吗？`)) return;
    try {
      const res = await fetch(`/api/storage/clean/${type}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ hours })
      });
      if (res.ok) {
        const data = await res.json();
        setMessage({ type: 'success', text: `已清理 ${data.deleted || 0} 条记录` });
        loadData();
      }
    } catch (err) {
      setMessage({ type: 'error', text: '清理失败' });
    }
    setTimeout(() => setMessage({ type: '', text: '' }), 3000);
  };

  const exportData = async (type) => {
    try {
      const res = await fetch(`/api/storage/export/${type}`);
      if (res.ok) {
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `webtmux-${type}-${new Date().toISOString().split('T')[0]}.json`;
        a.click();
        URL.revokeObjectURL(url);
      }
    } catch (err) {
      setMessage({ type: 'error', text: '导出失败' });
      setTimeout(() => setMessage({ type: '', text: '' }), 3000);
    }
  };

  const formatSize = (bytes) => {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  };

  const formatDate = (ts) => ts ? new Date(ts).toLocaleString() : '-';

  if (loading) return <div className="storage-loading">加载中...</div>;

  return (
    <div className="storage-manager">
      {message.text && <div className={`storage-message ${message.type}`}>{message.text}</div>}

      {/* 终端回放 - 按项目管理 */}
      <div className="storage-section">
        <h3>终端历史回放</h3>

        <div className="storage-stats">
          <div className="stat-item">
            <span className="stat-label">总占用</span>
            <span className="stat-value">{formatSize(stats.recordings.size)}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">项目数</span>
            <span className="stat-value">{sessionRecordings.length}</span>
          </div>
        </div>

        {/* 项目列表 */}
        <div className="session-list">
          <div className="session-list-header">
            <span>项目</span>
            <span>大小</span>
            <span>日期</span>
            <span>操作</span>
          </div>
          {sessionRecordings.length === 0 ? (
            <div className="session-list-empty">暂无历史记录</div>
          ) : (
            sessionRecordings.map(s => {
              // 智能获取显示名称：项目名 > 目录名 > 会话名 > 格式化ID
              const displayName = s.projectName
                || (s.projectDir ? s.projectDir.split('/').pop() : null)
                || s.name
                || `会话 ${s.sessionId.slice(0, 6)}`;
              return (
              <div key={s.sessionId} className="session-item">
                <div className="session-info">
                  <div className="session-name" title={s.projectName || s.projectDir || s.name || s.sessionId}>
                    {displayName}
                  </div>
                  {s.projectDir && (
                    <div className="session-dir" title={s.projectDir}>
                      {s.projectDir.split('/').slice(-2).join('/')}
                    </div>
                  )}
                  {s.projectDesc && (
                    <div className="session-desc" title={s.projectDesc}>
                      {s.projectDesc.slice(0, 30)}{s.projectDesc.length > 30 ? '...' : ''}
                    </div>
                  )}
                </div>
                <span className="session-size">{formatSize(s.size)}</span>
                <span className="session-time">{formatDate(s.startTime).split(' ')[0]}</span>
                <div className="session-actions">
                  {onPlayback && (
                    <button
                      className="btn btn-primary btn-xs"
                      onClick={() => onPlayback(s.sessionId)}
                      title="历史回放"
                    >
                      ▶
                    </button>
                  )}
                  <button
                    className="btn btn-danger btn-xs"
                    onClick={(e) => showDeleteMenu(e, s)}
                    title="删除"
                  >
                    ✕
                  </button>
                </div>
              </div>
            )})
          )}
        </div>

        <div className="storage-settings">
          <div className="setting-row">
            <label>最大存储空间</label>
            <div className="setting-input">
              <input
                type="number" min="50" max="5000"
                value={settings.recordingsMaxSize}
                onChange={(e) => setSettings(s => ({ ...s, recordingsMaxSize: parseInt(e.target.value) || 500 }))}
              />
              <span className="unit">MB</span>
            </div>
          </div>
          <div className="setting-row">
            <label>保留天数</label>
            <div className="setting-input">
              <input
                type="number" min="1" max="365"
                value={settings.recordingsRetentionDays}
                onChange={(e) => setSettings(s => ({ ...s, recordingsRetentionDays: parseInt(e.target.value) || 7 }))}
              />
              <span className="unit">天</span>
            </div>
          </div>
        </div>

        <div className="storage-actions">
          <button className="btn btn-secondary btn-small" onClick={() => exportData('recordings')}>导出全部</button>
        </div>
      </div>

      {/* 监控日志 */}
      <div className="storage-section">
        <h3>监控操作日志</h3>
        <div className="storage-stats">
          <div className="stat-item">
            <span className="stat-label">占用空间</span>
            <span className="stat-value">{formatSize(stats.logs.size)}</span>
          </div>
          <div className="stat-item">
            <span className="stat-label">记录数</span>
            <span className="stat-value">{stats.logs.count} 条</span>
          </div>
        </div>

        <div className="storage-settings">
          <div className="setting-row">
            <label>最大存储空间</label>
            <div className="setting-input">
              <input
                type="number" min="10" max="1000"
                value={settings.logsMaxSize}
                onChange={(e) => setSettings(s => ({ ...s, logsMaxSize: parseInt(e.target.value) || 100 }))}
              />
              <span className="unit">MB</span>
            </div>
          </div>
          <div className="setting-row">
            <label>保留天数</label>
            <div className="setting-input">
              <input
                type="number" min="1" max="365"
                value={settings.logsRetentionDays}
                onChange={(e) => setSettings(s => ({ ...s, logsRetentionDays: parseInt(e.target.value) || 30 }))}
              />
              <span className="unit">天</span>
            </div>
          </div>
        </div>

        <div className="storage-actions">
          <button className="btn btn-secondary btn-small" onClick={() => exportData('logs')}>导出日志</button>
        </div>
      </div>

      <div className="storage-save">
        <button className="btn btn-primary" onClick={saveSettings} disabled={saving}>
          {saving ? '保存中...' : '保存设置'}
        </button>
      </div>

      {/* 删除时间范围菜单 - 使用 Portal 渲染到 body */}
      {deleteMenu && createPortal(
        <>
          <div className="delete-menu-overlay" onClick={() => setDeleteMenu(null)} />
          <div className="delete-menu" style={{ left: deleteMenu.x, top: deleteMenu.y }}>
            <div className="delete-menu-title">删除数据</div>
            {getTimeRanges(deleteMenu.duration).map(r => (
              <button
                key={r.minutes}
                className="delete-menu-item"
                onClick={() => deleteSessionRecording(deleteMenu.sessionId, r.minutes)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </>,
        document.body
      )}
    </div>
  );
}

/**
 * 存储管理组件
 * 管理终端历史回放和监控日志的存储设置
 */

import { useState, useEffect } from 'react';
import { useTranslation } from '../i18n';
import './StorageManager.css';

export default function StorageManager({ socket }) {
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

  const deleteSessionRecording = async (sessionId) => {
    if (!confirm('确定要删除该项目的历史记录吗？')) return;
    try {
      const res = await fetch(`/api/storage/recordings/${sessionId}`, { method: 'DELETE' });
      if (res.ok) {
        setMessage({ type: 'success', text: '已删除' });
        loadData();
      }
    } catch (err) {
      setMessage({ type: 'error', text: '删除失败' });
    }
    setTimeout(() => setMessage({ type: '', text: '' }), 3000);
  };

  const cleanData = async (type) => {
    if (!confirm(`确定要清理所有${type === 'recordings' ? '终端回放' : '监控日志'}数据吗？`)) return;
    try {
      const res = await fetch(`/api/storage/clean/${type}`, { method: 'POST' });
      if (res.ok) {
        setMessage({ type: 'success', text: '已清理' });
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
            <span>项目 ID</span>
            <span>大小</span>
            <span>时间范围</span>
            <span>操作</span>
          </div>
          {sessionRecordings.length === 0 ? (
            <div className="session-list-empty">暂无历史记录</div>
          ) : (
            sessionRecordings.map(s => (
              <div key={s.sessionId} className="session-item">
                <span className="session-id" title={s.sessionId}>
                  {s.sessionId.length > 12 ? s.sessionId.slice(0, 12) + '...' : s.sessionId}
                </span>
                <span className="session-size">{formatSize(s.size)}</span>
                <span className="session-time">{formatDate(s.startTime).split(' ')[0]}</span>
                <button
                  className="btn btn-danger btn-xs"
                  onClick={() => deleteSessionRecording(s.sessionId)}
                >
                  删除
                </button>
              </div>
            ))
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
          <button className="btn btn-danger btn-small" onClick={() => cleanData('recordings')}>清空全部</button>
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
          <button className="btn btn-danger btn-small" onClick={() => cleanData('logs')}>清空日志</button>
        </div>
      </div>

      <div className="storage-save">
        <button className="btn btn-primary" onClick={saveSettings} disabled={saving}>
          {saving ? '保存中...' : '保存设置'}
        </button>
      </div>
    </div>
  );
}

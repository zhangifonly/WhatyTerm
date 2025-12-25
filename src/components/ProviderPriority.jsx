import React, { useState, useEffect } from 'react';
import './ProviderPriority.css';

/**
 * 供应商优先级设置组件
 * 用于配置 API 错误时的供应商切换顺序
 */
function ProviderPriority() {
  const [providers, setProviders] = useState([]);
  const [priority, setPriority] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // 加载供应商列表和优先级配置
  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    try {
      const res = await fetch('/api/provider-priority');
      const data = await res.json();
      if (data.success) {
        setProviders(data.providers || []);
        setPriority(data.priority || []);
      }
    } catch (err) {
      console.error('加载供应商优先级失败:', err);
    } finally {
      setLoading(false);
    }
  };

  // 保存优先级配置
  const handleSave = async () => {
    setSaving(true);
    try {
      const res = await fetch('/api/provider-priority', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ priority })
      });
      const data = await res.json();
      if (data.success) {
        alert('保存成功');
      } else {
        alert(data.error || '保存失败');
      }
    } catch (err) {
      console.error('保存失败:', err);
      alert('保存失败');
    } finally {
      setSaving(false);
    }
  };

  // 移动供应商位置
  const moveProvider = (index, direction) => {
    const newPriority = [...priority];
    const newIndex = index + direction;
    if (newIndex < 0 || newIndex >= newPriority.length) return;

    [newPriority[index], newPriority[newIndex]] =
    [newPriority[newIndex], newPriority[index]];
    setPriority(newPriority);
  };

  // 添加供应商到优先级列表
  const addToPriority = (providerId) => {
    if (!priority.includes(providerId)) {
      setPriority([...priority, providerId]);
    }
  };

  // 从优先级列表移除
  const removeFromPriority = (providerId) => {
    setPriority(priority.filter(id => id !== providerId));
  };

  if (loading) {
    return <div className="provider-priority loading">加载中...</div>;
  }

  // 获取供应商名称
  const getProviderName = (id) => {
    const provider = providers.find(p => p.id === id);
    return provider?.name || id;
  };

  // 未添加到优先级的供应商
  const availableProviders = providers.filter(p => !priority.includes(p.id));

  return (
    <div className="provider-priority">
      <div className="priority-header">
        <h3>供应商切换顺序</h3>
        <p className="priority-desc">
          当 API 服务器不可用或余额不足时，系统将按此顺序自动切换供应商
        </p>
      </div>

      <div className="priority-list">
        {priority.length === 0 ? (
          <div className="empty-priority">
            暂未配置切换顺序，请从下方添加供应商
          </div>
        ) : (
          priority.map((id, index) => (
            <div key={id} className="priority-item">
              <span className="priority-order">{index + 1}</span>
              <span className="priority-name">{getProviderName(id)}</span>
              <span className="priority-id">({id})</span>
              <div className="priority-actions">
                <button
                  className="btn-move"
                  onClick={() => moveProvider(index, -1)}
                  disabled={index === 0}
                  title="上移"
                >
                  ↑
                </button>
                <button
                  className="btn-move"
                  onClick={() => moveProvider(index, 1)}
                  disabled={index === priority.length - 1}
                  title="下移"
                >
                  ↓
                </button>
                <button
                  className="btn-remove"
                  onClick={() => removeFromPriority(id)}
                  title="移除"
                >
                  ×
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {availableProviders.length > 0 && (
        <div className="available-providers">
          <h4>可用供应商</h4>
          <div className="provider-chips">
            {availableProviders.map(p => (
              <button
                key={p.id}
                className="provider-chip"
                onClick={() => addToPriority(p.id)}
              >
                + {p.name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="priority-footer">
        <button
          className="btn-primary"
          onClick={handleSave}
          disabled={saving}
        >
          {saving ? '保存中...' : '保存配置'}
        </button>
      </div>
    </div>
  );
}

export default ProviderPriority;

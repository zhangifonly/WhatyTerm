import React, { useState, useEffect } from 'react';
import './CliToolsManager.css';

/**
 * CLI 工具管理组件
 * 支持查看、添加、编辑和学习新的 CLI 工具
 */
function CliToolsManager() {
  const [tools, setTools] = useState([]);
  const [unknownProcesses, setUnknownProcesses] = useState([]);
  const [showAddForm, setShowAddForm] = useState(false);
  const [showUrlLearn, setShowUrlLearn] = useState(false);
  const [learnUrl, setLearnUrl] = useState('');
  const [learning, setLearning] = useState(false);
  const [editingTool, setEditingTool] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    processNames: '',
    startCommand: '',
    quitCommand: ''
  });

  // 加载 CLI 工具列表
  const loadTools = async () => {
    try {
      const res = await fetch('/api/cli-tools');
      const data = await res.json();
      if (data.success) {
        setTools(data.tools);
      }
    } catch (err) {
      console.error('加载 CLI 工具失败:', err);
    }
  };

  // 加载未知进程列表
  const loadUnknownProcesses = async () => {
    try {
      const res = await fetch('/api/cli-tools/learn/unknown');
      const data = await res.json();
      if (data.success) {
        setUnknownProcesses(data.processes);
      }
    } catch (err) {
      console.error('加载未知进程失败:', err);
    }
  };

  useEffect(() => {
    loadTools();
    loadUnknownProcesses();
  }, []);

  // 提交表单
  const handleSubmit = async (e) => {
    e.preventDefault();

    const toolData = {
      name: formData.name,
      processNames: formData.processNames.split(',').map(s => s.trim()).filter(Boolean),
      commands: {
        start: formData.startCommand || formData.name.toLowerCase(),
        quit: formData.quitCommand || 'exit'
      }
    };

    try {
      const url = editingTool
        ? `/api/cli-tools/${editingTool.id}`
        : '/api/cli-tools';
      const method = editingTool ? 'PUT' : 'POST';

      const res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(toolData)
      });

      const data = await res.json();
      if (data.success) {
        loadTools();
        resetForm();
      } else {
        alert(data.error || '操作失败');
      }
    } catch (err) {
      console.error('保存失败:', err);
      alert('保存失败');
    }
  };

  // 删除工具
  const handleDelete = async (id) => {
    if (!confirm('确定要删除这个 CLI 工具吗？')) return;

    try {
      const res = await fetch(`/api/cli-tools/${id}`, { method: 'DELETE' });
      const data = await res.json();
      if (data.success) {
        loadTools();
      } else {
        alert(data.error || '删除失败');
      }
    } catch (err) {
      console.error('删除失败:', err);
    }
  };

  // 学习未知进程
  const handleLearn = async (processName) => {
    const name = prompt('请输入工具名称:', processName);
    if (!name) return;

    try {
      const res = await fetch(`/api/cli-tools/learn/${encodeURIComponent(processName)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name })
      });

      const data = await res.json();
      if (data.success) {
        loadTools();
        loadUnknownProcesses();
      } else {
        alert(data.error || '学习失败');
      }
    } catch (err) {
      console.error('学习失败:', err);
    }
  };

  // 从 URL 自动学习
  const handleLearnFromUrl = async (e) => {
    e.preventDefault();
    if (!learnUrl) return;

    setLearning(true);
    try {
      const res = await fetch('/api/cli-tools/learn/url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: learnUrl })
      });

      const data = await res.json();
      if (data.success) {
        loadTools();
        setLearnUrl('');
        setShowUrlLearn(false);
        alert(`成功学习: ${data.tool.name}`);
      } else {
        alert(data.error || '学习失败');
      }
    } catch (err) {
      console.error('从 URL 学习失败:', err);
      alert('学习失败: ' + err.message);
    } finally {
      setLearning(false);
    }
  };

  // 编辑工具
  const handleEdit = (tool) => {
    setEditingTool(tool);
    setFormData({
      name: tool.name,
      processNames: tool.processNames.join(', '),
      startCommand: tool.commands?.start || '',
      quitCommand: tool.commands?.quit || ''
    });
    setShowAddForm(true);
  };

  // 重置表单
  const resetForm = () => {
    setShowAddForm(false);
    setEditingTool(null);
    setFormData({ name: '', processNames: '', startCommand: '', quitCommand: '' });
  };

  return (
    <div className="cli-tools-manager">
      <div className="cli-tools-header">
        <h3>CLI 工具管理</h3>
        <div style={{ display: 'flex', gap: '8px' }}>
          <button
            className="btn-secondary"
            onClick={() => { setShowUrlLearn(!showUrlLearn); setShowAddForm(false); }}
          >
            {showUrlLearn ? '取消' : '🌐 从网址学习'}
          </button>
          <button
            className="btn-primary"
            onClick={() => { setShowAddForm(!showAddForm); setShowUrlLearn(false); }}
          >
            {showAddForm ? '取消' : '+ 手动添加'}
          </button>
        </div>
      </div>

      {/* 从 URL 学习表单 */}
      {showUrlLearn && (
        <form className="add-tool-form" onSubmit={handleLearnFromUrl}>
          <h4>从网址自动学习</h4>
          <p style={{ fontSize: '12px', color: '#888', marginBottom: '12px' }}>
            输入 CLI 工具的官网或文档地址，AI 将自动分析并提取配置信息
          </p>
          <div className="form-group">
            <label>CLI 工具网址</label>
            <input
              type="url"
              value={learnUrl}
              onChange={e => setLearnUrl(e.target.value)}
              placeholder="如: https://factory.ai/product/cli"
              required
            />
          </div>
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={() => setShowUrlLearn(false)}>
              取消
            </button>
            <button type="submit" className="btn-primary" disabled={learning}>
              {learning ? '学习中...' : '开始学习'}
            </button>
          </div>
        </form>
      )}

      {/* 添加/编辑表单 */}
      {showAddForm && (
        <form className="add-tool-form" onSubmit={handleSubmit}>
          <h4>{editingTool ? '编辑工具' : '添加新工具'}</h4>
          <div className="form-group">
            <label>工具名称</label>
            <input
              type="text"
              value={formData.name}
              onChange={e => setFormData({...formData, name: e.target.value})}
              placeholder="如: Factory AI"
              required
            />
          </div>
          <div className="form-group">
            <label>进程名（多个用逗号分隔）</label>
            <input
              type="text"
              value={formData.processNames}
              onChange={e => setFormData({...formData, processNames: e.target.value})}
              placeholder="如: factory, factory-cli"
              required
            />
          </div>
          <div className="form-group">
            <label>启动命令</label>
            <input
              type="text"
              value={formData.startCommand}
              onChange={e => setFormData({...formData, startCommand: e.target.value})}
              placeholder="如: factory"
            />
          </div>
          <div className="form-group">
            <label>退出命令</label>
            <input
              type="text"
              value={formData.quitCommand}
              onChange={e => setFormData({...formData, quitCommand: e.target.value})}
              placeholder="如: exit 或 /quit"
            />
          </div>
          <div className="form-actions">
            <button type="button" className="btn-secondary" onClick={resetForm}>
              取消
            </button>
            <button type="submit" className="btn-primary">
              {editingTool ? '保存' : '添加'}
            </button>
          </div>
        </form>
      )}

      {/* 工具列表 */}
      <div className="cli-tools-list">
        {tools.map(tool => (
          <div
            key={tool.id}
            className={`cli-tool-item ${tool.builtin ? 'builtin' : 'custom'}`}
          >
            <div className="cli-tool-info">
              <div className="cli-tool-name">
                {tool.name}
                {tool.builtin && <span style={{color: '#4a9eff', marginLeft: 8, fontSize: 11}}>内置</span>}
              </div>
              <div className="cli-tool-processes">
                {tool.processNames.map(name => (
                  <span key={name} className="process-tag">{name}</span>
                ))}
              </div>
            </div>
            <div className="cli-tool-actions">
              {!tool.builtin && (
                <>
                  <button className="btn-icon" onClick={() => handleEdit(tool)} title="编辑">
                    ✏️
                  </button>
                  <button className="btn-icon danger" onClick={() => handleDelete(tool.id)} title="删除">
                    🗑️
                  </button>
                </>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 未知进程学习区域 */}
      {unknownProcesses.length > 0 && (
        <div className="unknown-processes">
          <h4>发现的未知进程（可学习）</h4>
          {unknownProcesses.map(proc => (
            <div key={proc.processName} className="unknown-process-item">
              <div className="unknown-process-info">
                <div className="unknown-process-name">{proc.processName}</div>
                <div className="unknown-process-stats">
                  检测到 {proc.count} 次 · {proc.sessionCount} 个会话
                </div>
              </div>
              <button className="btn-learn" onClick={() => handleLearn(proc.processName)}>
                学习
              </button>
            </div>
          ))}
        </div>
      )}

      {tools.length === 0 && (
        <div className="empty-state">暂无 CLI 工具配置</div>
      )}
    </div>
  );
}

export default CliToolsManager;

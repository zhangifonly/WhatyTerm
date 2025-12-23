import React, { useState, useEffect } from 'react';
import './ClaudeConfigManager.css';
import { toast } from './Toast';

/**
 * Claude Config Manager - 1:1 完全复制 CC Switch 的界面
 * 基于 cc-switch/internal/web/assets/js/main.js
 */
export default function ClaudeConfigManager({ socket }) {
  const [activeTab, setActiveTab] = useState('profiles');
  const [profiles, setProfiles] = useState([]);
  const [templates, setTemplates] = useState([]);
  const [currentProfile, setCurrentProfile] = useState(null);
  const [isEmptyMode, setIsEmptyMode] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      await Promise.all([loadProfiles(), loadTemplates(), loadCurrent()]);
    } catch (error) {
      console.error('Failed to load data:', error);
    } finally {
      setLoading(false);
    }
  };

  const loadProfiles = async () => {
    try {
      const res = await fetch('/api/claude/profiles');
      const data = await res.json();
      if (data.success) setProfiles(data.data.profiles || []);
    } catch (error) {
      console.error('Failed to load profiles:', error);
    }
  };

  const loadTemplates = async () => {
    try {
      const res = await fetch('/api/claude/templates');
      const data = await res.json();
      if (data.success) setTemplates(data.data.templates || []);
    } catch (error) {
      console.error('Failed to load templates:', error);
    }
  };

  const loadCurrent = async () => {
    try {
      const res = await fetch('/api/claude/current');
      const data = await res.json();
      if (data.success) {
        setCurrentProfile(data.data.current);
        setIsEmptyMode(data.data.empty_mode);
      }
    } catch (error) {
      console.error('Failed to load current config:', error);
    }
  };

  const handleSwitch = async (profileName) => {
    try {
      const res = await fetch('/api/claude/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: profileName })
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`已切换到: ${profileName}`);
        await loadData();
      } else {
        toast.error(`切换失败: ${data.error}`);
      }
    } catch (error) {
      toast.error(`切换失败: ${error.message}`);
    }
  };

  const handleDelete = async (profileName) => {
    try {
      const res = await fetch(`/api/claude/profiles/${encodeURIComponent(profileName)}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`已删除: ${profileName}`);
        await loadData();
      } else {
        toast.error(`删除失败: ${data.error}`);
      }
    } catch (error) {
      toast.error(`删除失败: ${error.message}`);
    }
  };

  const handleView = async (profileName) => {
    try {
      const res = await fetch(`/api/claude/profiles/${encodeURIComponent(profileName)}`);
      const data = await res.json();
      if (data.success) {
        console.log(`Profile ${profileName}:`, data.data.content);
        toast.info(`查看控制台获取 ${profileName} 配置详情`);
      }
    } catch (error) {
      toast.error(`查看失败: ${error.message}`);
    }
  };

  const handleEdit = (profileName) => {
    toast.info(`编辑功能开发中`);
  };

  const handleCreateProfile = async () => {
    const name = prompt('Enter profile name:');
    if (!name) return;
    const template = templates.length > 0 ? templates[0] : 'default';
    try {
      const res = await fetch('/api/claude/profiles', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, template })
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`已创建: ${name}`);
        await loadData();
      } else {
        toast.error(`创建失败: ${data.error}`);
      }
    } catch (error) {
      toast.error(`创建失败: ${error.message}`);
    }
  };

  const handleCreateFromTemplate = async (templateName) => {
    const profileName = prompt(`Create profile from template '${templateName}'. Enter profile name:`);
    if (!profileName) return;
    try {
      const res = await fetch(`/api/claude/templates/${encodeURIComponent(templateName)}/copy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dest_name: profileName, to_config: true })
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`已从模板创建: ${profileName}`);
        await loadData();
        setActiveTab('profiles');
      } else {
        toast.error(`创建失败: ${data.error}`);
      }
    } catch (error) {
      toast.error(`创建失败: ${error.message}`);
    }
  };

  const handleEmptyMode = async () => {
    try {
      const res = await fetch('/api/claude/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile: '' })
      });
      const data = await res.json();
      if (data.success) {
        toast.success('已切换到空模式');
        await loadData();
      } else {
        toast.error(`切换失败: ${data.error}`);
      }
    } catch (error) {
      toast.error(`切换失败: ${error.message}`);
    }
  };

  const handleRestore = async () => {
    try {
      const res = await fetch('/api/claude/switch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restore: true })
      });
      const data = await res.json();
      if (data.success) {
        toast.success('配置已恢复');
        await loadData();
      } else {
        toast.error(`恢复失败: ${data.error}`);
      }
    } catch (error) {
      toast.error(`恢复失败: ${error.message}`);
    }
  };

  const handleViewTemplate = async (templateName) => {
    try {
      const res = await fetch(`/api/claude/templates/${encodeURIComponent(templateName)}`);
      const data = await res.json();
      if (data.success) {
        console.log(`Template ${templateName}:`, data.data.content);
        toast.info(`查看控制台获取 ${templateName} 模板详情`);
      }
    } catch (error) {
      toast.error(`查看失败: ${error.message}`);
    }
  };

  const handleEditTemplate = (templateName) => {
    toast.info('编辑功能开发中');
  };

  const handleCopyTemplate = async (templateName) => {
    const newName = prompt(`Copy template '${templateName}'. Enter new template name:`);
    if (!newName) return;
    toast.info('复制功能开发中');
  };

  const handleDeleteTemplate = async (templateName) => {
    try {
      const res = await fetch(`/api/claude/templates/${encodeURIComponent(templateName)}`, {
        method: 'DELETE'
      });
      const data = await res.json();
      if (data.success) {
        toast.success(`已删除模板: ${templateName}`);
        await loadData();
      } else {
        toast.error(`删除失败: ${data.error}`);
      }
    } catch (error) {
      toast.error(`删除失败: ${error.message}`);
    }
  };

  const handleCreateTemplate = () => {
    const name = prompt('Enter template name:');
    if (!name) return;
    toast.info('创建模板功能开发中');
  };

  const handleExportConfigs = () => {
    toast.info('导出功能开发中');
  };

  const handleImportConfigs = () => {
    toast.info('导入功能开发中');
  };

  const handleRunTest = () => {
    toast.info('API 测试功能开发中');
  };

  // 渲染 Profiles 内容
  const renderProfilesContent = () => {
    if (loading) {
      return (
        <div className="loading">
          <div className="spinner"></div>
          LOADING PROFILES...
        </div>
      );
    }

    if (profiles.length === 0) {
      return (
        <div className="empty-state">
          <h3>No configurations found</h3>
          <p>Create your first configuration to get started.</p>
          <button className="btn btn-primary mt-4" onClick={handleCreateProfile}>
            Create Configuration
          </button>
        </div>
      );
    }

    return (
      <>
        <div className="flex justify-between items-center mb-4">
          <h2>Available Configurations</h2>
          <div className="flex gap-2">
            {isEmptyMode ? (
              <button className="btn btn-success" onClick={handleRestore}>Restore Config</button>
            ) : (
              <button className="btn btn-secondary" onClick={handleEmptyMode}>Empty Mode</button>
            )}
            <button className="btn btn-primary" onClick={handleCreateProfile}>New Config</button>
          </div>
        </div>
        {isEmptyMode && (
          <div className="status status-offline">⚠️ Empty mode active (no configuration active)</div>
        )}
        <div className="profile-list">
          {profiles.map(profile => {
            const isCurrent = profile.name === currentProfile && !isEmptyMode;
            return (
              <div key={profile.name} className={`profile-item ${isCurrent ? 'current' : ''}`}>
                <div className="profile-info">
                  <div className="profile-name">{profile.name}</div>
                  {isCurrent && <div className="profile-status current">Current</div>}
                </div>
                <div className="profile-actions">
                  {!isCurrent && (
                    <button className="btn btn-success" onClick={() => handleSwitch(profile.name)}>Use</button>
                  )}
                  <button className="btn btn-outline" onClick={() => handleView(profile.name)}>View</button>
                  <button className="btn btn-warning" onClick={() => handleEdit(profile.name)}>Edit</button>
                  <button className="btn btn-danger" onClick={() => handleDelete(profile.name)}>Delete</button>
                </div>
              </div>
            );
          })}
        </div>
      </>
    );
  };

  // 渲染 Templates 内容
  const renderTemplatesContent = () => {
    if (loading) {
      return (
        <div className="loading">
          <div className="spinner"></div>
          LOADING TEMPLATES...
        </div>
      );
    }

    if (templates.length === 0) {
      return (
        <div className="empty-state">
          <h3>No templates found</h3>
          <p>Create your first template to get started.</p>
          <button className="btn btn-primary mt-4" onClick={handleCreateTemplate}>
            Create Template
          </button>
        </div>
      );
    }

    return (
      <>
        <div className="flex justify-between items-center mb-4">
          <h2>Available Templates</h2>
          <div className="flex gap-2">
            <button className="btn btn-secondary" onClick={loadData}>Refresh</button>
            <button className="btn btn-primary" onClick={handleCreateTemplate}>+ Create Template</button>
          </div>
        </div>
        <div className="profile-list">
          {templates.map(template => {
            const isDefault = template === 'default';
            return (
              <div key={template} className="profile-item template-item">
                <div className="profile-info">
                  <div className="profile-name">{template}</div>
                  {isDefault && <div className="profile-status system">System Default</div>}
                </div>
                <div className="profile-actions">
                  <button className="btn btn-outline" onClick={() => handleViewTemplate(template)}>View</button>
                  {!isDefault && (
                    <button className="btn btn-warning" onClick={() => handleEditTemplate(template)}>Edit</button>
                  )}
                  {!isDefault && (
                    <button className="btn btn-secondary" onClick={() => handleCopyTemplate(template)}>Copy</button>
                  )}
                  {!isDefault && (
                    <button className="btn btn-danger" onClick={() => handleDeleteTemplate(template)}>Delete</button>
                  )}
                  <button className="btn btn-primary" onClick={() => handleCreateFromTemplate(template)}>Create Config</button>
                </div>
              </div>
            );
          })}
        </div>
      </>
    );
  };

  // 渲染 Settings 内容
  const renderSettingsContent = () => {
    if (loading) {
      return (
        <div className="loading">
          <div className="spinner"></div>
          LOADING SETTINGS...
        </div>
      );
    }

    return (
      <>
        <h2>Settings & Configuration</h2>
        <div className="form-group">
          <label className="form-label">Current Profile</label>
          <p>{isEmptyMode ? 'None (Empty Mode)' : currentProfile || 'None'}</p>
        </div>
        <div className="form-group">
          <label className="form-label">Configuration Directory</label>
          <p><code>~/.claude/profiles/</code></p>
        </div>
        <div className="form-group">
          <button className="btn btn-primary" onClick={handleExportConfigs}>Export All Configs</button>
          <button className="btn btn-outline" onClick={handleImportConfigs}>Import Configs</button>
        </div>
      </>
    );
  };

  // 渲染 Test 内容
  const renderTestContent = () => {
    if (loading) {
      return (
        <div className="loading">
          <div className="spinner"></div>
          INITIALIZING TEST INTERFACE...
        </div>
      );
    }

    return (
      <>
        <h2>API Connectivity Testing</h2>
        <div className="form-group">
          <label className="form-label">Profile to Test</label>
          <select className="form-input">
            <option value="">Current Configuration</option>
            {profiles.map(p => (
              <option key={p.name} value={p.name}>{p.name}</option>
            ))}
          </select>
        </div>
        <div className="form-group">
          <label>
            <input type="checkbox" /> Quick Test
          </label>
        </div>
        <div className="form-group">
          <button className="btn btn-primary" onClick={handleRunTest}>
            Run Test
          </button>
        </div>
      </>
    );
  };

  return (
    <div className="claude-config-manager">
      {/* Header */}
      <header className="header">
        <div className="container">
          <h1>🔧 CC-SWITCH</h1>
          <p className="subtitle">CLAUDE CODE CONFIGURATION MANAGER v1.0.0</p>
        </div>
      </header>

      {/* Pixel art decorative border */}
      <div style={{height: '8px', background: 'repeating-linear-gradient(to right, var(--pixel-teal) 0px, var(--pixel-teal) 8px, var(--pixel-purple) 8px, var(--pixel-purple) 16px, var(--pixel-pink) 16px, var(--pixel-pink) 24px, var(--pixel-blue) 24px, var(--pixel-blue) 32px)'}}></div>

      <main className="main">
        <div className="container">
          {/* System Status Bar */}
          <div style={{background: 'var(--dark-bg)', color: 'var(--text-white)', padding: '0.75rem 1.5rem', marginBottom: '2rem', fontFamily: "'Press Start 2P', monospace", fontSize: '0.6rem', letterSpacing: '1px', boxShadow: 'var(--shadow)'}}>
            <span style={{color: 'var(--pixel-green)'}}>●</span> SYSTEM ONLINE
            <span style={{marginLeft: '2rem', color: 'var(--pixel-teal)'}}>●</span> PROFILES READY
            <span style={{marginLeft: '2rem', color: 'var(--pixel-yellow)'}}>●</span> STANDBY
            <span style={{float: 'right'}}>2025.09.11 | BUILD.001</span>
          </div>

          {/* Navigation Tabs */}
          <nav className="nav-tabs">
            <button className={`nav-tab ${activeTab === 'profiles' ? 'active' : ''}`} onClick={() => setActiveTab('profiles')}>
              <span style={{marginRight: '0.5rem'}}>📋</span>PROFILES
            </button>
            <button className={`nav-tab ${activeTab === 'templates' ? 'active' : ''}`} onClick={() => setActiveTab('templates')}>
              <span style={{marginRight: '0.5rem'}}>📋</span>TEMPLATES
            </button>
            <button className={`nav-tab ${activeTab === 'settings' ? 'active' : ''}`} onClick={() => setActiveTab('settings')}>
              <span style={{marginRight: '0.5rem'}}>⚙️</span>SETTINGS
            </button>
            <button className={`nav-tab ${activeTab === 'test' ? 'active' : ''}`} onClick={() => setActiveTab('test')}>
              <span style={{marginRight: '0.5rem'}}>🔍</span>API TEST
            </button>
          </nav>

          {/* Profiles Section */}
          <section id="profiles-section" className={`section ${activeTab === 'profiles' ? 'active' : ''}`}>
            <div className="section-header">
              <h2>📋 Configuration Profiles</h2>
            </div>
            <div className="section-content">
              {renderProfilesContent()}
            </div>
          </section>

          {/* Templates Section */}
          <section id="templates-section" className={`section ${activeTab === 'templates' ? 'active' : ''}`}>
            <div className="section-header">
              <h2>📋 Template Management</h2>
            </div>
            <div className="section-content">
              {renderTemplatesContent()}
            </div>
          </section>

          {/* Settings Section */}
          <section id="settings-section" className={`section ${activeTab === 'settings' ? 'active' : ''}`}>
            <div className="section-header">
              <h2>⚙️ System Settings</h2>
            </div>
            <div className="section-content">
              {renderSettingsContent()}
            </div>
          </section>

          {/* Test Section */}
          <section id="test-section" className={`section ${activeTab === 'test' ? 'active' : ''}`}>
            <div className="section-header">
              <h2>🔍 API Connectivity Test</h2>
            </div>
            <div className="section-content">
              {renderTestContent()}
            </div>
          </section>
        </div>
      </main>

      {/* Pixel art footer */}
      <footer style={{background: 'var(--dark-bg)', color: 'var(--text-white)', padding: '1rem 0', marginTop: '4rem'}}>
        <div className="container" style={{textAlign: 'center'}}>
          <p style={{fontFamily: "'Press Start 2P', monospace", fontSize: '0.6rem', letterSpacing: '1px'}}>
            CC-SWITCH PIXEL INTERFACE v1.0.0 |
            <span style={{color: 'var(--pixel-orange)'}}> ANTHROPIC</span> |
            <span style={{color: 'var(--pixel-teal)'}}> CLAUDE CODE</span>
          </p>
        </div>
      </footer>
    </div>
  );
}

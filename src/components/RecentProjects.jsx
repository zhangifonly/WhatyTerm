import React, { useState, useEffect } from 'react';
import { useTranslation } from '../i18n';
import './RecentProjects.css';

const RecentProjects = ({ socket, onOpenProject, compact = false }) => {
  const { t } = useTranslation();
  const [projects, setProjects] = useState({ claude: [], codex: [], gemini: [] });
  const [activeTab, setActiveTab] = useState('claude');
  const [loading, setLoading] = useState(true);
  const [expandedSections, setExpandedSections] = useState({});

  useEffect(() => {
    if (!socket) return;

    socket.emit('recentProjects:get');

    const handleList = (data) => {
      setProjects(data);
      setLoading(false);
      // 自动选择有项目的第一个 tab
      if (data.claude?.length > 0) setActiveTab('claude');
      else if (data.codex?.length > 0) setActiveTab('codex');
      else if (data.gemini?.length > 0) setActiveTab('gemini');
    };

    socket.on('recentProjects:list', handleList);

    return () => {
      socket.off('recentProjects:list', handleList);
    };
  }, [socket]);

  const formatTimeAgo = (timestamp) => {
    const now = Date.now();
    const diff = now - timestamp;
    const minutes = Math.floor(diff / 60000);
    const hours = Math.floor(diff / 3600000);
    const days = Math.floor(hours / 24);

    if (minutes < 1) return t('recentProjects.timeAgo.justNow');
    if (minutes < 60) return t('recentProjects.timeAgo.minutes', { count: minutes });
    if (hours < 24) return t('recentProjects.timeAgo.hours', { count: hours });
    return t('recentProjects.timeAgo.days', { count: days });
  };

  const handleOpenProject = (project) => {
    if (onOpenProject) {
      onOpenProject(project);
    }
  };

  const totalCount = (projects.claude?.length || 0) +
                     (projects.codex?.length || 0) +
                     (projects.gemini?.length || 0);

  if (loading) {
    // 骨架屏 - 改善感知加载速度
    if (compact) {
      return (
        <div className="recent-projects compact skeleton-loading">
          {[1, 2, 3].map(i => (
            <div key={i} className="skeleton-item">
              <div className="skeleton-line skeleton-name"></div>
              <div className="skeleton-line skeleton-path"></div>
            </div>
          ))}
        </div>
      );
    }
    return (
      <div className="recent-projects loading">
        <div className="skeleton-item">
          <div className="skeleton-line skeleton-name"></div>
          <div className="skeleton-line skeleton-path"></div>
        </div>
      </div>
    );
  }

  if (totalCount === 0) {
    return null;
  }

  // 合并所有项目并按时间排序（用于 compact 模式）
  const allProjects = [
    ...(projects.claude || []),
    ...(projects.codex || []),
    ...(projects.gemini || [])
  ].sort((a, b) => b.lastUsed - a.lastUsed);

  const currentProjects = projects[activeTab] || [];

  // 切换展开/收起
  const toggleExpand = (aiType) => {
    setExpandedSections(prev => ({
      ...prev,
      [aiType]: !prev[aiType]
    }));
  };

  // Compact 模式：VS Code 风格，分类显示 Claude/Codex/Gemini 各最多 5 个
  if (compact) {
    const aiTypes = [
      { key: 'claude', label: 'Claude', data: projects.claude || [] },
      { key: 'codex', label: 'Codex', data: projects.codex || [] },
      { key: 'gemini', label: 'Gemini', data: projects.gemini || [] }
    ].filter(ai => ai.data.length > 0);

    return (
      <div className="recent-projects compact">
        {aiTypes.map(ai => {
          const isExpanded = expandedSections[ai.key];
          const displayItems = isExpanded ? ai.data : ai.data.slice(0, 5);
          const hasMore = ai.data.length > 5;

          return (
            <div key={ai.key} className="compact-section">
              <div className="compact-section-header">
                <span className={`compact-ai-label ${ai.key}`}>{ai.label}</span>
                <span className="compact-count">({ai.data.length})</span>
              </div>
              <ul className="compact-list">
                {displayItems.map((project, index) => (
                  <li
                    key={`${project.aiType}-${project.path}-${index}`}
                    className="compact-item"
                    onClick={() => handleOpenProject(project)}
                    title={project.path}
                  >
                    <div className="compact-item-main">
                      <span className="compact-name">{project.name}</span>
                      {project.description && (
                        <span className="compact-desc">{project.description}</span>
                      )}
                    </div>
                    <span className="compact-path">{project.path}</span>
                  </li>
                ))}
              </ul>
              {hasMore && (
                <button
                  className="compact-more-btn"
                  onClick={() => toggleExpand(ai.key)}
                >
                  {isExpanded
                    ? t('recentProjects.collapse', '收起')
                    : `${t('recentProjects.showMore', '更多...')} (${ai.data.length - 5})`
                  }
                </button>
              )}
            </div>
          );
        })}
      </div>
    );
  }

  // 完整模式：带标签页的卡片列表
  return (
    <div className="recent-projects">
      <div className="recent-projects-header">
        <h3>
          {t('recentProjects.title')}
          <span className="count">{totalCount}</span>
        </h3>
      </div>

      <div className="recent-projects-tabs">
        {projects.claude?.length > 0 && (
          <button
            className={`tab-btn claude ${activeTab === 'claude' ? 'active' : ''}`}
            onClick={() => setActiveTab('claude')}
          >
            Claude ({projects.claude.length})
          </button>
        )}
        {projects.codex?.length > 0 && (
          <button
            className={`tab-btn codex ${activeTab === 'codex' ? 'active' : ''}`}
            onClick={() => setActiveTab('codex')}
          >
            Codex ({projects.codex.length})
          </button>
        )}
        {projects.gemini?.length > 0 && (
          <button
            className={`tab-btn gemini ${activeTab === 'gemini' ? 'active' : ''}`}
            onClick={() => setActiveTab('gemini')}
          >
            Gemini ({projects.gemini.length})
          </button>
        )}
      </div>

      <div className="recent-projects-list">
        {currentProjects.map((project, index) => (
          <div
            key={`${project.aiType}-${project.path}-${index}`}
            className="project-card"
            onClick={() => handleOpenProject(project)}
          >
            <div className="project-info">
              <div className="project-name">
                <span className="name">{project.name}</span>
                <span className={`ai-badge ${project.aiType}`}>
                  {project.aiType}
                </span>
              </div>
              <div className="project-path" title={project.path}>
                {project.path}
              </div>
              <div className="project-time">
                {formatTimeAgo(project.lastUsed)}
              </div>
            </div>
            <div className="project-action">
              <button className="btn-continue">
                {t('recentProjects.continue')}
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

export default RecentProjects;

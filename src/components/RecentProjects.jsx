import React, { useState, useEffect } from 'react';
import { useTranslation } from '../i18n';
import { matchPinyin } from '../utils/pinyin';
import './RecentProjects.css';

const RecentProjects = ({ socket, onOpenProject, onPlayback, compact = false }) => {
  const { t } = useTranslation();
  const [projects, setProjects] = useState({ claude: [], codex: [], gemini: [], grok: [] });
  const [activeTab, setActiveTab] = useState('claude');
  const [loading, setLoading] = useState(true);
  const [expandedSections, setExpandedSections] = useState({});
  const [query, setQuery] = useState('');

  // 项目命中搜索：名称/路径/描述任一（支持中文原文、英文、拼音首字母如 xj→心镜）
  const projectMatches = (p) =>
    matchPinyin(p.name, query) ||
    matchPinyin(p.path, query) ||
    matchPinyin(p.description, query);

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
      else if (data.grok?.length > 0) setActiveTab('grok');
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

  const handlePlayback = (project, e) => {
    e.stopPropagation(); // 阻止触发 handleOpenProject
    if (onPlayback) {
      onPlayback(project.path);
    }
  };

  const totalCount = (projects.claude?.length || 0) +
                     (projects.codex?.length || 0) +
                     (projects.gemini?.length || 0) +
                     (projects.grok?.length || 0);

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
    ...(projects.gemini || []),
    ...(projects.grok || [])
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
      { key: 'claude', label: 'Claude', data: (projects.claude || []).filter(projectMatches) },
      { key: 'codex', label: 'Codex', data: (projects.codex || []).filter(projectMatches) },
      { key: 'gemini', label: 'Gemini', data: (projects.gemini || []).filter(projectMatches) },
      { key: 'grok', label: 'Grok', data: (projects.grok || []).filter(projectMatches) }
    ].filter(ai => ai.data.length > 0);

    return (
      <div className="recent-projects compact">
        <div className="recent-search">
          <span className="recent-search-icon">🔍</span>
          <input
            type="text"
            className="recent-search-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('recentProjects.searchPlaceholder', '搜索项目（支持拼音首字母，如 xj）')}
          />
          {query && (
            <button className="recent-search-clear" onClick={() => setQuery('')} title={t('common.clear', '清除')}>×</button>
          )}
        </div>
        {aiTypes.length === 0 && (
          <div className="recent-search-empty">{t('recentProjects.noMatch', '没有匹配的项目')}</div>
        )}
        {aiTypes.map(ai => {
          // 搜索时展示全部匹配项（不受默认 5 条限制），避免命中项被折叠
          const isExpanded = expandedSections[ai.key] || !!query.trim();
          const displayItems = isExpanded ? ai.data : ai.data.slice(0, 5);
          const hasMore = !query.trim() && ai.data.length > 5;

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
                    <div className="compact-item-actions">
                      {onPlayback && (
                        <button
                          className="compact-playback-btn"
                          onClick={(e) => handlePlayback(project, e)}
                          title={t('recentProjects.playback', '回放')}
                        >
                          ▶
                        </button>
                      )}
                      <span className="compact-path">{project.path}</span>
                    </div>
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
        {projects.grok?.length > 0 && (
          <button
            className={`tab-btn grok ${activeTab === 'grok' ? 'active' : ''}`}
            onClick={() => setActiveTab('grok')}
          >
            Grok ({projects.grok.length})
          </button>
        )}
      </div>

      <div className="recent-search">
        <span className="recent-search-icon">🔍</span>
        <input
          type="text"
          className="recent-search-input"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('recentProjects.searchPlaceholder', '搜索项目（支持拼音首字母，如 xj）')}
        />
        {query && (
          <button className="recent-search-clear" onClick={() => setQuery('')} title={t('common.clear', '清除')}>×</button>
        )}
      </div>

      <div className="recent-projects-list">
        {currentProjects.filter(projectMatches).map((project, index) => (
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
              {onPlayback && (
                <button
                  className="btn-playback"
                  onClick={(e) => handlePlayback(project, e)}
                  title={t('recentProjects.playback', '回放')}
                >
                  ▶
                </button>
              )}
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

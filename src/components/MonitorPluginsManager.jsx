import React, { useState, useEffect } from 'react';

/**
 * 监控插件管理器组件
 * 显示所有可用的监控策略插件及其阶段信息
 */
export default function MonitorPluginsManager() {
  const [plugins, setPlugins] = useState([]);
  const [loading, setLoading] = useState(true);
  const [expandedPlugin, setExpandedPlugin] = useState(null);

  useEffect(() => {
    fetchPlugins();
  }, []);

  const fetchPlugins = async () => {
    try {
      const res = await fetch('/api/monitor-plugins');
      const data = await res.json();
      if (data.plugins) {
        setPlugins(data.plugins);
      }
    } catch (err) {
      console.error('加载监控插件失败:', err);
    } finally {
      setLoading(false);
    }
  };

  // 插件图标映射
  const pluginIcons = {
    'fullstack-dev': '🚀',
    'paper-writing': '📝',
    'app-dev': '💻',
    'data-analysis': '📊',
    'deployment': '🔧',
    'code-review': '🔍',
    'refactoring': '♻️',
    'bug-fix': '🐛',
    'scientific-research': '🔬',
    'tdd-development': '🧪',
    'frontend-design': '🎨',
    'api-integration': '🔗',
    'security-audit': '🛡️',
    'document-processing': '📄',
    'plan-execution': '📋',
    'default': '⚙️'
  };

  // 插件颜色映射
  const pluginColors = {
    'fullstack-dev': '#8b5cf6',  // 紫色
    'paper-writing': '#f59e0b',  // 橙色
    'app-dev': '#10b981',        // 绿色
    'data-analysis': '#3b82f6',  // 蓝色
    'deployment': '#ef4444',     // 红色
    'code-review': '#06b6d4',    // 青色
    'refactoring': '#84cc16',    // 黄绿色
    'bug-fix': '#f97316',        // 橙红色
    'scientific-research': '#a855f7',  // 紫罗兰
    'tdd-development': '#22c55e',      // 翠绿色
    'frontend-design': '#ec4899',      // 粉色
    'api-integration': '#0ea5e9',      // 天蓝色
    'security-audit': '#dc2626',       // 深红色
    'document-processing': '#64748b',  // 石板灰
    'plan-execution': '#eab308',       // 金黄色
    'default': '#6b7280'               // 灰色
  };

  if (loading) {
    return (
      <div style={{ padding: '20px', textAlign: 'center', color: '#888' }}>
        加载中...
      </div>
    );
  }

  return (
    <div style={{ padding: '20px' }}>
      <div style={{ marginBottom: '20px' }}>
        <h3 style={{ margin: '0 0 8px 0', fontSize: '18px', color: '#fff' }}>
          监控策略插件
        </h3>
        <p style={{ margin: 0, fontSize: '13px', color: '#888' }}>
          根据项目类型自动选择合适的监控策略，每个策略包含多个开发阶段，提供专业的监控指令
        </p>
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {plugins.map(plugin => (
          <div
            key={plugin.id}
            style={{
              background: '#1a1a2e',
              borderRadius: '8px',
              border: `2px solid ${expandedPlugin === plugin.id ? pluginColors[plugin.id] || '#444' : '#333'}`,
              overflow: 'hidden',
              transition: 'border-color 0.2s'
            }}
          >
            {/* 插件头部 */}
            <div
              onClick={() => setExpandedPlugin(expandedPlugin === plugin.id ? null : plugin.id)}
              style={{
                padding: '16px',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                gap: '12px',
                background: expandedPlugin === plugin.id ? 'rgba(255,255,255,0.03)' : 'transparent'
              }}
            >
              <span style={{ fontSize: '24px' }}>
                {pluginIcons[plugin.id] || '📦'}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                  <span style={{
                    fontSize: '15px',
                    fontWeight: 'bold',
                    color: pluginColors[plugin.id] || '#fff'
                  }}>
                    {plugin.name}
                  </span>
                  <span style={{
                    fontSize: '10px',
                    padding: '2px 6px',
                    background: '#333',
                    borderRadius: '4px',
                    color: '#888'
                  }}>
                    v{plugin.version}
                  </span>
                  <span style={{
                    fontSize: '10px',
                    padding: '2px 6px',
                    background: pluginColors[plugin.id] + '20',
                    borderRadius: '4px',
                    color: pluginColors[plugin.id]
                  }}>
                    {plugin.phases?.length || 0} 阶段
                  </span>
                </div>
                <p style={{
                  margin: 0,
                  fontSize: '12px',
                  color: '#888',
                  lineHeight: '1.4'
                }}>
                  {plugin.description}
                </p>
              </div>
              <span style={{
                color: '#666',
                transform: expandedPlugin === plugin.id ? 'rotate(180deg)' : 'rotate(0)',
                transition: 'transform 0.2s'
              }}>
                ▼
              </span>
            </div>

            {/* 展开的阶段列表 */}
            {expandedPlugin === plugin.id && plugin.phases && (
              <div style={{
                padding: '0 16px 16px 16px',
                borderTop: '1px solid #333'
              }}>
                <div style={{
                  marginTop: '12px',
                  marginBottom: '8px',
                  fontSize: '12px',
                  color: '#888',
                  fontWeight: 'bold'
                }}>
                  开发阶段流程
                </div>
                <div style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: '8px'
                }}>
                  {plugin.phases.map((phase, index) => (
                    <div
                      key={phase.id}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: '6px'
                      }}
                    >
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                        width: '20px',
                        height: '20px',
                        borderRadius: '50%',
                        background: pluginColors[plugin.id] || '#666',
                        color: '#fff',
                        fontSize: '11px',
                        fontWeight: 'bold'
                      }}>
                        {index + 1}
                      </span>
                      <span style={{
                        padding: '4px 10px',
                        background: '#252535',
                        borderRadius: '4px',
                        fontSize: '12px',
                        color: '#ccc'
                      }}>
                        {phase.name}
                      </span>
                      {index < plugin.phases.length - 1 && (
                        <span style={{ color: '#444', fontSize: '12px' }}>→</span>
                      )}
                    </div>
                  ))}
                </div>

                {/* 匹配规则提示 */}
                <div style={{
                  marginTop: '16px',
                  padding: '10px',
                  background: '#252535',
                  borderRadius: '6px',
                  fontSize: '11px',
                  color: '#888'
                }}>
                  <strong style={{ color: '#aaa' }}>自动匹配规则：</strong>
                  <span style={{ marginLeft: '8px' }}>
                    {plugin.id === 'fullstack-dev' && '项目包含 shadcn、radix、tailwind、sqlite、需求文档、技术方案等关键词'}
                    {plugin.id === 'paper-writing' && '项目包含 paper、thesis、论文、.tex、.bib 等关键词'}
                    {plugin.id === 'app-dev' && '项目包含 package.json、react、vue、flutter 等关键词'}
                    {plugin.id === 'data-analysis' && '项目包含 jupyter、pandas、tensorflow、机器学习等关键词'}
                    {plugin.id === 'deployment' && '项目包含 docker、kubernetes、nginx、部署等关键词'}
                    {plugin.id === 'code-review' && '项目包含 code review、PR review、审查、git diff 等关键词'}
                    {plugin.id === 'refactoring' && '项目包含 refactor、重构、优化、simplify、性能等关键词'}
                    {plugin.id === 'bug-fix' && '项目包含 bug、fix、修复、debug、调试、排查等关键词'}
                    {plugin.id === 'scientific-research' && '项目包含 bioinformatics、genomics、chemistry、rdkit、biopython 等关键词'}
                    {plugin.id === 'tdd-development' && '项目包含 tdd、test driven、jest、mocha、pytest、unit test 等关键词'}
                    {plugin.id === 'frontend-design' && '项目包含 ui design、figma、tailwind、styled-component、responsive 等关键词'}
                    {plugin.id === 'api-integration' && '项目包含 rest api、graphql、mcp server、swagger、oauth、jwt 等关键词'}
                    {plugin.id === 'security-audit' && '项目包含 security audit、penetration test、nmap、burp、owasp 等关键词'}
                    {plugin.id === 'document-processing' && '项目包含 docx、xlsx、pptx、pdf、python-docx、pandoc 等关键词'}
                    {plugin.id === 'plan-execution' && '项目包含 plan execution、brainstorm、task breakdown、spec workflow 等关键词'}
                    {plugin.id === 'default' && '当没有其他插件匹配时使用此默认策略'}
                  </span>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {/* 使用说明 */}
      <div style={{
        marginTop: '24px',
        padding: '16px',
        background: '#1a1a2e',
        borderRadius: '8px',
        border: '1px solid #333'
      }}>
        <h4 style={{ margin: '0 0 12px 0', fontSize: '14px', color: '#fff' }}>
          使用说明
        </h4>
        <ul style={{
          margin: 0,
          padding: '0 0 0 20px',
          fontSize: '12px',
          color: '#888',
          lineHeight: '1.8'
        }}>
          <li><strong>自动检测</strong>：创建会话时选择"自动检测"，系统会根据项目特征自动选择合适的插件</li>
          <li><strong>手动选择</strong>：创建会话时可以手动指定使用哪个监控策略</li>
          <li><strong>阶段感知</strong>：每个插件会根据终端内容自动识别当前开发阶段</li>
          <li><strong>专业指令</strong>：不同阶段有不同的监控配置和自动操作建议</li>
          <li><strong>查看状态</strong>：在右侧 AI 监控面板可以看到当前使用的插件和阶段</li>
        </ul>
      </div>
    </div>
  );
}

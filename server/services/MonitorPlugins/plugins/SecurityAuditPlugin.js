import DeclarativePlugin from '../DeclarativePlugin.js';

/**
 * 安全审计监控策略插件
 * 针对安全测试、渗透测试、漏洞扫描等场景
 *
 * 骨架统一在 DeclarativePlugin，这里只声明数据（原实现逐字等价）。
 */
const definition = {
  id: 'security-audit',
  name: '安全审计',
  description: '安全审计监控策略，支持信息收集、漏洞扫描、漏洞验证、报告编写、修复建议等阶段',
  version: '2.0.0',

  projectPatterns: [
    /security.*audit|安全审计/i,
    /penetration.*test|渗透测试|pentest/i,
    /vulnerability|漏洞|exploit/i,
    /ctf|capture.*flag/i,
    /nmap|burp|sqlmap|metasploit/i,
    /owasp|xss|sql.*injection|csrf/i,
    /security.*scan|安全扫描/i
  ],

  phases: [
    { id: 'recon', name: '信息收集', priority: 1 },
    { id: 'scanning', name: '漏洞扫描', priority: 2 },
    { id: 'validation', name: '漏洞验证', priority: 3 },
    { id: 'reporting', name: '报告编写', priority: 4 },
    { id: 'remediation', name: '修复建议', priority: 5 }
  ],

  // 按顺序匹配，命中即返回（顺序与原 detectPhase 的 if 链一致）
  phaseRules: [
    { phase: 'remediation', any: /remediation|修复|fix|patch|mitigation|缓解/i },
    { phase: 'reporting', any: /report|报告|document|记录|finding|发现/i },
    { phase: 'validation', any: /exploit|利用|poc|proof.*of.*concept|验证|confirm/i },
    { phase: 'scanning', any: /scan|扫描|nmap|nikto|sqlmap|burp|vulnerability/i },
  ],
  defaultPhase: 'recon',

  phaseConfigs: {
    recon: {
      autoActions: ['继续', '收集信息', '枚举服务'],
      checkpoints: [
        '是否收集了目标信息',
        '是否枚举了开放端口',
        '是否识别了服务版本'
      ],
      autoActionEnabled: true,
      idleTimeout: 45000
    },

    scanning: {
      autoActions: ['继续', '扫描漏洞', '分析结果'],
      checkpoints: [
        '是否完成漏洞扫描',
        '是否分析了扫描结果',
        '是否标记了高危漏洞'
      ],
      warningPatterns: [/critical|high|严重|高危/i],
      autoActionEnabled: true,
      idleTimeout: 60000
    },

    validation: {
      autoActions: ['继续', '验证漏洞', '记录证据'],
      checkpoints: [
        '漏洞是否可利用',
        '是否记录了利用过程',
        '是否评估了影响范围'
      ],
      warningPatterns: [/success|pwned|shell|access.*granted/i],
      autoActionEnabled: false,
      requireConfirmation: true,
      idleTimeout: 60000
    },

    reporting: {
      autoActions: ['继续', '编写报告', '整理发现'],
      checkpoints: [
        '报告是否完整',
        '漏洞描述是否清晰',
        '是否有复现步骤'
      ],
      autoActionEnabled: true,
      idleTimeout: 30000
    },

    remediation: {
      autoActions: ['继续', '提供建议', '验证修复'],
      checkpoints: [
        '修复建议是否可行',
        '是否有临时缓解措施',
        '是否验证了修复效果'
      ],
      autoActionEnabled: true,
      idleTimeout: 30000
    }
  },

  completePattern: /audit.*complete|审计完成|report.*done|报告完成/i,
  completeMessage: '安全审计完成',
  onWarning: {
    needsAction: true,
    actionType: 'warning',
    suggestedAction: '发现潜在漏洞，建议记录',
  },
  idlePrefix: '安全审计'
};

class SecurityAuditPlugin extends DeclarativePlugin {
  constructor() {
    super(definition);
  }
}

export default SecurityAuditPlugin;
